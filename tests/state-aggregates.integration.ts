import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { postgresDatabase, type Database, type Row } from '../src/lib/db';
import { syncKpiSource, readKpiSource, kpiDays, kpiStream, nextDay, pagedRows, KPI_PROFILE, type KpiSource, type KpiSourceBatch, type KpiSourceRow, type KpiStoredSource } from '../src/lib/kpi-source-store';
import { startOfParisDay } from '../src/domain/dates';
import { ConnectorError, safeConnectorError } from '../src/connectors/http';

// PostgreSQL jetable local uniquement ; données synthétiques. Flux KPI (Meta, PostHog, Wix) et rapport PostHog Masterclass.
// 1) Comparaison ancienne/nouvelle lecture : base à l'ANCIEN schéma (migrations < 018), ancien chemin d'écriture et ancien
//    lecteur (copiés à l'identique depuis 7bc6a68), puis migration 018 (reprise) et nouveau lecteur sur la même période.
// 2) Non-accumulation, flux par flux, avec le nouveau chemin.
const base = new URL(process.env.TEST_DATABASE_URL || 'postgresql://localhost:55440/postgres');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw Error('LOCAL_ONLY');
const name = 'state_aggregates_' + Date.now(), target = new URL(base);target.pathname = '/' + name;
const admin = new Client({ connectionString: base.href });let sql: Client;let pdb: Database;
const migrations = fs.readdirSync('supabase/migrations').filter(f => /^\d{3}_.*\.sql$/.test(f)).sort();
before(async () => {
  await admin.connect();await admin.query(`CREATE DATABASE ${name}`);
  sql = new Client({ connectionString: target.href });await sql.connect();
  for (const file of migrations.filter(f => Number(f.slice(0, 3)) < 18)) await sql.query(fs.readFileSync('supabase/migrations/' + file, 'utf8'));
  pdb = postgresDatabase(target.href);
});
after(async () => { await sql?.end();await new Promise(resolve => setTimeout(resolve, 5500));await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end(); });
const rpc = async <T = any>(fn: string, args: Record<string, unknown>): Promise<T> => {
  const entries = Object.entries(args);
  const result = await sql.query(`SELECT public.${fn}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) AS result`, entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value));
  return result.rows[0].result;
};
const count = async (where: string, params: unknown[] = []) => (await sql.query(`SELECT count(*)::int AS n FROM source_aggregates WHERE ${where}`, params)).rows[0].n as number;
/** Tableau de non-accumulation relevé par les scénarios (livraison U4b, section 4). */
const report: Record<string, Record<string, string>> = {};
const note = (flow: string, scenario: string, before: number, after: number, extra = '') => { (report[flow] ??= {})[scenario] = `${before} -> ${after}${extra ? ' ' + extra : ''}`; };

// ---------------------------------------------------------------------------------------------------------------
// Copie à l'identique de src/lib/kpi-source-store.ts au commit 7bc6a68 (ancien chemin d'écriture et ancien lecteur).
// PostgreSQL JSONB may reorder object keys. Integrity must depend on values, not serialization order.
function canonical(value: unknown): unknown {
 if (Array.isArray(value)) return value.map(canonical);
 if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
 return value;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
/** Only complete source responses become a publication. Earlier publications and failed attempts stay intact. */
async function legacySyncKpiSource(db: Database, source: KpiSource, namespace: string, from: string, to: string, read: () => Promise<KpiSourceBatch>) {
 const run = await db.rpc<string>('begin_sync_stream', { p_source: source, p_namespace: namespace, p_from: startOfParisDay(from), p_to: startOfParisDay(to), p_profile: KPI_PROFILE, p_stream: kpiStream(source), p_coverage_kind: 'aggregate_period', p_date_from: from, p_date_to: to });
 try {
  const batch = await read(), dates = kpiDays(from, to);
  if (batch.from !== from || batch.to !== to || !Number.isFinite(Date.parse(batch.observedAt))) throw new ConnectorError('KPI_SOURCE_SCOPE_MISMATCH');
  const keys = new Set<string>();
  for (const row of batch.rows) {
   const key = row.day + ':' + row.key;
   if (!dates.includes(row.day) || keys.has(key)) throw new ConnectorError('KPI_SOURCE_DUPLICATE_OR_SCOPE');
   keys.add(key);
  }
  const base = { source, source_namespace: namespace, report_profile_key: KPI_PROFILE, sync_run_id: run, timezone: 'Europe/Paris', coverage_state: 'partial', unit: 'count', currency: null, currency_exponent: null, tax_basis: 'unknown', definition_version: KPI_PROFILE, source_locator: `${source}:kpi-daily` };
  const rows: Row[] = [];
  for (const day of dates) {
   // Future days are never declared covered by an empty response.
   if (Date.parse(startOfParisDay(day)) >= Date.parse(batch.observedAt)) continue;
   const daily = batch.rows.filter(r => r.day === day).sort((a, b) => a.key.localeCompare(b.key));
   for (const row of daily) rows.push({ ...base, metric_key: 'kpi_daily_row', period_from: startOfParisDay(day), period_to: startOfParisDay(nextDay(day)), dimensions_key: row.key, value: 1, dimensions: row });
   rows.push({ ...base, metric_key: 'kpi_daily_manifest', period_from: startOfParisDay(day), period_to: startOfParisDay(nextDay(day)), dimensions_key: day, value: daily.length, dimensions: { day, count: daily.length, hash: digest(daily), observedAt: batch.observedAt } });
  }
  if (rows.some(row => Buffer.byteLength(JSON.stringify(row.dimensions), 'utf8') > 3800)) throw new ConnectorError('KPI_ROW_TOO_LARGE');
  for (let i = 0; i < rows.length; i += 100) await db.upsert('source_aggregates', rows.slice(i, i + 100), 'source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id');
  await db.rpc('finish_sync', { p_run: run, p_status: 'complete', p_read: batch.rows.length, p_rejected: 0, p_complete: true, p_error: null });
  return { status: 'complete', runId: run, counts: { read: batch.rows.length }, observedAt: batch.observedAt };
 } catch (error) {
  const code = safeConnectorError(error).replace(/[()]/g, '');
  await db.rpc('finish_sync', { p_run: run, p_status: 'failed', p_read: 0, p_rejected: 0, p_complete: false, p_error: code }).catch(() => undefined);
  throw error;
 }
}
/** Reads only selected periods, validates a whole day against its manifest, and never mixes run versions. */
async function legacyReadKpiSource(db: Database, source: KpiSource, namespace: string | undefined, from: string, to: string): Promise<KpiStoredSource> {
 const result: KpiStoredSource = { days: new Map(), latestAttempt: null };
 if (!namespace) return result;
 const eq = { source, source_namespace: namespace, stream_key: kpiStream(source), query_profile_key: KPI_PROFILE };
 const dates = kpiDays(from,to);
 const attempts = await db.select('sync_runs', { eq, order:'started_at,id',descending:true,limit:1 });result.latestAttempt=attempts[0]??null;
 const candidates: Row[] = [];
 // The last three complete publications covering each day suffice for corrupt-publication fallback.
 // Scan run metadata, not every historical aggregate version.
 const counts=new Map(dates.map(day=>[day,0]));
 for(let offset=0;offset<10000;offset+=1000){
  const runs=await db.select('sync_runs',{eq:{...eq,status:'complete',pagination_complete:'true',rows_rejected:'0'},lt:{period_from:startOfParisDay(to)},gte:{period_to:startOfParisDay(from)},order:'started_at,id',descending:true,from:offset,limit:1000});
  for(const run of runs){let wanted=false;for(const day of dates){if((counts.get(day)??0)<3&&Date.parse(String(run.period_from))<=Date.parse(startOfParisDay(day))&&Date.parse(String(run.period_to))>=Date.parse(startOfParisDay(nextDay(day)))){counts.set(day,counts.get(day)!+1);wanted=true;}}if(wanted)candidates.push(run);}
  if(runs.length<1000||[...counts.values()].every(n=>n>=3))break;
 }
 const manifests:Row[]=[];const dataByRun=new Map<string,Row[]>();
 for(const run of candidates){
  const options={eq:{sync_run_id:String(run.id)},gte:{period_from:startOfParisDay(from)},lt:{period_from:startOfParisDay(to)},order:'period_from,dimensions_key'};
  const rows=await pagedRows(db,'source_aggregates',options);
  manifests.push(...rows.filter(r=>r.metric_key==='kpi_daily_manifest'));dataByRun.set(String(run.id),rows.filter(r=>r.metric_key==='kpi_daily_row'));
 }
 const selected=manifests.sort((a,b)=>String((b.dimensions as Row).observedAt).localeCompare(String((a.dimensions as Row).observedAt))||String(b.id).localeCompare(String(a.id)));
 for (const day of kpiDays(from, to)) {
  for (const manifest of selected.filter(m => (m.dimensions as Row).day === day)) {
   const info = manifest.dimensions as Row;
   const rows = (dataByRun.get(String(manifest.sync_run_id))??[]).filter(r=>(r.dimensions as unknown as KpiSourceRow).day===day).map(r=>r.dimensions as unknown as KpiSourceRow).sort((a,b)=>a.key.localeCompare(b.key));
   if (rows.length !== info.count || digest(rows) !== info.hash) continue;
   result.days.set(day, { rows, observedAt: String(info.observedAt), runId: String(manifest.sync_run_id) }); break;
  }
 }
 return result;
}
// ---------------------------------------------------------------------------------------------------------------
const WINDOW = { from: '2026-09-10', to: '2026-09-20' };
const rowsFor = (days: string[], values: Record<string, number>, overrides: Record<string, Record<string, number | null>> = {}) =>
  days.flatMap(day => Object.entries({ ...values, ...(overrides[day] ?? {}) }).filter(([, value]) => value !== null).map(([key, value]) => ({ day, key, data: { campaignId: key, spend_eur: value, nested: { z: 1, a: 2 } } })));
const between = (from: string, to: string) => kpiDays(from, to);
const kpiBatch = (from: string, to: string, observedAt: string, rows: ReturnType<typeof rowsFor>): KpiSourceBatch => ({ from, to, observedAt, rows: rows.filter(row => row.day >= from && row.day < to) });
/** Tentative interrompue juste avant sa publication : l'ancien code passe alors la tentative en échec, lignes déjà écrites. */
const crashBeforeFinish = (db: Database): Database => ({ ...db, rpc: async <T,>(fn: string, args: Row) => { if (fn === 'finish_sync' && args.p_status === 'complete') throw new ConnectorError('UPSTREAM_HTTP_ERROR', 503); return db.rpc<T>(fn, args); } });
// Rapport Masterclass (ancien chemin 016 puis nouveau 018) : réclamation, requête unique terminée, publication atomique.
const MC_PROFILE = 'mc-state-v1';
const mcContext = { origin: 'https://eu.posthog.com', scope: { source: 'all', campaignId: null }, client: { quizHost: 'https://quizz.blg-studio.fr' }, expectedQueries: ['masterclass'] };
const P1 = { from: '2026-09-01T22:00:00.000Z', to: '2026-09-03T22:00:00.000Z', days: ['2026-09-02', '2026-09-04'] }, P2 = { from: '2026-09-01T22:00:00.000Z', to: '2026-09-04T22:00:00.000Z', days: ['2026-09-02', '2026-09-05'] };
async function mcClaim(namespace: string, period: typeof P1) {
  const c = await rpc('cockpit_claim_posthog', { p_namespace: namespace, p_stream: 'masterclass_observations', p_profile: MC_PROFILE, p_from: period.from, p_to: period.to, p_context: mcContext });
  assert.equal(c.busy, false, JSON.stringify(c));
  await rpc('cockpit_save_posthog_query', { p_run: c.runId, p_lease: c.lease, p_name: 'masterclass', p_continuation: { version: 1, id: 'q-' + c.runId.slice(0, 8), origin: 'https://eu.posthog.com', projectId: namespace, queryHash: 'b'.repeat(64), startedAt: Date.now() }, p_complete: true });
  return c;
}
function mcRecords(namespace: string, period: typeof P1, events: Record<string, number>, observedAt: string) {
  const baseRow = { source: 'posthog', source_namespace: namespace, metric_key: 'posthog_mc_events', period_from: period.from, period_to: period.to, report_profile_key: MC_PROFILE, timezone: 'Europe/Paris', coverage_state: 'complete', unit: 'count', currency: null, currency_exponent: null, tax_basis: 'unknown', definition_version: MC_PROFILE };
  const total = Object.values(events).reduce((a, b) => a + b, 0);
  return [{ ...baseRow, dimensions_key: 'all', value: total, dimensions: { coverage: { queryComplete: true, hostVerified: true }, observedAt }, source_locator: 'posthog:masterclass:overview' },
    ...Object.entries(events).map(([event, value]) => ({ ...baseRow, dimensions_key: `event:${event}`, value, dimensions: { event, events: value }, source_locator: `posthog:masterclass:${event}` }))];
}
async function mcPublish(namespace: string, period: typeof P1, events: Record<string, number>) {
  const c = await mcClaim(namespace, period);const records = mcRecords(namespace, period, events, c.observedAt);
  const ack = await rpc('cockpit_publish_posthog', { p_run: c.runId, p_lease: c.lease, p_records: records, p_read: records[0].value });
  return { c, records, ack };
}
const mcWindow = async (namespace: string, period: typeof P1) => rpc('cockpit_source_window', { p_source: 'posthog', p_namespace: namespace, p_stream: 'masterclass_observations', p_profile: MC_PROFILE, p_from: period.days[0], p_to: period.days[1], p_timezone: 'Europe/Paris', p_currency: null, p_currency_exponent: null, p_kind: 'exact_report' });
const withoutCurrent = (window: any) => ({ ...window, aggregates: window.aggregates.map(({ is_current: _c, ...row }: Row) => row) });
const mcValues = (window: any) => Object.fromEntries(window.aggregates.map((row: Row) => [row.dimensions_key, Number(row.value)]));

const legacy: { kpi?: Record<string, KpiStoredSource>; kpiSub?: KpiStoredSource; mc?: Record<string, unknown> } = {};
test('ancien schéma, ancien chemin d’écriture : trois tentatives complètes, une en échec, un jour modifié ; lectures relevées', async () => {
  const days = between(WINDOW.from, WINDOW.to), values = { c1: 10, c2: 20 };
  const snapshots: Record<string, KpiStoredSource> = {};
  for (const source of ['meta', 'posthog', 'wix'] as KpiSource[]) {
    const ns = `cmp-${source}`;
    await legacySyncKpiSource(pdb, source, ns, '2026-09-10', '2026-09-15', async () => kpiBatch('2026-09-10', '2026-09-15', '2026-09-15T08:00:00Z', rowsFor(days, values)));
    // Deuxième tentative : c2 disparaît le 12, c1 change le 13, c3 apparaît le 14.
    await legacySyncKpiSource(pdb, source, ns, '2026-09-12', '2026-09-18', async () => kpiBatch('2026-09-12', '2026-09-18', '2026-09-18T08:00:00Z', rowsFor(days, values, { '2026-09-12': { c2: null }, '2026-09-13': { c1: 11 }, '2026-09-14': { c3: 30 } })));
    // Tentative interrompue avant publication : ses lignes (c1 = 999 le 13) restent écrites mais jamais lues.
    await assert.rejects(legacySyncKpiSource(crashBeforeFinish(pdb), source, ns, '2026-09-10', '2026-09-20', async () => kpiBatch('2026-09-10', '2026-09-20', '2026-09-20T08:00:00Z', rowsFor(days, values, { '2026-09-13': { c1: 999 } }))));
    await legacySyncKpiSource(pdb, source, ns, '2026-09-16', '2026-09-20', async () => kpiBatch('2026-09-16', '2026-09-20', '2026-09-20T09:00:00Z', rowsFor(days, values, { '2026-09-17': { c1: 12 } })));
    snapshots[source] = await legacyReadKpiSource(pdb, source, ns, WINDOW.from, WINDOW.to);
    assert.equal(snapshots[source].days.size, 10);
    assert.equal(snapshots[source].days.get('2026-09-13')?.rows.find(row => row.key === 'c1')?.data.spend_eur, 11, 'la tentative en échec n’est jamais lue');
    assert.equal(snapshots[source].latestAttempt?.status, 'complete');
  }
  legacy.kpi = snapshots;
  legacy.kpiSub = await legacyReadKpiSource(pdb, 'meta', 'cmp-meta', '2026-09-12', '2026-09-15');
  assert.equal(await count("source_namespace='cmp-meta'"), 5 * 3 + 6 * 3 - 1 + 1 + 10 * 3 + 4 * 3, 'l’ancien modèle garde une version complète par tentative');
  // Masterclass : deux publications de la même période exacte (valeurs changées), une autre période.
  await mcPublish('456', P1, { a: 6, b: 4 });await mcPublish('456', P1, { a: 7, b: 5 });await mcPublish('456', P2, { a: 9 });
  legacy.mc = { p1: await mcWindow('456', P1), p2: await mcWindow('456', P2) };
  assert.deepEqual(mcValues(legacy.mc.p1), { all: 12, 'event:a': 7, 'event:b': 5 });
});

test('migration 018 (reprise) puis nouveau lecteur : résultat identique à l’ancien, sur la même période', async () => {
  await sql.query(fs.readFileSync('supabase/migrations/018_current_state_by_stable_key.sql', 'utf8'));
  for (const source of ['meta', 'posthog', 'wix'] as KpiSource[]) {
    const now = await readKpiSource(pdb, source, `cmp-${source}`, WINDOW.from, WINDOW.to);
    assert.deepStrictEqual(now.days, legacy.kpi![source].days, `${source} : mêmes jours, mêmes lignes, même observation, même tentative`);
    assert.deepStrictEqual(now.latestAttempt, legacy.kpi![source].latestAttempt);
  }
  assert.deepStrictEqual((await readKpiSource(pdb, 'meta', 'cmp-meta', '2026-09-12', '2026-09-15')).days, legacy.kpiSub!.days, 'sous-période');
  // Seule la tentative gagnante de chaque jour est courante ; ni l’échec ni les anciennes versions.
  // 10 manifestes ; objets : 10-11 c1,c2 ; 12 c1 ; 13 c1,c2 ; 14 c1,c2,c3 ; 15 c1,c2 ; 16-19 c1,c2.
  assert.equal(await count("source_namespace='cmp-meta' AND is_current"), 10 + 4 + 1 + 2 + 3 + 2 + 8, 'un manifeste par jour et une ligne par objet courant');
  assert.equal(await count("source_namespace='cmp-meta' AND is_current AND (dimensions->'data'->>'spend_eur')::numeric=999"), 0);
  for (const key of ['p1', 'p2'] as const) assert.deepStrictEqual(withoutCurrent(await mcWindow('456', key === 'p1' ? P1 : P2)), withoutCurrent(legacy.mc![key]), `Masterclass ${key} : même lecture exact_report`);
  assert.equal(await count("source='posthog' AND source_namespace='456' AND is_current"), 3 + 2);
  // Rejouable : même état, une seule inscription.
  const before = (await sql.query('SELECT id FROM source_aggregates WHERE is_current ORDER BY id')).rows;
  await sql.query(fs.readFileSync('supabase/migrations/018_current_state_by_stable_key.sql', 'utf8'));
  assert.deepEqual((await sql.query('SELECT id FROM source_aggregates WHERE is_current ORDER BY id')).rows, before);
  assert.equal((await sql.query('SELECT count(*)::int AS n FROM cockpit_migrations WHERE version=18')).rows[0].n, 1);
});

test('nouveau chemin après reprise : une collecte identique confirme les lignes reprises, lecteurs inchangés', async () => {
  const days = between(WINDOW.from, WINDOW.to), total = await count("source_namespace='cmp-meta'");
  const reference = await readKpiSource(pdb, 'meta', 'cmp-meta', WINDOW.from, WINDOW.to);
  const run = await syncKpiSource(pdb, 'meta', 'cmp-meta', '2026-09-16', '2026-09-20', async () => kpiBatch('2026-09-16', '2026-09-20', '2026-09-20T09:00:00Z', rowsFor(days, { c1: 10, c2: 20 }, { '2026-09-17': { c1: 12 } })));
  assert.equal(await count("source_namespace='cmp-meta'"), total, 'aucune ligne de plus');
  const after = await readKpiSource(pdb, 'meta', 'cmp-meta', WINDOW.from, WINDOW.to);
  for (const day of days) {
    assert.deepStrictEqual(after.days.get(day)?.rows, reference.days.get(day)?.rows);
    assert.equal(after.days.get(day)?.runId, day >= '2026-09-16' ? run.runId : reference.days.get(day)?.runId, 'les jours republiés portent la nouvelle tentative');
  }
  // Masterclass : même rapport republié, la lecture exact_report reste identique et porte la nouvelle tentative.
  const again = await mcPublish('456', P1, { a: 7, b: 5 }), window = await mcWindow('456', P1);
  assert.equal(window.exactRunId, again.c.runId, 'contre-épreuve : sans confirmation (sync_run_id), la dernière tentative n’aurait aucune ligne');
  assert.deepEqual(mcValues(window), { all: 12, 'event:a': 7, 'event:b': 5 });
  assert.equal(await count("source='posthog' AND source_namespace='456'"), 3 + 3 + 2, 'aucune ligne de plus que les versions héritées');
});

// ---------------------------------------------------------------------------------------------------------------
// Non-accumulation, nouveau chemin, flux par flux. Totaux relevés sur la table métier de chaque flux.
const stateOf = async (run: string) => (await sql.query('SELECT checkpoint->\'state\' AS state, rows_written FROM sync_runs WHERE id=$1', [run])).rows[0];
const runs = async (where: string) => (await sql.query(`SELECT count(*)::int AS n FROM sync_runs WHERE ${where}`)).rows[0].n as number;
for (const source of ['meta', 'posthog', 'wix'] as KpiSource[]) test(`non-accumulation KPI ${kpiStream(source)} : identique, modifié, nouveau, disparu, rejeu, interruption`, async () => {
  const ns = `na-${source}`, flow = kpiStream(source), scope = `source_namespace='${ns}'`, from = '2026-09-10', to = '2026-09-13', days = between(from, to);
  const collect = (rows: ReturnType<typeof rowsFor>, observedAt = '2026-09-13T08:00:00Z', db: Database = pdb) => syncKpiSource(db, source, ns, from, to, async () => kpiBatch(from, to, observedAt, rows));
  const read = () => readKpiSource(pdb, source, ns, from, to);
  const ids = async () => (await sql.query(`SELECT id,metric_key,dimensions_key,period_from FROM source_aggregates WHERE ${scope} ORDER BY id`)).rows;
  let rows = rowsFor(days, { c1: 10, c2: 20 });
  await collect(rows);const initial = await count(scope);assert.equal(initial, 9, 'trois jours : deux objets et un manifeste par jour');
  note(flow, 'première collecte', 0, initial);
  // 1. Deux collectes identiques successives : aucune ligne métier de plus, seule sync_runs gagne une ligne.
  const reference = await read(), journal = await runs(`source_namespace='${ns}'`), before = await ids();
  const same = await collect(rows);
  assert.equal(await count(scope), initial);assert.deepEqual(await ids(), before, 'mêmes lignes');
  assert.equal(await runs(`source_namespace='${ns}'`), journal + 1);
  assert.equal(await count(`${scope} AND is_current AND sync_run_id<>$1`, [same.runId]), 0, 'les lignes courantes portent la nouvelle tentative');
  assert.deepEqual((await stateOf(same.runId)).state, { inserted: 0, changed: 0, confirmed: 9, retired: 0, cleaned: 0 });
  const identical = await read();for (const day of days) assert.deepStrictEqual(identical.days.get(day)?.rows, reference.days.get(day)?.rows);
  note(flow, 'collecte identique', initial, await count(scope), '(sync_runs +1)');
  // Relecture réelle : seule l'heure d'observation du manifeste change (mise à jour en place).
  const reread = await collect(rows, '2026-09-13T08:30:00Z');
  assert.deepEqual((await stateOf(reread.runId)).state, { inserted: 0, changed: 3, confirmed: 6, retired: 0, cleaned: 0 });assert.equal(await count(scope), initial);
  // 2. Valeur modifiée : même ligne (même id), aucune ligne de plus.
  const target = (await sql.query(`SELECT id FROM source_aggregates WHERE ${scope} AND is_current AND dimensions_key='c1' AND dimensions->>'day'='2026-09-10'`)).rows[0].id;
  rows = rowsFor(days, { c1: 10, c2: 20 }, { '2026-09-10': { c1: 15 } });
  const changed = await collect(rows, '2026-09-13T09:00:00Z');
  assert.equal(await count(scope), initial);
  assert.equal((await sql.query('SELECT (dimensions->\'data\'->>\'spend_eur\')::int AS v, sync_run_id FROM source_aggregates WHERE id=$1', [target])).rows[0].v, 15, 'la même ligne porte la nouvelle valeur');
  assert.equal((await read()).days.get('2026-09-10')?.rows.find(row => row.key === 'c1')?.data.spend_eur, 15);
  assert.equal(((await stateOf(changed.runId)).state as Row).inserted, 0);
  note(flow, 'valeur modifiée', initial, await count(scope), '(même id)');
  // 3. Nouvel objet : exactement une ligne de plus.
  rows = rowsFor(days, { c1: 10, c2: 20 }, { '2026-09-10': { c1: 15 }, '2026-09-11': { c3: 30 } });
  const added = await collect(rows, '2026-09-13T09:30:00Z');
  assert.equal(await count(scope), initial + 1);assert.equal(((await stateOf(added.runId)).state as Row).inserted, 1);
  note(flow, 'nouvel objet', initial, await count(scope));
  // 4. Objet disparu : retiré (is_current=false), non effacé, invisible des lecteurs ; total inchangé.
  rows = rowsFor(days, { c1: 10, c2: 20 }, { '2026-09-10': { c1: 15 }, '2026-09-11': { c3: 30 }, '2026-09-12': { c2: null } });
  const gone = await collect(rows, '2026-09-13T10:00:00Z');
  assert.equal(await count(scope), initial + 1, 'rien n’est effacé');
  assert.equal(await count(`${scope} AND NOT is_current AND dimensions_key='c2' AND dimensions->>'day'='2026-09-12'`), 1, 'objet retiré conservé');
  assert.equal((await read()).days.get('2026-09-12')?.rows.some(row => row.key === 'c2'), false, 'invisible des lecteurs');
  assert.equal(((await stateOf(gone.runId)).state as Row).retired, 1);
  note(flow, 'objet disparu', initial + 1, await count(scope), `(courantes ${await count(`${scope} AND is_current`)})`);
  // 5. Rejeu de la même publication (accusé perdu) : aucun changement.
  const snapshot = (await sql.query(`SELECT id,sync_run_id,is_current,value,dimensions FROM source_aggregates WHERE ${scope} ORDER BY id`)).rows;
  const replay = await rpc('cockpit_publish_aggregate_state', { p_run: gone.runId, p_metric_keys: '{kpi_daily_row,kpi_daily_manifest}', p_read: 1 });
  assert.equal(replay.duplicate, true);
  assert.deepEqual((await sql.query(`SELECT id,sync_run_id,is_current,value,dimensions FROM source_aggregates WHERE ${scope} ORDER BY id`)).rows, snapshot);
  note(flow, 'rejeu de publication', initial + 1, await count(scope));
  // 6. Tentative interrompue avant publication (processus arrêté : ni publication ni clôture) : lecteurs inchangés.
  const stable = await read(), crashed: Database = { ...pdb, rpc: async <T,>(fn: string, args: Row) => { if (fn === 'cockpit_publish_aggregate_state' || fn === 'finish_sync') throw new Error('processus interrompu'); return pdb.rpc<T>(fn, args); } };
  await assert.rejects(collect(rowsFor(days, { c1: 99, c2: 99 }), '2026-09-13T10:30:00Z', crashed));
  const interrupted = (await sql.query(`SELECT id FROM sync_runs WHERE source_namespace='${ns}' AND status='running'`)).rows[0].id;
  assert.equal(await count(`sync_run_id=$1`, [interrupted]), 9, 'lignes préparées, jamais courantes');
  assert.deepStrictEqual((await read()).days, stable.days, 'lecteurs inchangés');
  // Dix minutes plus tard, la tentative abandonnée expire ; la suivante publie normalement.
  await sql.query("UPDATE sync_runs SET started_at=started_at-interval '11 minutes' WHERE id=$1", [interrupted]);
  const resumed = await collect(rows, '2026-09-13T11:00:00Z');
  assert.equal((await sql.query('SELECT status FROM sync_runs WHERE id=$1', [interrupted])).rows[0].status, 'failed');
  assert.equal((await stateOf(resumed.runId)).state.inserted, 0);
  assert.equal(await count(scope), initial + 1 + 9, 'zone de préparation : 9 lignes invisibles de la tentative interrompue');
  note(flow, 'tentative interrompue', initial + 1, initial + 1 + 9, '(9 lignes préparées invisibles, nettoyées après 24 h)');
  // Nettoyage borné : plus de 24 h après, la publication suivante supprime ces lignes jamais publiées.
  await sql.query("UPDATE sync_runs SET started_at=started_at-interval '25 hours' WHERE id=$1", [interrupted]);
  // Garde « aucune purge héritée » (fusion U4c-garde) : seules les tentatives commencées après l'application de 018 sont nettoyées ; la migration est datée avant la tentative vieillie.
  await sql.query("UPDATE cockpit_migrations SET applied_at=least(applied_at, clock_timestamp()-interval '26 hours') WHERE version=18");
  const cleaned = await collect(rows, '2026-09-13T11:30:00Z');
  assert.equal((await stateOf(cleaned.runId)).state.cleaned, 9);assert.equal(await count(scope), initial + 1);
  assert.equal(await count(`${scope} AND is_current`), initial + 1 - 1);
  note(flow, 'nettoyage après 24 h', initial + 1 + 9, await count(scope));
});

test('non-accumulation Masterclass (masterclass_observations) : identique, modifié, nouveau, disparu, rejeu, interruption', async () => {
  const ns = '789', flow = 'masterclass_observations', scope = `source='posthog' AND source_namespace='${ns}'`;
  const values = async () => mcValues(await mcWindow(ns, P1));
  const first = await mcPublish(ns, P1, { a: 6, b: 4 });assert.equal(await count(scope), 3);note(flow, 'première collecte', 0, 3);
  const ids = (await sql.query(`SELECT id FROM source_aggregates WHERE ${scope} ORDER BY id`)).rows;
  // 1. Identique : aucune ligne de plus ; seule la ligne « all » voit son heure d'observation mise à jour, en place.
  const same = await mcPublish(ns, P1, { a: 6, b: 4 });
  assert.equal(await count(scope), 3);assert.deepEqual((await sql.query(`SELECT id FROM source_aggregates WHERE ${scope} ORDER BY id`)).rows, ids);
  assert.deepEqual({ ...same.ack.state }, { inserted: 0, changed: 1, confirmed: 2, retired: 0, current: 3, cleaned: 0 });
  assert.equal((await mcWindow(ns, P1)).exactRunId, same.c.runId);assert.deepEqual(await values(), { all: 10, 'event:a': 6, 'event:b': 4 });
  assert.equal((await sql.query('SELECT rows_written FROM sync_runs WHERE id=$1', [same.c.runId])).rows[0].rows_written, 3);
  note(flow, 'collecte identique', 3, await count(scope), '(sync_runs +1)');
  // 2. Modifié : même ligne.
  const eventA = (await sql.query(`SELECT id FROM source_aggregates WHERE ${scope} AND dimensions_key='event:a'`)).rows[0].id;
  await mcPublish(ns, P1, { a: 7, b: 4 });
  assert.equal(await count(scope), 3);assert.equal(Number((await sql.query('SELECT value FROM source_aggregates WHERE id=$1', [eventA])).rows[0].value), 7);
  note(flow, 'valeur modifiée', 3, await count(scope), '(même id)');
  // 3. Nouvel objet.
  await mcPublish(ns, P1, { a: 7, b: 4, c: 1 });assert.equal(await count(scope), 4);note(flow, 'nouvel objet', 3, 4);
  // 4. Disparu : retiré, conservé, invisible.
  const gone = await mcPublish(ns, P1, { a: 7, c: 1 });
  assert.equal(await count(scope), 4);assert.equal(gone.ack.state.retired, 1);
  assert.deepEqual(await values(), { all: 8, 'event:a': 7, 'event:c': 1 });
  note(flow, 'objet disparu', 4, await count(scope), `(courantes ${await count(`${scope} AND is_current`)})`);
  // 5. Rejeu (accusé perdu) : même contenu, même tentative, aucun changement.
  const snapshot = (await sql.query(`SELECT id,sync_run_id,is_current,value FROM source_aggregates WHERE ${scope} ORDER BY id`)).rows;
  const replay = await rpc('cockpit_publish_posthog', { p_run: gone.c.runId, p_lease: gone.c.lease, p_records: gone.records, p_read: gone.records[0].value });
  assert.equal(replay.duplicate, true);assert.deepEqual((await sql.query(`SELECT id,sync_run_id,is_current,value FROM source_aggregates WHERE ${scope} ORDER BY id`)).rows, snapshot);
  note(flow, 'rejeu de publication', 4, await count(scope));
  // 6. Interrompue avant publication : lecteurs inchangés ; bail expiré, la reprise publie la même tentative.
  const pending = await mcClaim(ns, P1);assert.deepEqual(await values(), { all: 8, 'event:a': 7, 'event:c': 1 });
  await sql.query("UPDATE sync_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [pending.runId]);
  const resumed = await rpc('cockpit_claim_posthog', { p_namespace: ns, p_stream: 'masterclass_observations', p_profile: MC_PROFILE, p_from: P1.from, p_to: P1.to, p_context: mcContext });
  assert.equal(resumed.runId, pending.runId);
  const records = mcRecords(ns, P1, { a: 7, c: 1 }, resumed.observedAt);
  await rpc('cockpit_publish_posthog', { p_run: resumed.runId, p_lease: resumed.lease, p_records: records, p_read: 8 });
  assert.equal(await count(scope), 4);assert.equal((await mcWindow(ns, P1)).exactRunId, resumed.runId);
  note(flow, 'tentative interrompue', 4, await count(scope), '(rien n’est écrit avant la publication atomique)');
  // Période différente (fenêtre du lendemain) : nouveaux objets, la période précédente reste courante et lisible.
  await mcPublish(ns, P2, { a: 9 });assert.equal(await count(scope), 6);assert.deepEqual(await values(), { all: 8, 'event:a': 7, 'event:c': 1 });
  note(flow, 'nouvelle période', 4, 6, '(fenêtre différente = nouveaux objets)');
  assert.ok(first.ack.state, 'la publication Masterclass renvoie son état');
  // Quiz : versions par tentative inchangées (aucune ligne courante, deux publications = deux versions).
  const quizContext = { ...mcContext, expectedQueries: ['overview', 'byEvent', 'byHostEvent', 'daily'] };
  for (let i = 0; i < 2; i++) {
    const c = await rpc('cockpit_claim_posthog', { p_namespace: ns, p_stream: 'quiz_observations', p_profile: 'quiz-state-v1', p_from: P1.from, p_to: P1.to, p_context: quizContext });
    for (const q of quizContext.expectedQueries) await rpc('cockpit_save_posthog_query', { p_run: c.runId, p_lease: c.lease, p_name: q, p_continuation: { version: 1, id: q + i, origin: 'https://eu.posthog.com', projectId: ns, queryHash: 'c'.repeat(64), startedAt: Date.now() }, p_complete: true });
    const quiz = { source: 'posthog', source_namespace: ns, metric_key: 'posthog_events', period_from: P1.from, period_to: P1.to, dimensions_key: 'all', report_profile_key: 'quiz-state-v1', timezone: 'Europe/Paris', coverage_state: 'complete', value: 5, unit: 'count', currency: null, currency_exponent: null, tax_basis: 'unknown', dimensions: { coverage: { queryComplete: true } }, definition_version: 'quiz-state-v1', source_locator: 'posthog:aggregate:all' };
    const ack = await rpc('cockpit_publish_posthog', { p_run: c.runId, p_lease: c.lease, p_records: [quiz], p_read: 5 });assert.equal(ack.state, undefined);
  }
  assert.equal(await count(`${scope} AND report_profile_key='quiz-state-v1'`), 2, 'quiz : une version par tentative, comme avant');
  assert.equal(await count(`${scope} AND report_profile_key='quiz-state-v1' AND is_current`), 0);
});

test('droits et rejeu des nouvelles fonctions d’état', async () => {
  for (const fn of ['cockpit_apply_aggregate_state(uuid,text[],boolean)', 'cockpit_publish_aggregate_state(uuid,text[],integer)', 'cockpit_publish_meta_daily(uuid,integer,integer)', 'cockpit_publish_posthog(uuid,uuid,jsonb,integer)', 'cockpit_stage_lead_entries(uuid,uuid,integer,jsonb,text,boolean,integer,integer)', 'cockpit_publish_lead_entries(uuid,uuid)']) {
    for (const role of ['anon', 'authenticated']) assert.equal((await sql.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS ok', [role, 'public.' + fn])).rows[0].ok, false, `${role} ${fn}`);
    assert.equal((await sql.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS ok', ['service_role', 'public.' + fn])).rows[0].ok, true, fn);
  }
  console.log('STATE_REPORT ' + JSON.stringify(report));
});
