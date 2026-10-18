import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const enabled = process.env.BLG_SQL_PLAN_TEST === '1';
const base = new URL(process.env.TEST_DATABASE_URL || 'postgresql://localhost:55440/postgres');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw Error('LOCAL_SQL_TESTS_ONLY');
const name = 'read_projection_' + Date.now(), target = new URL(base); target.pathname = '/' + name;
const admin = new Client({ connectionString: base.href });
let db: Client;
let replayPreservedDefinitions = false;
const functions = ['cockpit_business_rollup', 'cockpit_lead_entry_rollup_v2', 'cockpit_source_window'];
before(async () => {
  if (!enabled) return;
  await admin.connect(); await admin.query(`CREATE DATABASE ${name}`);
  db = new Client({ connectionString: target.href }); await db.connect();
  // This database is disposable and local. Install baseline only, independently
  // of migrations that another test or deployment has already applied elsewhere.
  for (const file of fs.readdirSync('supabase/migrations').filter(file => file.endsWith('.sql') && Number(file.slice(0, 3)) < 29).sort()) {
    await db.query(fs.readFileSync('supabase/migrations/' + file, 'utf8'));
  }
  for (const fn of functions) {
    const definition = (await db.query('SELECT pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace=\'public\'::regnamespace AND proname=$1', [fn])).rows[0].definition as string;
    await db.query(definition.replace('FUNCTION public.' + fn + '(', 'FUNCTION public.' + fn + '_before029('));
  }
  const candidate = fs.readFileSync('supabase/migrations/029_dashboard_read_projections.sql', 'utf8');
  await db.query(candidate);
  const definitions = async () => (await db.query("SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1) ORDER BY proname", [functions])).rows;
  const once = await definitions();
  await db.query(candidate);
  replayPreservedDefinitions = JSON.stringify(once) === JSON.stringify(await definitions());
});
after(async () => { if (!enabled) return; await db?.end(); await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.end(); });
beforeEach(async () => { if (enabled) await db.query('BEGIN'); });
afterEach(async () => { if (enabled) await db.query('ROLLBACK'); });
const sqlTest = (title: string, run: () => Promise<void>) => test(title, { skip: !enabled }, run);
const from = '2026-10-01', to = '2026-10-19';
async function run(source: string, stream: string, namespace: string, finished = '2026-10-19T10:00:00Z', profile = 'synthetic-v1', status = 'complete') {
  const id = randomUUID();
  await db.query("INSERT INTO sync_runs(id,source,source_namespace,stream_key,query_profile_key,partition_key,job_key,connector_version,coverage_kind,period_from,period_to,source_as_of,started_at,finished_at,status,pagination_complete,covered_from,covered_to,checkpoint) VALUES($1::uuid,$2,$3,$4,$5,$1::text,$1::text,'synthetic','source_snapshot','2026-09-30T22:00Z','2026-10-18T22:00Z',$6,$6,$6,$7,true,'2026-09-30T22:00Z','2026-10-18T22:00Z',$8)", [id, source, namespace, stream, profile, finished, status, JSON.stringify({ counts: { read: 7 }, padding: 'x'.repeat(200_000) })]);
  return id;
}
async function compare(fn: string, args: unknown[]) {
  const placeholders = args.map((_, i) => '$' + (i + 1)).join(',');
  const result = (await db.query(`SELECT public.${fn}_before029(${placeholders}) AS before, public.${fn}(${placeholders}) AS after`, args)).rows[0];
  // The SQL API never promised aggregate array order (jsonb_agg without ORDER BY).
  // Preserve all returned rows and fields while comparing that array as a set.
  const normalize = (value: any) => {
    if (Array.isArray(value?.aggregates)) value.aggregates.sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
    return value;
  };
  assert.deepEqual(normalize(result.after), normalize(result.before));
  return result.after;
}
async function prospect(id: string | null, external: string, syncRun: string, business: object, archived = false, namespace = 'crm') {
  await db.query("INSERT INTO prospects(source,source_namespace,external_id,person_id,source_updated_at,connector_version,mapping_version,business,archived,sync_run_id,source_status) VALUES('notion',$1,$2,$3,now(),'synthetic','synthetic',$4,$5,$6,'Closé')", [namespace, external, id, JSON.stringify(business), archived, syncRun]);
}
sqlTest('business rollup stays identical across current, archived, undated, unknown and foreign namespaces', async () => {
  const old = await run('notion', 'prospects_business', 'crm', '2026-10-18T10:00:00Z');
  const current = await run('notion', 'prospects_business', 'crm');
  const person = randomUUID(); await db.query('INSERT INTO people(id) VALUES($1)', [person]);
  await prospect(person, 'attended', current, { acquisitionDay: '2026-10-02', scheduledDay: '2026-10-03', attendance: 'show_up', explicitFinished: true, bookedDay: '2026-10-01', closedDay: '2026-10-03' });
  await prospect(null, 'unresolved-archived', old, { acquisitionDay: '2026-10-05' }, true);
  await prospect(person, 'creation-only', current, { createdAt: '2026-10-04T10:00Z', scheduledDay: '2026-10-04', attendance: 'no_show' });
  await prospect(person, 'retained-incremental', old, { acquisitionDay: '2025-01-01', scheduledDay: '2026-10-06', attendance: 'show_up' });
  const previousProfile = await run('notion', 'prospects_business', 'crm', '2026-10-17T10:00:00Z', 'old-profile');
  await prospect(person, 'obsolete-profile', previousProfile, { acquisitionDay: '2025-01-01', scheduledDay: '2026-10-07', attendance: 'show_up' });
  await db.query("UPDATE sync_runs SET source_as_of='2026-10-18T09:00Z',checkpoint=jsonb_set(checkpoint,'{inventoryThrough}',to_jsonb('2026-10-17T00:00:00Z'::text)) WHERE id=$1", [current]);
  await prospect(person, 'foreign', current, { acquisitionDay: '2026-10-03', attendance: 'show_up' }, false, 'other-crm');
  for (const bounds of [[from, to], ['2026-09-01', from], ['2027-01-01', '2027-01-02']]) {
    const result = await compare('cockpit_business_rollup', ['crm', ...bounds]);
    if (bounds[0] === from) { assert.equal(result.leads.rows, 2); assert.equal(result.leads.archivedRows, 1); assert.equal(result.appointments.attended, 2); assert.equal(result.sourceRows, 3); assert.equal(new Date(result.observedAt).toISOString(), '2026-10-18T09:00:00.000Z'); assert.equal(new Date(result.publishedAt).toISOString(), '2026-10-19T10:00:00.000Z'); assert.equal(result.inventoryThrough, '2026-10-17T00:00:00Z'); }
  }
  await compare('cockpit_business_rollup', ['missing-crm', from, to]);
});
async function observation(runId: string, family: string, person: string | null, external: string, day: string, eligible = true, namespace = family === 'client_history' ? 'clients' : 'site', properties: object = {}) {
  await db.query("INSERT INTO lead_source_observations(run_id,source,source_namespace,family,external_id,occurred_at,occurred_day,source_updated_at,source_container_id,identity_key,person_id,identity_state,eligible,properties,payload_hash,source_payload_hash,mapping_profile,published_at,is_current) VALUES($1,$2,$3,$4,$5,$6::date::timestamp AT TIME ZONE 'Europe/Paris',$6,now(),$7,$8,$9,$10,$11,$12,$13,$13,'synthetic-v1',now(),true)", [runId, family === 'client_history' ? 'notion' : 'wix', namespace, family, external, day, family + '-included', 'b'.repeat(64), person, person ? 'linked' : 'unresolved', eligible, JSON.stringify(properties), 'a'.repeat(64)]);
}
sqlTest('lead rollup preserves published family counts, profiles, history, unknown identities and filters', async () => {
  const form = await run('wix', 'lead_entries_forms', 'site');
  const quiz = await run('wix', 'lead_entries_quiz', 'site');
  const client = await run('notion', 'lead_entries_client_history', 'clients');
  const foreign = await run('wix', 'lead_entries_forms', 'foreign');
  const first = randomUUID(), next = randomUUID(); await db.query('INSERT INTO people(id) SELECT unnest($1::uuid[])', [[first, next]]);
  await observation(form, 'forms', first, 'old', '2025-01-01');
  await observation(form, 'forms', first, 'repeat', '2026-10-02');
  await observation(quiz, 'quiz', next, 'new', '2026-10-03');
  await observation(form, 'forms', null, 'unknown', '2026-10-04');
  await observation(form, 'forms', null, 'excluded', '2026-10-04', false);
  await observation(client, 'client_history', first, 'prior-client', '2024-01-01');
  await observation(foreign, 'forms', next, 'foreign', '2026-10-03', true, 'foreign');
  const scope = { forms: { profile: 'synthetic-v1', containerIds: ['forms-included'] }, quiz: { profile: 'synthetic-v1', containerIds: ['quiz-included'] }, client_history: { profile: 'synthetic-v1', containerIds: ['client_history-included'] } };
  const result = await compare('cockpit_lead_entry_rollup_v2', ['site', 'crm', 'clients', from, to, JSON.stringify(scope)]);
  assert.equal(result.firstKnownAcquisitions, 1); assert.equal(result.unresolvedDatedRequests, 1); assert.equal(result.excludedSourceRequests, 1);
  assert.equal(result.families.length, 3); assert.ok(result.families.every((family: any) => family.counts.read === 7));
  await compare('cockpit_lead_entry_rollup_v2', ['site', 'crm', 'clients', from, to, JSON.stringify({ ...scope, forms: { ...scope.forms, profile: 'new-requested-profile' } })]);
  await compare('cockpit_lead_entry_rollup_v2', ['missing-site', 'crm', 'clients', '2027-01-01', '2027-01-02', JSON.stringify(scope)]);
});
async function aggregate(runId: string, metric: string, value: number, unit = 'count') {
  await db.query("INSERT INTO source_aggregates(source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id,timezone,coverage_state,value,unit,dimensions,definition_version,source_locator) VALUES('posthog','project',$1,'2026-09-30T22:00Z','2026-10-18T22:00Z','all','synthetic-v1',$2,'Europe/Paris','complete',$3,$4,'{}','synthetic-v1','synthetic')", [metric, runId, value, unit]);
}
const sourceArgs = () => ['posthog', 'project', 'quiz_observations', 'synthetic-v1', from, to, 'Europe/Paris', null, null, 'exact_report'];
sqlTest('exact report fence preserves valid fallback, rejected candidates, real empty and absent scope', async () => {
  const valid = await run('posthog', 'quiz_observations', 'project', '2026-10-19T10:00:00Z');
  await aggregate(valid, 'posthog_events', 10); await aggregate(valid, 'posthog_visitors', 7);
  const invalid = await run('posthog', 'quiz_observations', 'project', '2026-10-19T11:00:00Z'); await aggregate(invalid, 'posthog_events', 9, 'minor');
  let result = await compare('cockpit_source_window', sourceArgs()); assert.equal(result.exactRunId, valid); assert.equal(result.latestAttempt.id, invalid);
  const empty = await run('posthog', 'quiz_observations', 'project', '2026-10-19T12:00:00Z', 'synthetic-v1', 'empty'); await aggregate(empty, 'posthog_events', 0);
  result = await compare('cockpit_source_window', sourceArgs()); assert.equal(result.exactRunId, empty); assert.equal(result.aggregates[0].value, 0);
  const args = sourceArgs(); args[4] = '2026-10-02'; result = await compare('cockpit_source_window', args); assert.equal(result.exactRunId, null);
});
sqlTest('replacement preserves private invoker functions and rejects unbounded source requests', async () => {
  for (const fn of functions) {
    const info = (await db.query("SELECT provolatile,prosecdef,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') authenticated,has_function_privilege('service_role',oid,'execute') server FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=$1", [fn])).rows[0];
    assert.deepEqual(info, { provolatile: 's', prosecdef: false, anon: false, authenticated: false, server: true });
  }
  for (const fn of ['cockpit_source_window_before029', 'cockpit_source_window']) {
    await db.query('SAVEPOINT invalid_scope');
    await assert.rejects(db.query(`SELECT ${fn}('posthog','project','quiz_observations','synthetic-v1','2000-01-01','2030-01-01','Europe/Paris',NULL,NULL,'exact_report')`), { code: '22023' });
    await db.query('ROLLBACK TO SAVEPOINT invalid_scope');
  }
});

sqlTest('migration029 replays after an uncertain acknowledgement without duplicate registry rows or definition drift', async () => {
  assert.equal(replayPreservedDefinitions, true);
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM cockpit_migrations WHERE version=29')).rows[0].count, 1);
});

sqlTest('preflight refuses a missing function instead of recreating it with default PUBLIC rights', async () => {
  await db.query('DROP FUNCTION public.cockpit_business_rollup(text,date,date)');
  const migration = fs.readFileSync('supabase/migrations/029_dashboard_read_projections.sql', 'utf8');
  const preflight = migration.match(/DO \$read_model_preflight\$[\s\S]*?\$read_model_preflight\$;/)![0];
  await assert.rejects(db.query(preflight), (error: any) => error.code === '55000' && /READ_MODEL_SIGNATURE_MISSING/.test(error.message));
});
sqlTest('preflight refuses an unexpected body even when its SQL result would be unchanged', async () => {
  const definition = (await db.query("SELECT pg_get_functiondef(oid) definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='cockpit_business_rollup'")).rows[0].definition as string;
  await db.query(definition.replace('AS $function$', 'AS $function$\n-- synthetic unexpected drift\n'));
  const migration = fs.readFileSync('supabase/migrations/029_dashboard_read_projections.sql', 'utf8');
  const preflight = migration.match(/DO \$read_model_preflight\$[\s\S]*?\$read_model_preflight\$;/)![0];
  await assert.rejects(db.query(preflight), (error: any) => error.code === '55000' && /READ_MODEL_BASELINE_MISMATCH/.test(error.message));
});
sqlTest('preflight refuses changed security semantics with an otherwise identical body', async () => {
  await db.query('ALTER FUNCTION public.cockpit_business_rollup(text,date,date) SECURITY DEFINER');
  const migration = fs.readFileSync('supabase/migrations/029_dashboard_read_projections.sql', 'utf8');
  const preflight = migration.match(/DO \$read_model_preflight\$[\s\S]*?\$read_model_preflight\$;/)![0];
  await assert.rejects(db.query(preflight), (error: any) => error.code === '55000' && /READ_MODEL_BASELINE_MISMATCH/.test(error.message));
});

sqlTest('preflight refuses STRICT semantics that would suppress calls with null filters', async () => {
  await db.query('ALTER FUNCTION public.cockpit_business_rollup(text,date,date) STRICT');
  const migration = fs.readFileSync('supabase/migrations/029_dashboard_read_projections.sql', 'utf8');
  const preflight = migration.match(/DO \$read_model_preflight\$[\s\S]*?\$read_model_preflight\$;/)![0];
  await assert.rejects(db.query(preflight), (error: any) => error.code === '55000' && /READ_MODEL_BASELINE_MISMATCH/.test(error.message));
});
sqlTest('preflight refuses an anonymously executable baseline before replacing any function', async () => {
  await db.query('GRANT EXECUTE ON FUNCTION public.cockpit_business_rollup(text,date,date) TO anon');
  const migration = fs.readFileSync('supabase/migrations/029_dashboard_read_projections.sql', 'utf8');
  const preflight = migration.match(/DO \$read_model_preflight\$[\s\S]*?\$read_model_preflight\$;/)![0];
  await assert.rejects(db.query(preflight), (error: any) => error.code === '55000' && /READ_MODEL_BASELINE_MISMATCH/.test(error.message));
});
