import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { Temporal } from '@js-temporal/polyfill';
import { postgresDatabase, type Database, type Row } from '../src/lib/db';
import { syncKpiSource, readKpiWindows, kpiDays, nextDay, KPI_PROFILE, type KpiSourceBatch, type KpiWindowRow } from '../src/lib/kpi-source-store';
import { kpiWindows } from '../src/connectors/kpi-meta';
import { startOfParisDay } from '../src/domain/dates';

// PostgreSQL jetable local uniquement ; données synthétiques (ni chiffres BLG, ni données nominatives).
// Réserve CP2 (revue Codex du 24/09) : le stockage au fil des JOURS n'était prouvé que le même jour (6 → 6) et au lendemain (6 → 9).
// Ce scénario déroule 35 jours de collectes KPI Meta (lignes par jour + fenêtres CTRU) et de rapports Masterclass, avec :
// répétition inchangée (48 passages le premier jour), passage de jour, changement de mois, valeur modifiée, échec puis reprise,
// lecture d'uniques en échec (aucune fenêtre écrite), fenêtre retirée puis réapparue. Il relève, jour par jour, les lignes
// courantes, retirées, préparées et le journal, puis contrôle la migration 022 (réapparition = même ligne) sur la même base.
const base = new URL(process.env.TEST_DATABASE_URL || 'postgresql://localhost:55440/postgres');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw Error('LOCAL_ONLY');
const name = 'state_days_' + Date.now(), target = new URL(base);target.pathname = '/' + name;
const admin = new Client({ connectionString: base.href });let sql: Client;let pdb: Database;
const migrations = fs.readdirSync('supabase/migrations').filter(f => /^\d{3}_.*\.sql$/.test(f)).sort();
const upTo = (version: number) => migrations.filter(f => Number(f.slice(0, 3)) <= version);
before(async () => {
  await admin.connect();await admin.query(`CREATE DATABASE ${name}`);
  sql = new Client({ connectionString: target.href });await sql.connect();
  // Version livrée 748c6d0 : migrations 001 à 021. La 022 est appliquée plus bas, sur la base déjà peuplée.
  for (const file of upTo(21)) await sql.query(fs.readFileSync('supabase/migrations/' + file, 'utf8'));
  // Le nettoyage borné (018, 019) ne touche que les tentatives commencées après 018 : la migration est datée d'avant le scénario.
  await sql.query("UPDATE cockpit_migrations SET applied_at=least(applied_at, clock_timestamp()-interval '40 days') WHERE version=18");
  pdb = postgresDatabase(target.href);
});
after(async () => { await sql?.end();await new Promise(resolve => setTimeout(resolve, 5500));await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end(); });
const one = async (query: string, params: unknown[] = []) => (await sql.query(query, params)).rows[0];
const n = async (query: string, params: unknown[] = []) => Number((await one(query, params)).n);
const rpc = async <T = any>(fn: string, args: Record<string, unknown>): Promise<T> => {
  const entries = Object.entries(args);
  return (await one(`SELECT public.${fn}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) AS result`, entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value))).result;
};

// ---------------------------------------------------------------------------------------------------------------
// Collecte KPI Meta d'un jour « today » : fenêtre de 36 jours [today - 35, today + 1) comme synchronizeKpi ; quatre objets par jour
// (trois campagnes + une ligne « compte ») ; six fenêtres CTRU (3, 7, 30 jours finissant hier et aujourd'hui).
const NS = 'days-meta', SET = 'c1,c2,c3', CAMPAIGNS = ['c1', 'c2', 'c3'];
const shift = (day: string, days: number) => Temporal.PlainDate.from(day).add({ days }).toString();
const periodOf = (today: string) => ({ from: shift(today, -35), to: shift(today, 1) });
type Collect = { today: string; hour: string; value?: number; reach?: number; windows?: 'all' | 'partial' | 'none'; crash?: boolean };
function batchFor(o: Collect): KpiSourceBatch {
  const { from, to } = periodOf(o.today), value = o.value ?? 10, reach = o.reach ?? 1000;
  const rows = kpiDays(from, to).filter(day => day <= o.today).flatMap(day => [
    ...CAMPAIGNS.map(key => ({ day, key, data: { campaignId: key, spend_eur: value, impressions: 100 * value, link_clicks: 3, nested: { z: 1, a: 2 } } })),
    { day, key: `account:${SET}`, data: { level: 'account', campaignIds: CAMPAIGNS, reach, impressions: 300 * value, link_clicks: 9, unique_link_clicks: 8, outbound_clicks: 7 } },
  ]);
  const windows: KpiWindowRow[] = kpiWindows(from, to).map(w => ({ from: w.since, to: nextDay(w.until), key: SET, data: { level: 'account', campaignIds: CAMPAIGNS, reach, impressions: 5000, link_clicks: 100, unique_link_clicks: 50, outbound_clicks: 40 } }));
  const kept = o.windows === 'partial' ? windows.filter(w => !(w.to === to && shift(w.from, 3) === to)) : windows; // sans la fenêtre de 3 jours finissant aujourd'hui
  return { from, to, observedAt: `${o.today}T${o.hour}:00Z`, rows, ...(o.windows === 'none' ? {} : { windows: kept }) };
}
const crashing = (db: Database): Database => ({ ...db, rpc: async <T,>(fn: string, args: Row) => { if (fn === 'cockpit_publish_aggregate_state') throw new Error('panne synthétique avant publication'); return db.rpc<T>(fn, args); } });
async function collect(o: Collect) {
  const { from, to } = periodOf(o.today), batch = batchFor(o);
  if (o.crash) { await assert.rejects(syncKpiSource(crashing(pdb), 'meta', NS, from, to, async () => batch), /panne synthétique/);return null; }
  return syncKpiSource(pdb, 'meta', NS, from, to, async () => batch);
}
// Rapport Masterclass (PostHog, période exacte) : du 1er du mois précédent à demain, comme le tick.
const MC_NS = '77001', MC_PROFILE = 'mc-days-v1'; // espace de noms PostHog : numérique (contrôle de 016)
const mcContext = { origin: 'https://eu.posthog.com', scope: { source: 'all', campaignId: null }, client: { quizHost: 'https://quiz.example.test' }, expectedQueries: ['masterclass'] };
const mcPeriod = (today: string) => ({ from: startOfParisDay(Temporal.PlainDate.from(today).with({ day: 1 }).subtract({ months: 1 }).toString()), to: startOfParisDay(shift(today, 1)) });
async function mcPublish(today: string, events: Record<string, number> = { a: 5, b: 3 }) {
  const period = mcPeriod(today);
  const c = await rpc('cockpit_claim_posthog', { p_namespace: MC_NS, p_stream: 'masterclass_observations', p_profile: MC_PROFILE, p_from: period.from, p_to: period.to, p_context: mcContext });
  assert.equal(c.busy, false, JSON.stringify(c));
  await rpc('cockpit_save_posthog_query', { p_run: c.runId, p_lease: c.lease, p_name: 'masterclass', p_continuation: { version: 1, id: 'q-' + c.runId.slice(0, 8), origin: 'https://eu.posthog.com', projectId: MC_NS, queryHash: 'b'.repeat(64), startedAt: Date.now() }, p_complete: true });
  const baseRow = { source: 'posthog', source_namespace: MC_NS, metric_key: 'posthog_mc_events', period_from: period.from, period_to: period.to, report_profile_key: MC_PROFILE, timezone: 'Europe/Paris', coverage_state: 'complete', unit: 'count', currency: null, currency_exponent: null, tax_basis: 'unknown', definition_version: MC_PROFILE };
  const total = Object.values(events).reduce((a, b) => a + b, 0);
  const records = [{ ...baseRow, dimensions_key: 'all', value: total, dimensions: { coverage: { queryComplete: true, hostVerified: true }, observedAt: c.observedAt }, source_locator: 'posthog:masterclass:overview' },
    ...Object.entries(events).map(([event, value]) => ({ ...baseRow, dimensions_key: `event:${event}`, value, dimensions: { event, events: value }, source_locator: `posthog:masterclass:${event}` }))];
  return rpc('cockpit_publish_posthog', { p_run: c.runId, p_lease: c.lease, p_records: records, p_read: total });
}
// ---------------------------------------------------------------------------------------------------------------
type Counts = { daily_current: number; daily_retired: number; manifest_current: number; manifest_retired: number; window_current: number; window_retired: number; window_manifest_current: number; window_manifest_retired: number; staged: number; total: number; duplicate_keys: number; mc_current: number; mc_retired: number; mc_total: number; runs: number };
async function counts(): Promise<Counts> {
  const c = async (metric: string, current: boolean) => n(`SELECT count(*) AS n FROM source_aggregates a JOIN sync_runs r ON r.id=a.sync_run_id WHERE a.source_namespace=$1 AND a.metric_key=$2 AND a.is_current=$3 AND r.status IN ('complete','empty')`, [NS, metric, current]);
  return {
    daily_current: await c('kpi_daily_row', true), daily_retired: await c('kpi_daily_row', false),
    manifest_current: await c('kpi_daily_manifest', true), manifest_retired: await c('kpi_daily_manifest', false),
    window_current: await c('kpi_window_row', true), window_retired: await c('kpi_window_row', false),
    window_manifest_current: await c('kpi_window_manifest', true), window_manifest_retired: await c('kpi_window_manifest', false),
    staged: await n(`SELECT count(*) AS n FROM source_aggregates a JOIN sync_runs r ON r.id=a.sync_run_id WHERE a.source_namespace=$1 AND NOT a.is_current AND r.status NOT IN ('complete','empty')`, [NS]),
    total: await n('SELECT count(*) AS n FROM source_aggregates WHERE source_namespace=$1', [NS]),
    duplicate_keys: await n('SELECT count(*) AS n FROM (SELECT metric_key,period_from,period_to,dimensions_key FROM source_aggregates WHERE source_namespace=$1 GROUP BY 1,2,3,4 HAVING count(*)>1) d', [NS]),
    mc_current: await n('SELECT count(*) AS n FROM source_aggregates WHERE source_namespace=$1 AND is_current', [MC_NS]),
    mc_retired: await n('SELECT count(*) AS n FROM source_aggregates WHERE source_namespace=$1 AND NOT is_current', [MC_NS]),
    mc_total: await n('SELECT count(*) AS n FROM source_aggregates WHERE source_namespace=$1', [MC_NS]),
    runs: await n('SELECT count(*) AS n FROM sync_runs WHERE source_namespace IN ($1,$2)', [NS, MC_NS]),
  };
}
const idsOf = async (where: string, params: unknown[] = []) => (await sql.query(`SELECT id FROM source_aggregates WHERE source_namespace=$1 AND ${where} ORDER BY id`, [NS, ...params])).rows.map(r => r.id as string);
const cleanup = async () => (await one('SELECT cockpit_cleanup_staged(5000) AS r')).r as Record<string, number>;
const DAY0 = '2026-09-20', DAYS = 35; // 20/09 → 24/10 : passage de mois le 01/10 (jour 11)
const day = (i: number) => shift(DAY0, i);
const report: { days: (Counts & { day: string; passes: number; note?: string })[]; events: Record<string, unknown> } = { days: [], events: {} };

test('jour 0 : 48 passages identiques dans la journée (cadence 30) ; aucune ligne métier de plus après le premier, seule sync_runs croît', async () => {
  const first = await collect({ today: DAY0, hour: '00:30' });assert.equal(first?.status, 'complete');await mcPublish(DAY0);
  const after1 = await counts();
  assert.deepEqual([after1.daily_current, after1.manifest_current, after1.window_current, after1.window_manifest_current, after1.mc_current], [36 * 4, 36, 6, 6, 3]);
  assert.equal(after1.total, 36 * 5 + 12);
  const ids = await idsOf('true');
  for (let pass = 1; pass < 48; pass++) { const hour = `${String(Math.floor(pass / 2)).padStart(2, '0')}:${pass % 2 ? '30' : '00'}`;await collect({ today: DAY0, hour });await mcPublish(DAY0); }
  const after48 = await counts();
  assert.deepEqual({ ...after48, runs: 0 }, { ...after1, runs: 0 }, '47 passages inchangés : aucune ligne métier de plus (mêmes lignes)');
  assert.deepEqual(await idsOf('true'), ids, 'mêmes identifiants');
  assert.equal(after48.runs, after1.runs + 47 * 2, 'seule sync_runs gagne une ligne par tentative');
  report.days.push({ day: DAY0, passes: 48, ...after48 });
});

test('jours 1 à 34 : passage de jour, changement de mois, modification, échec puis reprise, uniques en échec, fenêtre retirée puis réapparue', async () => {
  let previous = report.days[0] as Counts;
  const windowRowIds = () => idsOf(`metric_key='kpi_window_row' AND is_current`);
  for (let i = 1; i < DAYS; i++) {
    const today = day(i), notes: string[] = [];
    if (i === 6) {
      // Échec de la veille (jour 5) vieilli de 25 h : le nettoyage borné (019, appelé par le tick à chaque passage) retire ses lignes préparées.
      const stagedBefore = (await counts()).staged;
      await sql.query("UPDATE sync_runs SET started_at=started_at-interval '25 hours', finished_at=finished_at-interval '25 hours' WHERE source_namespace=$1 AND status='failed'", [NS]);
      const deleted = await cleanup();
      assert.equal(deleted.source_aggregates, stagedBefore, 'les lignes préparées de la tentative en échec sont supprimées, rien d’autre');
      assert.equal((await counts()).staged, 0);report.events.cleanup = { day: today, stagedBefore, deleted };notes.push(`nettoyage ${deleted.source_aggregates}`);
    }
    // Premier passage du jour.
    if (i === 5) { await collect({ today, hour: '08:00', crash: true });notes.push('échec avant publication (lignes préparées conservées jusqu’au nettoyage)'); }
    else if (i === 7) { await collect({ today, hour: '08:00' });await collect({ today, hour: '12:00', windows: 'partial' });notes.push('fenêtre 3 jours (aujourd’hui) lue puis non lue : retirée'); }
    else if (i === 9) { await collect({ today, hour: '08:00', windows: 'none' });notes.push('lectures d’uniques en échec : aucune fenêtre écrite, fenêtres de la veille intactes'); }
    else await collect({ today, hour: '08:00' });
    await mcPublish(today);
    const morning = await counts();
    if (i === 5) {
      assert.equal(morning.staged, 36 * 5 + 12, 'la tentative en échec laisse ses lignes préparées, invisibles');
      assert.equal(morning.daily_current, previous.daily_current, 'les lignes courantes de la veille restent lues');
    }
    if (i === 7) {
      assert.equal(morning.window_current, 5);assert.equal(morning.window_retired, previous.window_retired + 3 + 1, 'trois fenêtres d’avant-hier retirées, plus la fenêtre lue le matin et non lue à midi');
      report.events.partialWindows = { day: today, current: morning.window_current, retired: morning.window_retired };
    }
    if (i === 9) {
      assert.equal(morning.window_current, 6, 'sans lecture de fenêtre, l’état courant des fenêtres ne bouge pas');
      assert.equal((await readKpiWindows(pdb, 'meta', NS)).size, 6);
      assert.ok([...(await readKpiWindows(pdb, 'meta', NS)).values()].every(w => w.to <= today), 'les fenêtres courantes sont celles de la veille (datées)');
    }
    // Second passage du jour.
    if (i === 3) {
      const before = await windowRowIds(), dailyBefore = await idsOf(`metric_key='kpi_daily_row' AND is_current`);
      const changed = await collect({ today, hour: '18:00', value: 11, reach: 1007 });
      assert.deepEqual(await windowRowIds(), before, 'valeur modifiée : mêmes lignes de fenêtre (même id)');
      assert.deepEqual(await idsOf(`metric_key='kpi_daily_row' AND is_current`), dailyBefore, 'valeur modifiée : mêmes lignes par jour');
      const state = (await one('SELECT checkpoint->\'state\' AS s FROM sync_runs WHERE id=$1', [changed!.runId])).s;
      assert.equal(state.inserted, 0);assert.ok(state.changed > 0);report.events.modified = { day: today, state };notes.push(`modification en place (${state.changed} lignes)`);
    } else if (i === 5) { await collect({ today, hour: '18:00' });notes.push('reprise : publication normale'); }
    else if (i === 7) {
      const retiredKey = await one(`SELECT metric_key,period_from,period_to,dimensions_key FROM source_aggregates WHERE source_namespace=$1 AND metric_key='kpi_window_row' AND NOT is_current AND period_to=$2 AND period_from=$3`, [NS, startOfParisDay(shift(today, 1)), startOfParisDay(shift(today, -2))]);
      assert.ok(retiredKey, 'la fenêtre non lue a été retirée (conservée)');
      await collect({ today, hour: '18:00' });
      const after = await counts();
      const rowsForKey = await n(`SELECT count(*) AS n FROM source_aggregates WHERE source_namespace=$1 AND metric_key='kpi_window_row' AND period_from=$2 AND period_to=$3 AND dimensions_key=$4`, [NS, retiredKey.period_from, retiredKey.period_to, retiredKey.dimensions_key]);
      // CONSTAT sur 748c6d0 (migrations ≤ 021) : la fenêtre réapparue est promue comme un NOUVEL objet ; la ligne retirée reste : deux lignes pour une clé.
      assert.equal(after.window_current, 6);assert.equal(rowsForKey, 2, 'constat 748c6d0 : réapparition = nouvelle ligne à côté de la ligne retirée');
      assert.equal(after.duplicate_keys, 2, 'constat 748c6d0 : deux clés en double (ligne de fenêtre et son manifeste)');
      assert.equal(after.window_retired, previous.window_retired + 4, 'la ligne retirée reste retirée à côté de la nouvelle');
      report.events.reappearanceBefore022 = { day: today, rowsForKey, duplicateKeys: after.duplicate_keys };notes.push('réapparition : ligne en double (constat 748c6d0)');
    } else await collect({ today, hour: '18:00' });
    await mcPublish(today);
    const evening = await counts();
    // Passage de jour : quatre objets et un manifeste pour le jour nouveau ; trois fenêtres nouvelles, trois retirées (conservées) ;
    // trois lignes de rapport Masterclass pour la période nouvelle (période exacte : les rapports des jours précédents restent courants).
    if (![5, 7].includes(i)) {
      assert.equal(evening.daily_current, previous.daily_current + 4, `${today} : quatre objets par jour de plus, aucune ligne retirée`);
      assert.equal(evening.daily_retired, 0);assert.equal(evening.manifest_retired, 0);
      assert.equal(evening.manifest_current, previous.manifest_current + 1);
      assert.equal(evening.window_current, 6);assert.equal(evening.window_manifest_current, 6);
      assert.equal(evening.window_retired, previous.window_retired + 3, `${today} : trois fenêtres d’avant-hier retirées, conservées`);
      assert.equal(evening.window_manifest_retired, previous.window_manifest_retired + 3);
      assert.equal(evening.mc_current, previous.mc_current + 3, `${today} : rapport Masterclass d’une nouvelle période, l’ancien reste courant (périmètre exact)`);
      assert.equal(evening.mc_retired, 0);
    }
    if (i === 11) {
      // 01/10 : la fenêtre de collecte commence le 27/08 ; les jours d'août antérieurs restent courants et lus (historique conservé).
      assert.equal(today, '2026-10-01');
      const outside = await n(`SELECT count(*) AS n FROM source_aggregates WHERE source_namespace=$1 AND metric_key='kpi_daily_row' AND is_current AND period_from<$2`, [NS, startOfParisDay(periodOf(today).from)]);
      assert.equal(outside, 4 * 11, 'onze jours sortis de la fenêtre de 36 jours : toujours courants, jamais retirés');
      const mcAnchor = mcPeriod(today);assert.equal(mcAnchor.from, startOfParisDay('2026-09-01'));
      report.events.monthChange = { day: today, kpiFrom: periodOf(today).from, currentDaysOutsideWindow: outside / 4, mcFrom: mcAnchor.from };notes.push('changement de mois : jours hors fenêtre conservés courants ; ancre Masterclass 01/09');
    }
    assert.equal(evening.staged, i === 5 ? 36 * 5 + 12 : 0);
    report.days.push({ day: today, passes: 2, ...evening, ...(notes.length ? { note: notes.join(' ; ') } : {}) });
    previous = evening;
  }
  const last = report.days.at(-1)!, first = report.days[0];
  // Bilan sur 35 jours (748c6d0) : croissance linéaire par JOUR, jamais par passage.
  assert.equal(last.daily_current, first.daily_current + 4 * (DAYS - 1));
  assert.equal(last.window_retired, 3 * (DAYS - 1) + 1, 'fenêtres retirées : trois par jour, plus la fenêtre non lue du jour 7');
  assert.equal(last.window_current + last.window_retired, 6 + 3 * (DAYS - 1) + 1, 'lignes de fenêtre : 6 + 3 par jour + le doublon de réapparition du jour 7 (constat)');
  assert.equal(last.mc_current, 3 * DAYS, 'rapport Masterclass : trois lignes par jour, toutes courantes');
  assert.equal(last.runs, first.runs + 2 * 2 * (DAYS - 1) + 1, 'journal : une ligne par tentative (le jour 7 compte un passage de plus)');
  report.events.summary = { days: DAYS, dailyRowsPerDay: 4, windowRowsPerDay: 3, windowManifestsPerDay: 3, masterclassRowsPerDay: 3, perPassGrowth: 0 };
});

test('migration 022 sur la base peuplée : rejouable, aucune ligne ajoutée ni supprimée ; réapparition = même ligne (fenêtre, jour) ; doublons antérieurs inchangés', async () => {
  const file = migrations.find(f => f.startsWith('022_'));assert.ok(file, 'migration 022 présente');
  const before = await counts(), totalAll = await n('SELECT count(*) AS n FROM source_aggregates');
  await sql.query(fs.readFileSync('supabase/migrations/' + file!, 'utf8'));
  await sql.query(fs.readFileSync('supabase/migrations/' + file!, 'utf8'));
  assert.equal(await n('SELECT count(*) AS n FROM cockpit_migrations WHERE version=22'), 1);
  assert.deepEqual(await counts(), before, 'la migration ne touche aucune ligne');assert.equal(await n('SELECT count(*) AS n FROM source_aggregates'), totalAll);
  // Jour 35 : fenêtre de 3 jours non lue le matin (retirée), relue le soir : la MÊME ligne redevient courante.
  const today = day(DAYS);
  await collect({ today, hour: '08:00' });
  await collect({ today, hour: '12:00', windows: 'partial' });
  const retired = await one(`SELECT id,period_from,period_to,dimensions_key FROM source_aggregates WHERE source_namespace=$1 AND metric_key='kpi_window_row' AND NOT is_current AND period_to=$2 AND period_from=$3`, [NS, startOfParisDay(shift(today, 1)), startOfParisDay(shift(today, -2))]);
  assert.ok(retired);
  const manifestRetired = await one(`SELECT id FROM source_aggregates WHERE source_namespace=$1 AND metric_key='kpi_window_manifest' AND NOT is_current AND period_to=$2 AND period_from=$3`, [NS, startOfParisDay(shift(today, 1)), startOfParisDay(shift(today, -2))]);
  const morning = await counts();
  const back = await collect({ today, hour: '18:00' });
  const rows = (await sql.query(`SELECT id,is_current,sync_run_id,dimensions FROM source_aggregates WHERE source_namespace=$1 AND metric_key='kpi_window_row' AND period_from=$2 AND period_to=$3 AND dimensions_key=$4`, [NS, retired.period_from, retired.period_to, retired.dimensions_key])).rows;
  assert.equal(rows.length, 1, '022 : une seule ligne pour la fenêtre réapparue');
  assert.equal(rows[0].id, retired.id, 'la ligne retirée redevient courante (même id)');assert.equal(rows[0].is_current, true);assert.equal(rows[0].sync_run_id, back!.runId);
  assert.equal((await one('SELECT is_current FROM source_aggregates WHERE id=$1', [manifestRetired.id])).is_current, true, 'son manifeste aussi');
  const state = (await one('SELECT checkpoint->\'state\' AS s FROM sync_runs WHERE id=$1', [back!.runId])).s;
  assert.equal(state.reappeared, 2, 'compteur de réapparition : ligne + manifeste');assert.equal(state.inserted, 0, 'aucune ligne insérée : les fenêtres du jour existaient déjà');
  const evening = await counts();
  assert.equal(evening.window_current, 6);assert.equal(evening.total, morning.total, 'aucune ligne de plus');
  assert.equal(evening.duplicate_keys, before.duplicate_keys, 'les deux doublons du constat (jour 7) restent, jamais effacés ; aucun nouveau');
  // Objet par jour disparu puis réapparu (campagne absente d'une lecture, présente à la suivante) : même ligne.
  const missingDay = shift(today, -1), rowBefore = await one(`SELECT id FROM source_aggregates WHERE source_namespace=$1 AND metric_key='kpi_daily_row' AND is_current AND dimensions_key='c2' AND period_from=$2`, [NS, startOfParisDay(missingDay)]);
  const { from, to } = periodOf(today);
  const without = batchFor({ today, hour: '19:00' });without.rows = without.rows.filter(r => !(r.day === missingDay && r.key === 'c2'));
  await syncKpiSource(pdb, 'meta', NS, from, to, async () => without);
  assert.equal((await one('SELECT is_current FROM source_aggregates WHERE id=$1', [rowBefore.id])).is_current, false, 'objet absent : retiré, conservé');
  const again = await syncKpiSource(pdb, 'meta', NS, from, to, async () => batchFor({ today, hour: '20:00' }));
  const row = await one('SELECT is_current,sync_run_id FROM source_aggregates WHERE id=$1', [rowBefore.id]);
  assert.equal(row.is_current, true, 'objet réapparu : la même ligne redevient courante');assert.equal(row.sync_run_id, again.runId);
  assert.equal(await n(`SELECT count(*) AS n FROM source_aggregates WHERE source_namespace=$1 AND metric_key='kpi_daily_row' AND dimensions_key='c2' AND period_from=$2`, [NS, startOfParisDay(missingDay)]), 1);
  assert.equal((await counts()).duplicate_keys, before.duplicate_keys);
  // Le double mémoire et le lecteur voient six fenêtres, dont la réapparue.
  const read = await readKpiWindows(pdb, 'meta', NS);assert.equal(read.size, 6);
  report.events.reappearanceAfter022 = { day: today, sameId: rows[0].id === retired.id, state, duplicateKeys: evening.duplicate_keys };
  // Preuve : BLG_REPORT_DIR=<dossier> écrit le relevé complet (le format TAP coupe les longues lignes de console).
  if (process.env.BLG_REPORT_DIR) fs.writeFileSync(path.join(process.env.BLG_REPORT_DIR, 'stockage-35-jours.json'), JSON.stringify({ head: process.env.BLG_REPORT_HEAD ?? null, generatedAt: new Date().toISOString(), synthetic: true, ...report }, null, 1));
  console.log('DAYS_REPORT ' + JSON.stringify(report.events.summary));
});

test('migration 022 : droits service_role seulement sur les fonctions remplacées', async () => {
  for (const fn of ['public.cockpit_apply_aggregate_state(uuid,text[],boolean)', 'public.cockpit_publish_meta_daily(uuid,integer,integer)']) {
    for (const role of ['anon', 'authenticated']) assert.equal((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS ok', [role, fn])).ok, false, `${role} ${fn}`);
    assert.equal((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS ok', ['service_role', fn])).ok, true, fn);
  }
});
