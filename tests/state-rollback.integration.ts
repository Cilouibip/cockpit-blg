import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { postgresDatabase, type Database, type Row } from '../src/lib/db';
import { syncKpiSource, readKpiSource, kpiDays, kpiStream, nextDay, pagedRows, KPI_PROFILE, type KpiSource, type KpiSourceBatch, type KpiSourceRow, type KpiStoredSource } from '../src/lib/kpi-source-store';
import { startOfParisDay } from '../src/domain/dates';
import { ConnectorError, safeConnectorError } from '../src/connectors/http';

// PostgreSQL jetable local uniquement ; données synthétiques. Retour arrière APRÈS de nouvelles écritures (réserve Codex 6b) :
// 1) base migrée (jusqu'à 019), plusieurs collectes par le NOUVEAU chemin (valeur modifiée, objet disparu, objet apparu,
//    tentative interrompue) : l'ANCIEN lecteur (copie de 7bc6a68) et les vues lisent exactement ce que lit le nouveau ;
// 2) retour arrière du code : une collecte par l'ANCIEN chemin (finish_sync complete) ; l'ancien lecteur la voit ;
// 3) redéploiement : rejeu de la reprise de 018 (idempotente) puis reprise de l'état courant de 019 ; le nouveau lecteur
//    voit alors la même chose que l'ancien (données arrivées pendant la transition reprises), sans ligne ajoutée.
const base = new URL(process.env.TEST_DATABASE_URL || 'postgresql://localhost:55440/postgres');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw Error('LOCAL_ONLY');
const name = 'state_rollback_' + Date.now(), target = new URL(base);target.pathname = '/' + name;
const admin = new Client({ connectionString: base.href });let sql: Client;let pdb: Database;
const migrations = fs.readdirSync('supabase/migrations').filter(f => /^\d{3}_.*\.sql$/.test(f)).sort();
const MIGRATION_018 = fs.readFileSync('supabase/migrations/018_current_state_by_stable_key.sql', 'utf8');
before(async () => {
  await admin.connect();await admin.query(`CREATE DATABASE ${name}`);
  sql = new Client({ connectionString: target.href });await sql.connect();
  for (const file of migrations) await sql.query(fs.readFileSync('supabase/migrations/' + file, 'utf8'));
  pdb = postgresDatabase(target.href);
});
after(async () => { await sql?.end();await new Promise(resolve => setTimeout(resolve, 5500));await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end(); });
const one = async (query: string, params: unknown[] = []) => (await sql.query(query, params)).rows[0];
const count = async (table: string, where: string, params: unknown[] = []) => (await one(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).n as number;
const rpc = async <T = any>(fn: string, args: Record<string, unknown>): Promise<T> => {
  const entries = Object.entries(args);
  return (await one(`SELECT public.${fn}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) AS result`, entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value))).result;
};
const report: Record<string, unknown> = {};
const RESUME_NEEDED = `SELECT r.source, r.stream_key, r.id AS derniere_tentative, r.finished_at
  FROM sync_runs r
 WHERE r.stream_key IN ('kpi_meta_daily','kpi_posthog_daily','kpi_wix_daily','ad_daily') AND r.status IN ('complete','empty') AND r.pagination_complete
   AND r.finished_at = (SELECT max(x.finished_at) FROM sync_runs x WHERE x.source = r.source AND x.source_namespace = r.source_namespace AND x.stream_key = r.stream_key
                         AND x.query_profile_key = r.query_profile_key AND x.status IN ('complete','empty') AND x.pagination_complete)
   AND (EXISTS (SELECT FROM source_aggregates a WHERE a.sync_run_id = r.id) OR EXISTS (SELECT FROM ad_daily d WHERE d.sync_run_id = r.id))
   AND NOT EXISTS (SELECT FROM source_aggregates a WHERE a.sync_run_id = r.id AND a.is_current)
   AND NOT EXISTS (SELECT FROM ad_daily d WHERE d.sync_run_id = r.id AND d.is_current)`;
const resumeNeeded = async () => (await sql.query(RESUME_NEEDED)).rows.map(r => `${r.source}/${r.stream_key}`).sort();

// ---------------------------------------------------------------------------------------------------------------
// Copie locale, à l'identique, de l'ancien chemin d'écriture et de l'ancien lecteur KPI (src/lib/kpi-source-store.ts au
// commit 7bc6a68, déjà copiés dans tests/state-aggregates.integration.ts ; ce fichier n'est pas modifié).
function canonical(value: unknown): unknown {
 if (Array.isArray(value)) return value.map(canonical);
 if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
 return value;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
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
async function legacyReadKpiSource(db: Database, source: KpiSource, namespace: string | undefined, from: string, to: string): Promise<KpiStoredSource> {
 const result: KpiStoredSource = { days: new Map(), latestAttempt: null };
 if (!namespace) return result;
 const eq = { source, source_namespace: namespace, stream_key: kpiStream(source), query_profile_key: KPI_PROFILE };
 const dates = kpiDays(from,to);
 const attempts = await db.select('sync_runs', { eq, order:'started_at,id',descending:true,limit:1 });result.latestAttempt=attempts[0]??null;
 const candidates: Row[] = [];
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
// Jeux synthétiques. KPI : fenêtre du 10 au 16 septembre. Publicités : fenêtre du 10 au 13. Masterclass : une période exacte.
const NS = { kpi: 'rb-kpi', ad: '555', mc: '666' }, KPI = { from: '2026-09-10', to: '2026-09-16' }, AD = { from: '2026-09-10', to: '2026-09-13' };
const kpiRows = (values: Record<string, number>, overrides: Record<string, Record<string, number | null>> = {}) =>
  kpiDays(KPI.from, KPI.to).flatMap(day => Object.entries({ ...values, ...(overrides[day] ?? {}) }).filter(([, value]) => value !== null).map(([key, value]) => ({ day, key, data: { campaignId: key, spend_eur: value } })));
const kpiBatch = (from: string, to: string, observedAt: string, rows: ReturnType<typeof kpiRows>): KpiSourceBatch => ({ from, to, observedAt, rows: rows.filter(row => row.day >= from && row.day < to) });
const newKpi = (from: string, to: string, observedAt: string, rows: ReturnType<typeof kpiRows>, db: Database = pdb) => syncKpiSource(db, 'meta', NS.kpi, from, to, async () => kpiBatch(from, to, observedAt, rows));
const oldKpi = (from: string, to: string, observedAt: string, rows: ReturnType<typeof kpiRows>) => legacySyncKpiSource(pdb, 'meta', NS.kpi, from, to, async () => kpiBatch(from, to, observedAt, rows));
const readers = async (from = KPI.from, to = KPI.to) => ({ fresh: await readKpiSource(pdb, 'meta', NS.kpi, from, to), legacy: await legacyReadKpiSource(pdb, 'meta', NS.kpi, from, to) });
const spend = (read: KpiStoredSource, day: string, key: string) => read.days.get(day)?.rows.find(row => row.key === key)?.data.spend_eur;

const paris = (day: string) => new Date(`${day}T00:00:00+02:00`).toISOString();
const adDays = kpiDays(AD.from, AD.to);
const adRow = (adId: string, date: string, spendMinor: number, conversions = 1) => ({ accountId: NS.ad, adId, campaignId: 'c-1', adsetId: 's-1', adName: `Synthetic ${adId}`, campaignName: 'Synthetic campaign', connectorVersion: 'meta-read-v1', observedAt: '2026-09-20T08:00:00Z', date, timezone: 'Europe/Paris', currency: 'EUR', spendMinor, impressions: 100, outboundClicks: 5, reportedConversions: [{ window: '7d_click', action: 'lead', count: conversions }] });
const beginAd = async () => (await one('SELECT begin_sync_stream($1,$2,$3,$4,$5,$6,$7,$8,$9) AS id', ['meta', NS.ad, paris(AD.from), paris(AD.to), 'v23.0-ad-day-none', 'aggregate_period', 'ad_daily', AD.from, AD.to])).id as string;
const importPage = (run: string, records: unknown[]) => sql.query('SELECT import_meta_page($1,$2,NULL)', [run, JSON.stringify(records)]);
const newAd = async (records: unknown[]) => { const run = await beginAd();await importPage(run, records);await one('SELECT cockpit_publish_meta_daily($1,$2,0) AS r', [run, records.length]);return run; };
const oldAd = async (records: unknown[]) => { const run = await beginAd();await importPage(run, records);await sql.query('SELECT finish_sync($1,\'complete\',$2,0,true,NULL)', [run, records.length]);return run; };
const adView = async () => (await sql.query('SELECT d.* FROM v_ad_daily d JOIN ads a ON a.id=d.ad_id WHERE a.source_namespace=$1 ORDER BY d.id', [NS.ad])).rows;
const adCurrent = async () => (await sql.query('SELECT d.* FROM ad_daily d JOIN ads a ON a.id=d.ad_id WHERE a.source_namespace=$1 AND d.is_current ORDER BY d.id', [NS.ad])).rows;
const convView = async () => (await sql.query('SELECT d.* FROM v_meta_conversions_daily d JOIN ads a ON a.id=d.ad_id WHERE a.source_namespace=$1 ORDER BY d.id', [NS.ad])).rows;
const convCurrent = async () => (await sql.query('SELECT d.* FROM meta_conversions_daily d JOIN ads a ON a.id=d.ad_id WHERE a.source_namespace=$1 AND d.is_current ORDER BY d.id', [NS.ad])).rows;

const MC_PROFILE = 'mc-rollback-v1', MC = { from: '2026-09-01T22:00:00.000Z', to: '2026-09-03T22:00:00.000Z', days: ['2026-09-02', '2026-09-04'] };
const mcContext = { origin: 'https://eu.posthog.com', scope: { source: 'all', campaignId: null }, client: { quizHost: 'https://quizz.blg-studio.fr' }, expectedQueries: ['masterclass'] };
async function mcClaim() {
  const c = await rpc('cockpit_claim_posthog', { p_namespace: NS.mc, p_stream: 'masterclass_observations', p_profile: MC_PROFILE, p_from: MC.from, p_to: MC.to, p_context: mcContext });
  assert.equal(c.busy, false, JSON.stringify(c));
  await rpc('cockpit_save_posthog_query', { p_run: c.runId, p_lease: c.lease, p_name: 'masterclass', p_continuation: { version: 1, id: 'q-' + c.runId.slice(0, 8), origin: 'https://eu.posthog.com', projectId: NS.mc, queryHash: 'b'.repeat(64), startedAt: Date.now() }, p_complete: true });
  return c;
}
/** Même RPC pour l'ancien et le nouveau code (cockpit_publish_posthog, version de 018 en base). */
async function mcPublish(events: Record<string, number>, claimed?: { runId: string; lease: string; observedAt: string }) {
  const c = claimed ?? await mcClaim(), baseRow = { source: 'posthog', source_namespace: NS.mc, metric_key: 'posthog_mc_events', period_from: MC.from, period_to: MC.to, report_profile_key: MC_PROFILE, timezone: 'Europe/Paris', coverage_state: 'complete', unit: 'count', currency: null, currency_exponent: null, tax_basis: 'unknown', definition_version: MC_PROFILE };
  const total = Object.values(events).reduce((a, b) => a + b, 0);
  const records = [{ ...baseRow, dimensions_key: 'all', value: total, dimensions: { coverage: { queryComplete: true, hostVerified: true }, observedAt: c.observedAt }, source_locator: 'posthog:masterclass:overview' },
    ...Object.entries(events).map(([event, value]) => ({ ...baseRow, dimensions_key: `event:${event}`, value, dimensions: { event, events: value }, source_locator: `posthog:masterclass:${event}` }))];
  await rpc('cockpit_publish_posthog', { p_run: c.runId, p_lease: c.lease, p_records: records, p_read: total });
  return c.runId as string;
}
const mcWindow = async () => rpc('cockpit_source_window', { p_source: 'posthog', p_namespace: NS.mc, p_stream: 'masterclass_observations', p_profile: MC_PROFILE, p_from: MC.days[0], p_to: MC.days[1], p_timezone: 'Europe/Paris', p_currency: null, p_currency_exponent: null, p_kind: 'exact_report' });
// Même sérialisation que cockpit_source_window (to_jsonb) pour comparer ligne à ligne.
const mcCurrent = async () => (await sql.query('SELECT to_jsonb(a) AS j FROM source_aggregates a WHERE source=\'posthog\' AND source_namespace=$1 AND is_current ORDER BY id', [NS.mc])).rows.map(row => row.j as Row);
const byId = (rows: Row[]) => [...rows].map(row => JSON.stringify(canonical(row))).sort();
/** Les vues v_ad_daily et v_meta_conversions_daily ont les colonnes de la table à leur création (001) : comparaison sur ces colonnes. */
const sameRows = (view: Row[], current: Row[], message: string) => {
  const columns = Object.keys(view[0] ?? current[0] ?? {}).filter(column => view.length ? column in view[0] : column !== 'is_current');
  assert.ok(view.length > 0, `${message} : vue non vide`);
  assert.deepStrictEqual(byId(view), byId(current.map(row => Object.fromEntries(columns.map(column => [column, row[column]])))), message);
};

/** Lecteurs comparés : ancien lecteur KPI = nouveau ; vues = lignes courantes (publicités, conversions, Masterclass). */
async function assertSameReads(step: string) {
  const whole = await readers(), sub = await readers('2026-09-12', '2026-09-15');
  assert.deepStrictEqual(whole.fresh.days, whole.legacy.days, `${step} : KPI, ancien lecteur = nouveau lecteur (période complète)`);
  assert.deepStrictEqual(whole.fresh.latestAttempt, whole.legacy.latestAttempt, `${step} : KPI, même dernière tentative`);
  assert.deepStrictEqual(sub.fresh.days, sub.legacy.days, `${step} : KPI, sous-période`);
  assert.equal(whole.fresh.days.size, kpiDays(KPI.from, KPI.to).length, `${step} : tous les jours mesurés`);
  sameRows(await adView(), await adCurrent(), `${step} : v_ad_daily = lignes courantes`);
  sameRows(await convView(), await convCurrent(), `${step} : v_meta_conversions_daily = lignes courantes`);
  const window = await mcWindow();
  assert.deepStrictEqual(byId(window.aggregates), byId(await mcCurrent()), `${step} : cockpit_source_window Masterclass = lignes courantes`);
  return whole;
}
const totals = async () => ({ kpi: await count('source_aggregates', 'source_namespace=$1', [NS.kpi]), ad: await count('ad_daily', 'ad_id IN (SELECT id FROM ads WHERE source_namespace=$1)', [NS.ad]), conversions: await count('meta_conversions_daily', 'ad_id IN (SELECT id FROM ads WHERE source_namespace=$1)', [NS.ad]), masterclass: await count('source_aggregates', 'source_namespace=$1', [NS.mc]) });

test('1. après 018 : collectes par le nouveau chemin (modifié, disparu, apparu, interrompu) ; ancien lecteur et vues = nouveau lecteur', async () => {
  // KPI : première collecte, valeur modifiée le 11, objet c2 disparu le 13, objet c3 apparu le 14, tentative interrompue.
  await newKpi(KPI.from, KPI.to, '2026-09-16T08:00:00Z', kpiRows({ c1: 10, c2: 20 }));
  await newKpi(KPI.from, KPI.to, '2026-09-16T08:30:00Z', kpiRows({ c1: 10, c2: 20 }, { '2026-09-11': { c1: 15 } }));
  await newKpi('2026-09-12', KPI.to, '2026-09-16T09:00:00Z', kpiRows({ c1: 10, c2: 20 }, { '2026-09-13': { c2: null } }));
  await newKpi('2026-09-12', KPI.to, '2026-09-16T09:30:00Z', kpiRows({ c1: 10, c2: 20 }, { '2026-09-13': { c2: null }, '2026-09-14': { c3: 30 } }));
  const crashed: Database = { ...pdb, rpc: async <T,>(fn: string, args: Row) => { if (fn === 'cockpit_publish_aggregate_state' || fn === 'finish_sync') throw new Error('processus interrompu'); return pdb.rpc<T>(fn, args); } };
  await assert.rejects(newKpi(KPI.from, KPI.to, '2026-09-16T09:45:00Z', kpiRows({ c1: 777, c2: 777 }), crashed));
  await sql.query("UPDATE sync_runs SET started_at=started_at-interval '11 minutes' WHERE source_namespace=$1 AND status='running'", [NS.kpi]);
  // Publicités : première collecte, valeur modifiée, publicité 2 disparue le 12, publicité 3 apparue le 11, tentative interrompue.
  await newAd(adDays.flatMap(d => [adRow('1', d, 100), adRow('2', d, 200)]));
  await newAd(adDays.flatMap(d => [adRow('1', d, d === '2026-09-10' ? 150 : 100, 2), adRow('2', d, 200)]));
  await newAd(adDays.flatMap(d => [adRow('1', d, d === '2026-09-10' ? 150 : 100, 2), ...(d === '2026-09-12' ? [] : [adRow('2', d, 200)])]));
  await newAd([...adDays.flatMap(d => [adRow('1', d, d === '2026-09-10' ? 150 : 100, 2), ...(d === '2026-09-12' ? [] : [adRow('2', d, 200)])]), adRow('3', '2026-09-11', 300)]);
  const pending = await beginAd();await importPage(pending, adDays.map(d => adRow('1', d, 999)));
  await sql.query("UPDATE sync_runs SET started_at=started_at-interval '11 minutes' WHERE id=$1", [pending]);
  // Masterclass : valeur modifiée, objet disparu, objet apparu ; une réclamation interrompue (rien n'est écrit avant la publication).
  await mcPublish({ a: 6, b: 4 });await mcPublish({ a: 7, b: 4 });await mcPublish({ a: 7 });await mcPublish({ a: 7, c: 1 });
  const interrupted = await mcClaim();await sql.query("UPDATE sync_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [interrupted.runId]);
  const resumed = await rpc('cockpit_claim_posthog', { p_namespace: NS.mc, p_stream: 'masterclass_observations', p_profile: MC_PROFILE, p_from: MC.from, p_to: MC.to, p_context: mcContext });
  assert.equal(resumed.runId, interrupted.runId, 'bail expiré : la même tentative reprend');await mcPublish({ a: 7, c: 1 }, resumed);
  assert.deepEqual(await resumeNeeded(), [], 'contrôle 7.1.3.b : rien à reprendre après des collectes du nouveau chemin');
  const read = await assertSameReads('après les collectes du nouveau chemin');
  assert.equal(spend(read.fresh, '2026-09-11', 'c1'), 15);assert.equal(spend(read.fresh, '2026-09-13', 'c2'), undefined);assert.equal(spend(read.fresh, '2026-09-14', 'c3'), 30);
  assert.ok(![...read.fresh.days.values()].some(day => day.rows.some(row => row.data.spend_eur === 777)), 'la tentative interrompue n’est lue par personne');
  report.step1 = { totals: await totals() };
});

const transition: { oldKpi?: string; oldAd?: string; totals?: Record<string, number> } = {};
test('2. retour arrière du code : une collecte par l’ancien chemin (finish_sync complete) ; l’ancien lecteur la voit', async () => {
  const before = await totals();
  // Ancien code : une version complète par passage, sans publication d'état (c1 modifié le 15, c3 disparu et c4 apparu le 14).
  const kpi = await oldKpi('2026-09-13', KPI.to, '2026-09-16T10:00:00Z', kpiRows({ c1: 10, c2: 20 }, { '2026-09-13': { c2: null }, '2026-09-14': { c4: 40 }, '2026-09-15': { c1: 99 } }));
  const ad = await oldAd(adDays.flatMap(d => [adRow('1', d, d === '2026-09-12' ? 175 : 100, 3), adRow('4', d, 400)]));
  // Masterclass : l'ancien code appelle la même RPC ; en base, c'est la version de 018 (état courant tenu).
  await mcPublish({ a: 8, c: 1, d: 2 });
  transition.oldKpi = kpi.runId;transition.oldAd = ad;
  const { fresh, legacy } = await readers();
  for (const day of ['2026-09-13', '2026-09-14', '2026-09-15']) assert.equal(legacy.days.get(day)?.runId, kpi.runId, `${day} : l’ancien lecteur lit la tentative de l’ancien chemin`);
  assert.equal(spend(legacy, '2026-09-15', 'c1'), 99);assert.equal(spend(legacy, '2026-09-14', 'c4'), 40);assert.equal(spend(legacy, '2026-09-14', 'c3'), undefined);
  assert.ok((await adView()).every(row => row.sync_run_id === ad), 'v_ad_daily lit la tentative de l’ancien chemin');
  assert.equal((await mcWindow()).exactRunId !== null, true);
  // Contrôle 7.1.3.b (docs/ACTUALISATION.md) : les écritures de l'ancien code sont détectées avant toute reprise.
  assert.deepEqual(await resumeNeeded(), ['meta/ad_daily', 'meta/kpi_meta_daily'], 'reprise nécessaire : dernière tentative complète non portée par les lignes courantes');
  // Constat : le nouveau lecteur ne voit pas cette tentative (lignes non courantes) tant que la reprise n'est pas faite.
  assert.equal(spend(fresh, '2026-09-15', 'c1'), 10, 'nouveau lecteur : valeur d’avant le retour arrière');
  const after = await totals();transition.totals = after;
  report.step2 = { before, after, legacyRun: kpi.runId === legacy.days.get('2026-09-15')?.runId, freshSeesOld: spend(fresh, '2026-09-15', 'c1') === 99 };
});

test('3. redéploiement : rejeu de la reprise de 018 puis reprise de l’état courant (019) ; nouveau lecteur = ancien, sans ligne ajoutée', async () => {
  // Rejeu de 018 (idempotent) : il complète seulement les clés sans ligne courante ; il ne remplace pas une ligne courante.
  await sql.query(MIGRATION_018);
  const replay = await readers();
  report.step3_replay018 = { sameAsLegacy: JSON.stringify([...replay.fresh.days]) === JSON.stringify([...replay.legacy.days]), freshDays: replay.fresh.days.size, c1On15: spend(replay.fresh, '2026-09-15', 'c1') ?? null };
  assert.notDeepStrictEqual(replay.fresh.days, replay.legacy.days, 'constat : le rejeu de 018 seul ne reprend pas les données arrivées pendant la transition');
  // Reprise de l'état courant (019) : pour chaque clé, la ligne de la publication que lisent les anciens lecteurs devient courante.
  const resumed = await rpc('cockpit_resume_current_state', {});
  assert.deepEqual(await resumeNeeded(), [], 'contrôle 7.1.3.b vide après la reprise');
  await assertSameReads('après la reprise');
  const read = await readers();
  assert.equal(spend(read.fresh, '2026-09-15', 'c1'), 99);assert.equal(spend(read.fresh, '2026-09-14', 'c4'), 40);assert.equal(spend(read.fresh, '2026-09-14', 'c3'), undefined);
  for (const day of ['2026-09-13', '2026-09-14', '2026-09-15']) assert.equal(read.fresh.days.get(day)?.runId, transition.oldKpi);
  assert.ok((await adCurrent()).every(row => row.sync_run_id === transition.oldAd));
  assert.deepEqual(await totals(), transition.totals, 'aucune ligne ajoutée ni supprimée par la reprise');
  // Rejouable : un second appel ne change rien.
  const again = await rpc('cockpit_resume_current_state', {});
  for (const table of Object.keys(again)) assert.deepEqual(again[table], { periods: 0, retired: 0, promoted: 0 }, `${table} : second appel sans effet`);
  // Le nouveau chemin reprend normalement : une collecte identique ne crée aucune ligne, les lecteurs restent égaux.
  const beforeNext = await totals();
  await newKpi('2026-09-13', KPI.to, '2026-09-16T10:00:00Z', kpiRows({ c1: 10, c2: 20 }, { '2026-09-13': { c2: null }, '2026-09-14': { c4: 40 }, '2026-09-15': { c1: 99 } }));
  await newAd(adDays.flatMap(d => [adRow('1', d, d === '2026-09-12' ? 175 : 100, 3), adRow('4', d, 400)]));
  await assertSameReads('collecte suivante du nouveau chemin');
  assert.deepEqual(await totals(), beforeNext, 'collecte identique après la reprise : aucune ligne de plus');
  report.step3 = { resumed, again, totals: await totals() };
  console.log('ROLLBACK_REPORT ' + JSON.stringify(report));
});

test('4. reprise de l’état courant : droits service_role seulement', async () => {
  for (const role of ['anon', 'authenticated']) assert.equal((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS ok', [role, 'public.cockpit_resume_current_state()'])).ok, false, role);
  assert.equal((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS ok', ['service_role', 'public.cockpit_resume_current_state()'])).ok, true);
});
