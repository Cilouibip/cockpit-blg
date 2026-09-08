import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { Client } from 'pg';
import { makeRevision } from '../src/lib/links';

const base = process.env.TEST_DATABASE_URL || 'postgresql://localhost:55440/postgres';
const address = new URL(base);
if (!['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)) throw new Error('LOCAL_DATABASE_TESTS_ONLY');
const name = 'cockpit_rollup_' + Date.now() + '_' + randomUUID().slice(0, 8);
const admin = new Client({ connectionString: base });
const target = new URL(base); target.pathname = '/' + name;
let db: Client;
before(async () => {
  await admin.connect();
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$");
  await admin.query(`CREATE DATABASE ${name}`);
  db = new Client({ connectionString: target.href }); await db.connect();
  for (const file of fs.readdirSync('supabase/migrations').filter(f => /^\d{3}_.*\.sql$/.test(f)).sort()) {
    await db.query(fs.readFileSync('supabase/migrations/' + file, 'utf8'));
  }
});
after(async () => { await db?.end(); await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.end(); });
beforeEach(async () => { await db.query('BEGIN'); });
afterEach(async () => { await db.query('ROLLBACK'); });
async function fails(fn: () => Promise<unknown>, code: string) {
  await db.query('SAVEPOINT expected_failure');
  try { await assert.rejects(fn, (e: unknown) => (e as { code: string }).code === code); }
  finally { await db.query('ROLLBACK TO SAVEPOINT expected_failure'); await db.query('RELEASE SAVEPOINT expected_failure'); }
}
async function rollup(source = 'all', tunnel = 'all', campaign = '', from = '2026-03-29', to = '2026-03-30') {
  return (await db.query('SELECT cockpit_dashboard_rollup($1,$2,$3,$4,$5) AS result', [from, to, source, tunnel, campaign])).rows[0].result;
}
type EventInput = { name?: string; at?: string; namespace?: string; journey?: string | null; session?: string | null; anonymous?: string | null; tunnel?: string; link?: string | null; properties?: unknown; canonical?: string };
async function event(value: EventInput = {}) {
  return db.query(`INSERT INTO events(source,source_namespace,external_id,event_name,schema_version,occurred_at,visitor_namespace,
    anonymous_id,session_id,journey_id,tunnel,page_version,link_revision_id,trust_level,properties,payload_hash,canonical_origin,canonical_event_id)
    VALUES('first_party',$1,$2,$3,1,$4,$1,$5,$6,$7,$8,'test-v1',$9,'browser_observed',$10,'synthetic',$11,$12)`, [
    value.namespace || 'browser-one', randomUUID(), value.name || 'landing_arrival', value.at || '2026-03-29T12:00:00Z',
    value.anonymous === undefined ? randomUUID() : value.anonymous,
    value.session === undefined ? randomUUID() : value.session,
    value.journey === undefined ? randomUUID() : value.journey,
    value.tunnel || 'quiz', value.link || null, JSON.stringify(value.properties || {}), value.canonical ? 'synthetic-origin' : null, value.canonical || null,
  ]);
}
async function revision(placement: 'meta_ad' | 'instagram_bio', campaign = 'Campaign A', destination: 'quiz' | 'masterclass' = 'quiz') {
  const r = makeRevision({ placement, campaign, destination, label: 'Synthetic' });
  await db.query('SELECT save_tracked_link($1,$2,0)', [r.link_id, JSON.stringify(r)]); return r;
}
async function sync(source = 'wix', namespace = 'cash-one', stream = 'payments_and_refunds', status = 'complete', profile = 'synthetic-v1') {
  return (await db.query(`INSERT INTO sync_runs(source,source_namespace,stream_key,query_profile_key,partition_key,job_key,connector_version,
    period_from,period_to,covered_from,covered_to,date_from,date_to,coverage_kind,status,pagination_complete,finished_at,rows_rejected)
    VALUES($1,$2,$3,$4,'test',$5,'synthetic-v1','2026-03-28T23:00:00Z','2026-03-29T22:00:00Z',
      '2026-03-28T23:00:00Z','2026-03-29T22:00:00Z','2026-03-29','2026-03-30','aggregate_period',$6,$7,now(),0) RETURNING id`,
  [source, namespace, stream, profile, randomUUID(), status, status === 'complete' || status === 'empty'])).rows[0].id as string;
}
async function payment(kind = 'receipt', amount = 10000, original: string | null = null, overrides: { at?: string; currency?: string; namespace?: string } = {}) {
  return (await db.query(`INSERT INTO payments(source,source_namespace,external_id,kind,status,effective_at,gross_minor,currency,currency_exponent,
    tax_basis,source_locator,reconciliation_state,original_payment_id,connector_version)
    VALUES('wix',$1,$2,$3,'settled',$4,$5,$6,2,'tax_inclusive','synthetic','reconciled',$7,'test') RETURNING id`,
  [overrides.namespace || 'cash-one', randomUUID(), kind, overrides.at || '2026-03-29T12:00:00Z', amount, overrides.currency || 'EUR', original])).rows[0].id as string;
}
async function meta(spend = 4000, status = 'complete', namespace = 'meta-one', creative: string | null = 'creative-one') {
  const run = await sync('meta', namespace, 'ad_daily', status, 'v23.0-ad-day-none');
  const ad = (await db.query("INSERT INTO ads(source,source_namespace,external_id,campaign_id,creative_id,connector_version) VALUES('meta',$1,$2,'campaign-one',$3,'test') RETURNING id,external_id", [namespace, randomUUID(), creative])).rows[0];
  await db.query(`INSERT INTO ad_daily(ad_id,sync_run_id,date,timezone,currency,currency_exponent,spend_minor,impressions,outbound_clicks,row_state,campaign_id)
    VALUES($1,$2,'2026-03-29','Europe/Paris','EUR',2,$3,1000,20,'complete','campaign-one')`, [ad.id, run, spend]);
  return { run, ad: ad.id as string, external: ad.external_id as string };
}

test('Service-only RPC preserves client restrictions and rejects invalid reporting periods', async () => {
  for (const role of ['anon', 'authenticated']) await fails(async () => { await db.query('SET LOCAL ROLE ' + role); await rollup(); }, '42501');
  await fails(() => rollup('all', 'all', '', '2026-03-30', '2026-03-30'), '22023');
  await fails(() => rollup('invalid'), '22023');
  await db.query('SET LOCAL ROLE service_role'); const result = await rollup();
  assert.equal(result.events.count, 0); assert.equal(result.finance.compatible, false); assert.equal(result.meta.spendMinor, null);
});

test('More than 10000 events remain exact with Paris DST boundaries and exclusive end', async () => {
  const paid = await revision('meta_ad');
  await db.query(`INSERT INTO events(source,source_namespace,external_id,event_name,schema_version,occurred_at,visitor_namespace,
    anonymous_id,session_id,journey_id,tunnel,page_version,trust_level,properties,payload_hash,link_revision_id)
    SELECT 'first_party','synthetic-bulk',n::text,'landing_arrival',1,'2026-03-29T12:00:00Z','synthetic-bulk',
      md5('a'||n)::uuid,md5('s'||n)::uuid,md5('j'||n)::uuid,'quiz','test','browser_observed','{}','synthetic',CASE WHEN n>10000 THEN $1::uuid ELSE NULL END
    FROM generate_series(1,10050) n`, [paid.id]);
  await event({ at: '2026-03-28T23:00:00Z' });
  await event({ at: '2026-03-29T22:00:00Z' });
  await event({ at: '2026-03-28T22:59:59Z' });
  const result = await rollup();
  assert.equal(result.events.count, 10051); assert.equal(result.events.arrivals, 10051);
  assert.equal(result.events.steps.find((s: { event_name: string }) => s.event_name === 'landing_arrival').value, 10051);
  assert.ok(JSON.stringify(result).length < 6000, 'No business/event list should be returned');
  const filtered = await rollup('paid', 'quiz', 'link:Campaign A');
  assert.equal(filtered.events.count, 50, 'Matching records after the former 10000 boundary must still count');
  assert.equal(filtered.events.arrivals, 50);
});

test('Canonical events deduplicate source retries and namespace distinct sessions and attempts', async () => {
  const session = randomUUID(), journey = randomUUID();
  await event({ session, journey, canonical: 'same-canonical' });
  await event({ session, journey, canonical: 'same-canonical', namespace: 'export-copy' });
  await event({ session, journey, namespace: 'browser-two' });
  await event({ session: null, journey: null });
  const result = await rollup();
  assert.equal(result.events.count, 3); assert.equal(result.events.arrivals, 2);
  assert.equal(result.events.steps[0].value, 2);
});

test('Lead people deduplicate across tunnels; link filters do not fabricate Meta attribution', async () => {
  const paid = await revision('meta_ad'), organic = await revision('instagram_bio');
  const person = (await db.query("INSERT INTO people DEFAULT VALUES RETURNING id")).rows[0].id;
  for (const [tunnel, link, identity] of [['quiz', paid.id, person], ['masterclass', organic.id, person], ['quiz', paid.id, null]]) {
    await db.query(`INSERT INTO lead_registrations(source,source_namespace,external_id,person_id,tunnel,registered_at,link_revision_id,evidence_state,source_locator,payload_hash)
      VALUES('first_party','leads',$1,$2,$3,'2026-03-29T12:00:00Z',$4,$5,'synthetic','synthetic')`, [randomUUID(), identity, tunnel, link, identity ? 'backend_verified' : 'unresolved']);
  }
  await event({ link: paid.id }); await event({ link: organic.id, tunnel: 'masterclass' });
  const all = await rollup(); assert.equal(all.leads.registrations, 3); assert.equal(all.leads.unique, 1); assert.equal(all.leads.unresolved, 1);
  assert.deepEqual(all.leads.byTunnel.map((r: { tunnel: string; count: number }) => [r.tunnel, r.count]), [['masterclass', 1], ['quiz', 2]]);
  const filtered = await rollup('paid', 'quiz', 'link:Campaign A');
  assert.equal(filtered.leads.registrations, 2); assert.equal(filtered.events.count, 1);
  const meta = await rollup('paid', 'all', 'meta:campaign-one');
  assert.equal(meta.leads.assignable, false); assert.equal(meta.leads.registrations, 0); assert.equal(meta.events.assignable, false);
});

test('Question answers count only a view of the same question and attempt within the selected period', async () => {
  const journey = randomUUID();
  await event({ name: 'quiz_question_viewed', journey, properties: { question_number: 1 } });
  await event({ name: 'quiz_question_answered', journey, properties: { question_number: 1 } });
  await event({ name: 'quiz_question_answered', journey, properties: { question_number: 1 } });
  await event({ name: 'quiz_question_answered', journey, namespace: 'other-browser', properties: { question_number: 1 } });
  await event({ name: 'quiz_question_answered', properties: { question_number: 1 } });
  await event({ name: 'quiz_question_viewed', journey, at: '2026-03-28T12:00:00Z', properties: { question_number: 2 } });
  await event({ name: 'quiz_question_answered', journey, properties: { question_number: 2 } });
  const result = await rollup();
  assert.deepEqual(result.events.questions[0], { q: 1, views: 1, answers: 1 });
  assert.deepEqual(result.events.questions[1], { q: 2, views: 0, answers: 0 });
});

test('Video union avoids replay and seek inflation, isolates version, duration and visitor namespace', async () => {
  const anonymous = randomUUID();
  const watch = (intervals: { start: number; end: number }[], version = 'v1', namespace = 'browser-one') => event({
    name: 'video_watch', tunnel: 'masterclass', anonymous, namespace,
    properties: { video_id: 'video', video_version: version, duration: 100, playback_id: randomUUID(), intervals },
  });
  await watch([{ start: 0, end: 30 }]);
  await watch([{ start: 20, end: 50 }, { start: 90, end: 100 }]);
  await watch([{ start: 0, end: 30 }]); // Replay: total remains 60 seconds.
  await watch([{ start: 0, end: 20 }], 'v1', 'another-browser');
  await watch([{ start: 0, end: 20 }], 'v2');
  const result = await rollup();
  const v1 = result.events.videos.filter((r: { version: string }) => r.version === 'v1');
  assert.deepEqual(v1.map((r: { threshold: number; viewers: number; reached: number }) => [r.threshold, r.viewers, r.reached]), [[.25, 2, 1], [.5, 2, 1], [.75, 2, 0], [.95, 2, 0]]);
  const v2 = result.events.videos.filter((r: { version: string }) => r.version === 'v2'); assert.equal(v2[0].viewers, 1); assert.equal(v2[0].reached, 0);
});

test('Cash and refunds use Paris effective day, exact authority and complete refund coverage', async () => {
  const receipt = await payment('receipt', 10000, null, { at: '2026-03-28T23:30:00Z' });
  await payment('refund', 2500, receipt); await payment('receipt', 999, null, { at: '2026-03-29T22:00:00Z' });
  let result = await rollup();
  assert.equal(result.finance.transactionCount, 2); assert.equal(result.finance.compatible, true); assert.equal(result.finance.coverageComplete, false);
  assert.deepEqual(result.finance.daily, [{ date: '2026-03-29', netMinor: 7500 }]);
  const run = await sync(); result = await rollup();
  assert.equal(result.finance.coverageComplete, true); assert.equal(result.finance.grossMinor, 10000); assert.equal(result.finance.refundMinor, 2500);
  await db.query("UPDATE sync_runs SET covered_to='2026-03-29T12:00:00Z' WHERE id=$1", [run]);
  assert.equal((await rollup()).finance.coverageComplete, false);
  await payment('receipt', 100, null, { namespace: 'cash-other' }); result = await rollup();
  assert.equal(result.finance.authorityCount, 2); assert.equal(result.finance.compatible, false); assert.equal(result.finance.grossMinor, null);
});

test('Mismatched currency, precision or reconciliation never become an EUR cash sum', async () => {
  const id = await payment();
  for (const [field, value] of [['currency', 'USD'], ['currency_exponent', 0], ['tax_basis', 'tax_exclusive'], ['reconciliation_state', 'unresolved']] as const) {
    await db.query('SAVEPOINT invalid_unit'); await db.query(`UPDATE payments SET ${field}=$1 WHERE id=$2`, [value, id]);
    const result = await rollup(); assert.equal(result.finance.compatible, false); assert.equal(result.finance.grossMinor, null);
    await db.query('ROLLBACK TO SAVEPOINT invalid_unit'); await db.query('RELEASE SAVEPOINT invalid_unit');
  }
});

test('Only a complete exact aggregate with one reporting authority can replace transaction detail', async () => {
  const run = await sync('wix', 'aggregate-one', 'aggregates');
  const insert = (profile = 'aggregate-profile') => db.query(`INSERT INTO source_aggregates(source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id,
    timezone,coverage_state,value,unit,currency,currency_exponent,tax_basis,dimensions,definition_version,source_locator)
    VALUES('wix','aggregate-one','net_cash','2026-03-28T23:00:00Z','2026-03-29T22:00:00Z','all',$1,$2,'Europe/Paris','complete',7500,'minor','EUR',2,'tax_inclusive','{}','net-ttc-v1','synthetic')`, [profile, run]);
  await insert(); assert.equal((await rollup()).aggregate.valueMinor, 7500);
  await insert('competing-profile'); assert.equal((await rollup()).aggregate, null);
  await db.query("DELETE FROM source_aggregates WHERE report_profile_key='competing-profile'");
  await db.query("UPDATE source_aggregates SET unit='eur'"); assert.equal((await rollup()).aggregate, null);
});

test('Appointments require stable bookings and proof; commitments remain distinct from receipts', async () => {
  const appointment = (basis: string, status: string, proof: boolean) => db.query(`INSERT INTO appointments(source,source_namespace,external_id,identity_basis,status,scheduled_at,attended_at,attendance_evidence,connector_version)
    VALUES('notion','commercial',$1,$2,$3,'2026-03-29T12:00:00Z',$4,$5,'test')`, [randomUUID(), basis, status, proof ? '2026-03-29T12:00:00Z' : null, proof ? 'source proof' : null]);
  await appointment('stable_booking', 'attended', true); await appointment('stable_booking', 'attended', false);
  await appointment('stable_booking', 'no_show', false); await appointment('notion_current_slot', 'unknown', false);
  const id = (await db.query("INSERT INTO deals(source,source_namespace,external_id,signed_at,status,contracted_minor,currency,currency_exponent,tax_basis,source_locator,connector_version) VALUES('notion','deals',$1,'2026-03-29T12:00:00Z','signed',300000,'EUR',2,'tax_inclusive','signed contract','test') RETURNING id", [randomUUID()])).rows[0].id;
  let result = await rollup();
  assert.equal(result.appointments.total, 3); assert.equal(result.appointments.attended, 1); assert.equal(result.appointments.noShow, 1); assert.equal(result.appointments.unknown, 1);
  assert.equal(result.deals.contractedMinor, 300000); assert.equal(result.finance.transactionCount, 0);
  await db.query("UPDATE deals SET source_locator='' WHERE id=$1", [id]); result = await rollup(); assert.equal(result.deals.compatible, false); assert.equal(result.deals.contractedMinor, null);
});

test('Meta accepts only canonical complete compatible rows and justified campaign/ad/creative filters', async () => {
  const one = await meta();
  let result = await rollup('paid', 'all', 'meta:campaign-one'); assert.equal(result.meta.spendMinor, 4000); assert.equal(result.meta.outboundClicks, 20);
  assert.equal((await rollup('paid', 'all', 'meta-ad:' + one.external)).meta.spendMinor, 4000);
  assert.equal((await rollup('paid', 'all', 'meta-creative:creative-one')).meta.spendMinor, 4000);
  assert.equal((await rollup('paid', 'quiz', 'meta:campaign-one')).meta.compatible, false);
  assert.equal((await rollup('organic')).meta.compatible, false);
  await db.query("UPDATE ad_daily SET currency_exponent=0 WHERE ad_id=$1", [one.ad]); result = await rollup(); assert.equal(result.meta.compatible, false); assert.equal(result.meta.spendMinor, null);
  await db.query("UPDATE ad_daily SET currency_exponent=2 WHERE ad_id=$1", [one.ad]);
  await db.query("UPDATE sync_runs SET query_profile_key='v23.0-ad-day-filtered' WHERE id=$1", [one.run]); assert.equal((await rollup()).meta.compatible, false);
});

test('Partial Meta runs never become published zero and missing creative metadata stays unavailable', async () => {
  const partial = await meta(4000, 'partial');
  let result = await rollup(); assert.equal(result.meta.rows, 0); assert.equal(result.meta.spendMinor, null);
  await db.query("UPDATE sync_runs SET status='complete',pagination_complete=true WHERE id=$1", [partial.run]);
  await db.query("INSERT INTO ads(source,source_namespace,external_id,campaign_id,creative_id,connector_version) VALUES('meta','meta-one',$1,'campaign-one',NULL,'test')", [randomUUID()]);
  result = await rollup('paid', 'all', 'meta-creative:creative-one'); assert.equal(result.meta.compatible, false); assert.equal(result.meta.spendMinor, null);
});

test('An explicit zero Meta measurement remains distinct from an empty canonical synchronization', async () => {
  const zero = await meta(0);
  let result = await rollup(); assert.equal(result.meta.compatible, true); assert.equal(result.meta.spendMinor, 0);
  const empty = await sync('meta', 'meta-one', 'ad_daily', 'empty', 'v23.0-ad-day-none');
  await db.query("UPDATE sync_runs SET source_as_of=(SELECT source_as_of+interval '1 second' FROM sync_runs WHERE id=$1) WHERE id=$2", [zero.run, empty]);
  result = await rollup(); assert.equal(result.meta.rows, 0); assert.equal(result.meta.compatible, false); assert.equal(result.meta.spendMinor, null);
});
