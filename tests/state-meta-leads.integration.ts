import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { postgresDatabase, type Database, type Row } from '../src/lib/db';
import { synchronizeMetaAds } from '../src/lib/sync';
import { databaseTickLease, tickSyncJobs, type SyncJob } from '../src/lib/sync-jobs';
import { syncKpiSource, type KpiSourceBatch } from '../src/lib/kpi-source-store';

// PostgreSQL jetable local uniquement ; données synthétiques. Publicités par jour (ad_daily, meta_conversions_daily)
// et inscriptions Wix (lead_entries_forms). 1) Lectures v_ad_daily / v_meta_conversions_daily identiques avant et après la
// migration 018 (ancien schéma, ancien chemin d'écriture). 2) Non-accumulation avec le nouveau chemin.
const base = new URL(process.env.TEST_DATABASE_URL || 'postgresql://localhost:55440/postgres');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw Error('LOCAL_ONLY');
const name = 'state_meta_leads_' + Date.now(), target = new URL(base);target.pathname = '/' + name;
const admin = new Client({ connectionString: base.href });let sql: Client;
const migrations = fs.readdirSync('supabase/migrations').filter(f => /^\d{3}_.*\.sql$/.test(f)).sort();
before(async () => {
  await admin.connect();await admin.query(`CREATE DATABASE ${name}`);
  sql = new Client({ connectionString: target.href });await sql.connect();
  for (const file of migrations.filter(f => Number(f.slice(0, 3)) < 18)) await sql.query(fs.readFileSync('supabase/migrations/' + file, 'utf8'));
});
after(async () => { await sql?.end();await new Promise(resolve => setTimeout(resolve, 5500));await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end(); });
const one = async (query: string, params: unknown[] = []) => (await sql.query(query, params)).rows[0];
const n = async (table: string, where: string, params: unknown[] = []) => (await one(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).n as number;
const report: Record<string, Record<string, string>> = {};
const note = (flow: string, scenario: string, before: number, after: number, extra = '') => { (report[flow] ??= {})[scenario] = `${before} -> ${after}${extra ? ' ' + extra : ''}`; };

// ---------------------------------------------------------------------------------------------------------------
// Publicités par jour.
const PROFILE = 'v23.0-ad-day-none';
const adRow = (ns: string, adId: string, date: string, spendMinor: number, conversions = 1) => ({ accountId: ns, adId, campaignId: 'c-1', adsetId: 's-1', adName: `Synthetic ${adId}`, campaignName: 'Synthetic campaign', connectorVersion: 'meta-read-v1', observedAt: '2026-09-20T08:00:00Z', date, timezone: 'Europe/Paris', currency: 'EUR', spendMinor, impressions: 100, outboundClicks: 5, reportedConversions: [{ window: '7d_click', action: 'lead', count: conversions }] });
const paris = (day: string) => new Date(`${day}T00:00:00+02:00`).toISOString();
async function begin(ns: string, from: string, to: string) {
  return (await one('SELECT begin_sync_stream($1,$2,$3,$4,$5,$6,$7,$8,$9) AS id', ['meta', ns, paris(from), paris(to), PROFILE, 'aggregate_period', 'ad_daily', from, to])).id as string;
}
const importPage = (run: string, records: unknown[]) => sql.query('SELECT import_meta_page($1,$2,NULL)', [run, JSON.stringify(records)]);
/** Ancien chemin (avant 018) : import page par page puis finish_sync ; chaque tentative garde sa version. */
async function legacyMeta(ns: string, from: string, to: string, records: unknown[], finish: 'complete' | 'failed' = 'complete') {
  const run = await begin(ns, from, to);await importPage(run, records);
  await sql.query('SELECT finish_sync($1,$2,$3,0,$4,$5)', [run, finish, records.length, finish === 'complete', finish === 'complete' ? null : 'UPSTREAM_HTTP_ERROR']);
  return run;
}
/** Nouveau chemin : import page par page (préparation) puis publication atomique. */
async function publishMeta(ns: string, from: string, to: string, records: unknown[]) {
  const run = await begin(ns, from, to);await importPage(run, records);
  const ack = (await one('SELECT cockpit_publish_meta_daily($1,$2,0) AS r', [run, records.length])).r;
  return { run, ack };
}
const view = async (ns: string) => (await sql.query('SELECT a.external_id, d.* FROM v_ad_daily d JOIN ads a ON a.id=d.ad_id WHERE a.source_namespace=$1 ORDER BY a.external_id, d.date', [ns])).rows;
const conversionsView = async (ns: string) => (await sql.query('SELECT a.external_id, d.* FROM v_meta_conversions_daily d JOIN ads a ON a.id=d.ad_id WHERE a.source_namespace=$1 ORDER BY a.external_id, d.date, d.action_type', [ns])).rows;
const days = (from: string, count: number) => Array.from({ length: count }, (_, i) => new Date(Date.parse(from + 'T12:00:00Z') + i * 86_400_000).toISOString().slice(0, 10));
const inNs = (ns: string) => `ad_id IN (SELECT id FROM ads WHERE source_namespace='${ns}')`;

const legacyViews: Record<string, unknown[]> = {};
test('ad_daily, ancien schéma et ancien chemin : trois tentatives complètes, une en échec, un jour modifié ; vues relevées', async () => {
  const ns = '111';
  await legacyMeta(ns, '2026-09-10', '2026-09-13', days('2026-09-10', 3).flatMap(d => [adRow(ns, '1', d, 100), adRow(ns, '2', d, 200)]));
  // Deuxième tentative : pub 1 modifiée le 12, pub 2 disparue le 13, pub 3 apparue le 14.
  await legacyMeta(ns, '2026-09-11', '2026-09-15', [...days('2026-09-11', 4).map(d => adRow(ns, '1', d, d === '2026-09-12' ? 150 : 100)), ...days('2026-09-11', 2).map(d => adRow(ns, '2', d, 200)), adRow(ns, '3', '2026-09-14', 300)]);
  // Tentative en échec : ses lignes restent écrites, jamais lues.
  await legacyMeta(ns, '2026-09-10', '2026-09-16', days('2026-09-10', 6).map(d => adRow(ns, '1', d, 999)), 'failed');
  await legacyMeta(ns, '2026-09-14', '2026-09-16', days('2026-09-14', 2).flatMap(d => [adRow(ns, '1', d, 100), adRow(ns, '3', d, 300, 2)]));
  legacyViews.ad = await view(ns);legacyViews.conversions = await conversionsView(ns);
  // 10 : pubs 1,2 (tentative 1) ; 11-12 : pubs 1,2 ; 13 : pub 1 (tentative 2) ; 14-15 : pubs 1,3 (tentative 4).
  assert.equal(legacyViews.ad.length, 2 + 2 + 2 + 1 + 2 + 2, 'une ligne par publicité et par jour de la dernière tentative couvrant le jour');
  assert.ok(!legacyViews.ad.some(row => Number((row as { spend_minor: number }).spend_minor) === 999));
});

test('migration 018 (reprise) : v_ad_daily et v_meta_conversions_daily identiques ; lignes courantes = lignes lues', async () => {
  await sql.query(fs.readFileSync('supabase/migrations/018_current_state_by_stable_key.sql', 'utf8'));
  assert.deepStrictEqual(await view('111'), legacyViews.ad);
  assert.deepStrictEqual(await conversionsView('111'), legacyViews.conversions);
  const current = (await sql.query(`SELECT id FROM ad_daily WHERE is_current AND ${inNs('111')} ORDER BY id`)).rows.map(row => row.id);
  assert.deepEqual(current, (legacyViews.ad as { id: string }[]).map(row => row.id).sort(), 'la reprise marque exactement les lignes lues');
  assert.equal(await n('meta_conversions_daily', `is_current AND ${inNs('111')}`), legacyViews.conversions.length);
  // Même règle appliquée par le nouveau chemin : une collecte identique de la dernière fenêtre ne change pas la lecture.
  const again = await publishMeta('111', '2026-09-14', '2026-09-16', days('2026-09-14', 2).flatMap(d => [adRow('111', '1', d, 100), adRow('111', '3', d, 300, 2)]));
  const after = await view('111'), strip = (rows: unknown[]) => (rows as Record<string, unknown>[]).map(({ sync_run_id: _run, ...row }) => row);
  assert.deepStrictEqual(strip(after), strip(legacyViews.ad), 'mêmes lignes, mêmes valeurs');
  // Contre-épreuve de la confirmation : les lignes des jours republiés portent la nouvelle tentative, sinon v_ad_daily les perdrait.
  assert.equal(after.filter(row => row.date >= '2026-09-14').every(row => row.sync_run_id === again.run), true);
  assert.equal(after.filter(row => row.date >= '2026-09-14').length, 4);
});

test('non-accumulation ad_daily : identique, modifié, nouveau, disparu, rejeu, interruption, deux instances', async () => {
  const ns = '222', flow = 'ad_daily (+ meta_conversions_daily)', from = '2026-09-10', to = '2026-09-12', window = days(from, 2);
  const total = () => n('ad_daily', inNs(ns)), totalConversions = () => n('meta_conversions_daily', inNs(ns));
  let records = window.flatMap(d => [adRow(ns, '1', d, 100), adRow(ns, '2', d, 200)]);
  await publishMeta(ns, from, to, records);assert.equal(await total(), 4);assert.equal(await totalConversions(), 4);
  note(flow, 'première collecte', 0, 4, '(conversions 0 -> 4)');
  // 1. Identique.
  const ids = (await sql.query(`SELECT id FROM ad_daily WHERE ${inNs(ns)} ORDER BY id`)).rows, reference = await view(ns);
  const same = await publishMeta(ns, from, to, records);
  assert.equal(await total(), 4);assert.equal(await totalConversions(), 4);assert.deepEqual((await sql.query(`SELECT id FROM ad_daily WHERE ${inNs(ns)} ORDER BY id`)).rows, ids);
  assert.deepEqual({ ...same.ack.state, conversions: undefined }, { inserted: 0, changed: 0, confirmed: 4, retired: 0, cleaned: 0, conversions: undefined });
  assert.deepEqual(same.ack.state.conversions, { inserted: 0, changed: 0, confirmed: 4, retired: 0, current: 4 });
  const identical = await view(ns);
  assert.deepStrictEqual(identical.map(({ sync_run_id: _r, ...row }) => row), reference.map(({ sync_run_id: _r, ...row }) => row));
  assert.ok(identical.every(row => row.sync_run_id === same.run));
  assert.equal((await one('SELECT rows_written, status FROM sync_runs WHERE id=$1', [same.run])).rows_written, 4);
  note(flow, 'collecte identique', 4, await total(), '(conversions 4 -> 4, sync_runs +1)');
  // 2. Modifié : même ligne.
  const target = (await one(`SELECT d.id FROM ad_daily d JOIN ads a ON a.id=d.ad_id WHERE a.source_namespace=$1 AND a.external_id='1' AND d.date='2026-09-10'`, [ns])).id;
  records = window.flatMap(d => [adRow(ns, '1', d, d === '2026-09-10' ? 150 : 100, d === '2026-09-10' ? 3 : 1), adRow(ns, '2', d, 200)]);
  const changed = await publishMeta(ns, from, to, records);
  assert.equal(await total(), 4);assert.equal(Number((await one('SELECT spend_minor FROM ad_daily WHERE id=$1', [target])).spend_minor), 150);
  assert.equal(changed.ack.state.changed, 1);assert.equal(changed.ack.state.conversions.changed, 1);
  note(flow, 'valeur modifiée', 4, await total(), '(même id)');
  // 3. Nouvel objet.
  records = [...records, adRow(ns, '3', '2026-09-11', 300)];
  await publishMeta(ns, from, to, records);assert.equal(await total(), 5);assert.equal(await totalConversions(), 5);
  note(flow, 'nouvel objet', 4, 5);
  // 4. Disparu : retiré, conservé, invisible de v_ad_daily.
  records = records.filter(row => !(row.adId === '2' && row.date === '2026-09-11'));
  const gone = await publishMeta(ns, from, to, records);
  assert.equal(await total(), 5);assert.equal(gone.ack.state.retired, 1);assert.equal(gone.ack.state.conversions.retired, 1);
  assert.equal((await view(ns)).length, 4);assert.equal(await n('ad_daily', `${inNs(ns)} AND NOT is_current`), 1);
  note(flow, 'objet disparu', 5, await total(), '(courantes 4, conversions 5 -> 5)');
  // 5. Rejeu de la publication (accusé perdu).
  const snapshot = (await sql.query(`SELECT id,sync_run_id,is_current,spend_minor FROM ad_daily WHERE ${inNs(ns)} ORDER BY id`)).rows;
  assert.equal((await one('SELECT cockpit_publish_meta_daily($1,$2,0) AS r', [gone.run, records.length])).r.duplicate, true);
  assert.deepEqual((await sql.query(`SELECT id,sync_run_id,is_current,spend_minor FROM ad_daily WHERE ${inNs(ns)} ORDER BY id`)).rows, snapshot);
  note(flow, 'rejeu de publication', 5, await total());
  // Deux instances : la seconde réclamation du même flux est refusée (55P03, traduit en 409 source_busy puis « waiting »).
  const running = await begin(ns, from, to);
  await assert.rejects(begin(ns, from, to), { code: '55P03' });
  // 6. Interrompue avant publication (pages importées, aucune clôture) : vue inchangée.
  const stable = await view(ns);await importPage(running, records.map(row => ({ ...row, spendMinor: 777 })));
  assert.deepStrictEqual(await view(ns), stable, 'lignes préparées invisibles');
  await sql.query("UPDATE sync_runs SET started_at=started_at-interval '11 minutes' WHERE id=$1", [running]);
  const resumed = await publishMeta(ns, from, to, records);
  assert.equal((await one('SELECT status FROM sync_runs WHERE id=$1', [running])).status, 'failed');
  assert.equal(resumed.ack.state.inserted, 0);assert.deepStrictEqual((await view(ns)).map(({ sync_run_id: _r, ...row }) => row), stable.map(({ sync_run_id: _r, ...row }) => row));
  assert.equal(await total(), 5 + 4, 'zone de préparation : 4 lignes invisibles de la tentative interrompue');
  note(flow, 'tentative interrompue', 5, 9, '(4 lignes préparées invisibles, nettoyées après 24 h)');
  await sql.query("UPDATE sync_runs SET started_at=started_at-interval '25 hours' WHERE id=$1", [running]);
  const cleaned = await publishMeta(ns, from, to, records);
  assert.equal(cleaned.ack.state.cleaned, 8, 'quatre lignes et quatre conversions préparées supprimées');assert.equal(await total(), 5);
  note(flow, 'nettoyage après 24 h', 9, await total());
});

test('synchronizeMetaAds de bout en bout (double de l’API Meta) : deux passages identiques, aucune ligne de plus', async () => {
  const db = postgresDatabase(target.href), env = { NODE_ENV: 'test', COCKPIT_MODE: 'live', META_AD_ACCOUNT_ID: '333', META_ACCESS_TOKEN: 'synthetic' } as NodeJS.ProcessEnv;
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname !== 'graph.facebook.com') assert.fail('requête externe inattendue');
    if (url.pathname.endsWith('/insights')) return new Response(JSON.stringify({ data: ['2026-09-10', '2026-09-11'].flatMap(day => ['41', '42'].map(ad => ({ account_id: '333', ad_id: ad, ad_name: 'Synthetic', campaign_id: 'c-1', date_start: day, date_stop: day, spend: '1.25', impressions: '10' }))) }));
    return new Response(JSON.stringify({ account_id: '333', currency: 'EUR', timezone_name: 'Europe/Paris' }));
  };
  const first = await synchronizeMetaAds('2026-09-10', '2026-09-12', { db, env, fetcher });
  assert.equal(first.status, 'complete');const rows = await n('ad_daily', inNs('333'));assert.equal(rows, 4);
  const second = await synchronizeMetaAds('2026-09-10', '2026-09-12', { db, env, fetcher });
  assert.equal(second.status, 'complete');assert.equal(await n('ad_daily', inNs('333')), 4, 'aucune ligne de plus');
  const read = await view('333');assert.equal(read.length, 4, 'v_ad_daily lit les quatre lignes confirmées');
  assert.equal(read.every(row => row.sync_run_id === second.runId), true);
  assert.equal((await one('SELECT checkpoint->\'state\'->>\'confirmed\' AS c FROM sync_runs WHERE id=$1', [second.runId])).c, '4');
});

// ---------------------------------------------------------------------------------------------------------------
// Inscriptions (lead_entries_forms) : même contrat que tests/lead-entries.integration.ts.
type Claim = { runId: string; lease: string; checkpoint: { page: number }; busy?: boolean };
const claim = async (namespace = 'site-state') => (await one('SELECT cockpit_claim_lead_entries($1,$2,$3) r', [namespace, 'forms', 'synthetic-v1'])).r as Claim;
function lead(id: string = randomUUID(), at = '2026-06-01T10:00:00Z', updated = '2026-08-01T00:00:00Z', status = 'CONFIRMED') {
  const value = { source: 'wix', sourceNamespace: 'site-state', family: 'forms', externalId: id, containerId: 'synthetic-form', contactId: null, sourceStatus: status, identityKey: 'e'.repeat(64), occurredAt: at, sourceUpdatedAt: updated, eligible: true, properties: { dateBasis: 'submission_created' } };
  const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return { ...value, payloadHash: hash, sourcePayloadHash: hash };
}
const stage = async (c: Claim, rows: unknown[], done = true, page = 0) => (await one('SELECT cockpit_stage_lead_entries($1,$2,$3,$4,$5,$6,$7,0) r', [c.runId, c.lease, page, JSON.stringify(rows), done ? null : 'next', done, rows.length])).r;
const publishLeads = async (c: Claim) => (await one('SELECT cockpit_publish_lead_entries($1,$2) r', [c.runId, c.lease])).r;
async function collectLeads(rows: unknown[]) { const c = await claim();await stage(c, rows);return { c, result: await publishLeads(c) }; }

test('non-accumulation inscriptions (lead_entries_forms) : identique, modifié, nouveau, absent, rejeu, interruption', async () => {
  const flow = 'lead_entries_forms', scope = "source_namespace='site-state'", total = () => n('lead_source_observations', scope);
  const current = async () => (await sql.query(`SELECT external_id, source_status, id FROM lead_source_observations WHERE ${scope} AND is_current ORDER BY external_id`)).rows;
  const a = lead('lead-a'), b = lead('lead-b');
  await collectLeads([a, b]);assert.equal(await total(), 2);note(flow, 'première collecte', 0, 2);
  // 1. Identique : aucune observation insérée, comptée « inchangée ».
  const reference = await current(), journal = await n('sync_runs', "stream_key='lead_entries_forms' AND source_namespace='site-state'");
  const same = await collectLeads([a, b]);
  assert.equal(await total(), 2);assert.deepEqual(await current(), reference);
  assert.equal(same.result.status, 'complete');assert.equal(same.result.counts.unchanged, 2);assert.equal(same.result.counts.unchangedSkipped, 2);assert.equal(same.result.counts.changed, 0);
  assert.equal(await n('sync_runs', "stream_key='lead_entries_forms' AND source_namespace='site-state'"), journal + 1);
  note(flow, 'collecte identique', 2, await total(), '(sync_runs +1)');
  // 2. Modifiée (nouvelle version source) : règle inchangée des inscriptions, une version d'audit de plus, une seule courante.
  const bChanged = lead('lead-b', '2026-06-01T10:00:00Z', '2026-08-02T00:00:00Z', 'CANCELED');
  const changed = await collectLeads([a, bChanged]);
  assert.equal(changed.result.counts.changed, 1);assert.equal(changed.result.counts.unchangedSkipped, 1);assert.equal(await total(), 3);
  assert.equal((await current()).length, 2);assert.equal((await current()).find(row => row.external_id === 'lead-b')?.source_status, 'CANCELED');
  note(flow, 'valeur modifiée', 2, await total(), '(nouvelle version d’audit, ancienne non courante : règle 009 inchangée)');
  // 3. Nouvel objet.
  await collectLeads([a, bChanged, lead('lead-c')]);assert.equal(await total(), 4);note(flow, 'nouvel objet', 3, 4);
  // 4. Absent d'une lecture par delta : rien n'est retiré ni effacé (une absence n'est pas une suppression).
  const partial = await collectLeads([a]);assert.equal(partial.result.status, 'complete');assert.equal(await total(), 4);assert.equal((await current()).length, 3);
  note(flow, 'objet absent du delta', 4, await total(), '(aucun retrait : lecture par delta)');
  // 5. Rejeu de la publication (accusé perdu) : refusée (55000), aucun changement.
  const snapshot = await current();
  await assert.rejects(publishLeads(partial.c), { code: '55000' });
  assert.deepEqual(await current(), snapshot);assert.equal(await total(), 4);
  note(flow, 'rejeu de publication', 4, await total());
  // 6. Interrompue avant publication : page préparée invisible ; bail expiré, reprise de la même tentative.
  const pending = await claim();await stage(pending, [lead('lead-d')], false, 0);
  assert.deepEqual(await current(), snapshot, 'observation préparée non courante');
  await sql.query("UPDATE sync_runs SET lease_until=now()-interval '1 second' WHERE id=$1", [pending.runId]);
  const resumed = await claim();assert.equal(resumed.runId, pending.runId);assert.equal(resumed.checkpoint.page, 1);
  await stage(resumed, [], true, 1);assert.equal((await publishLeads(resumed)).status, 'complete');
  assert.equal(await total(), 5);assert.equal((await current()).length, 4);
  note(flow, 'tentative interrompue', 4, 5, '(la reprise publie la page préparée : un nouvel objet)');
  console.log('STATE_REPORT ' + JSON.stringify(report));
});

// ---------------------------------------------------------------------------------------------------------------
// Migration 019 : nettoyage borné de la zone de préparation, indépendant de toute publication réussie (réserve Codex 2).
// Horloge : la migration 18 est datée de 10 jours ; « avant 018 » = tentatives datées de 12 jours ; « plus de 24 h » = 25 h.
const MIGRATION_019 = fs.readFileSync('supabase/migrations/019_bounded_staging_cleanup.sql', 'utf8');
const cleanup = async (limit?: number) => (await one(`SELECT cockpit_cleanup_staged(${limit === undefined ? '' : 'p_limit=>$1'}) AS r`, limit === undefined ? [] : [limit])).r as Record<string, number>;
const age = (runs: string[], interval: string) => sql.query(`UPDATE sync_runs SET started_at=started_at-interval '${interval}', finished_at=finished_at-interval '${interval}' WHERE id=ANY($1)`, [runs]);
const cleanupReport: Record<string, Record<string, unknown>> = {};
function leadIn(ns: string, id: string, updated = '2026-08-01T00:00:00Z') {
  const value = { source: 'wix', sourceNamespace: ns, family: 'forms', externalId: id, containerId: 'synthetic-form', contactId: null, sourceStatus: 'CONFIRMED', identityKey: null, occurredAt: '2026-06-01T10:00:00Z', sourceUpdatedAt: updated, eligible: true, properties: { dateBasis: 'submission_created' } };
  const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return { ...value, payloadHash: hash, sourcePayloadHash: hash };
}
const claimAs = async (ns: string, profile: string) => (await one('SELECT cockpit_claim_lead_entries($1,$2,$3) r', [ns, 'forms', profile])).r as Claim;
/** Tentative d'inscriptions laissée en échec avec une observation jamais publiée : bail expiré puis changement de profil (009). */
async function failedLeadRun(ns: string, id: string) {
  const c = await claimAs(ns, 'cleanup-v1');await stage(c, [leadIn(ns, id)], false, 0);
  await sql.query("UPDATE sync_runs SET lease_until=now()-interval '1 second' WHERE id=$1", [c.runId]);
  const next = await claimAs(ns, 'cleanup-v2');
  assert.equal((await one('SELECT status, error_code FROM sync_runs WHERE id=$1', [c.runId])).error_code, 'superseded_profile');
  return { failed: c.runId, running: next };
}

test('migration 019 : lignes préparées des tentatives failed et partial de plus de 24 h supprimées, au plus p_limit par table ; complete, courantes, publiées, en cours et antérieures à 018 intactes', async () => {
  await sql.query(MIGRATION_019);
  await sql.query("UPDATE cockpit_migrations SET applied_at=now()-interval '10 days' WHERE version=18");
  const ns = '444', from = '2026-09-10', to = '2026-09-12', window = days(from, 2);
  const records = (spend: number) => window.flatMap(d => [adRow(ns, '1', d, spend), adRow(ns, '2', d, spend)]);
  // Antérieure à 018 : tentative en échec, datée de 12 jours (commencée avant l'application de 018) APRÈS la publication
  // d'état ci-dessous : le nettoyage propre à 018 (à chaque publication, tentatives failed de plus de 24 h du même flux, sans
  // condition sur la date de 018) l'aurait sinon supprimée ; ce test isole la règle de 019 (voir livraison U4c, section 6).
  const legacyFailed = await legacyMeta(ns, from, to, records(1), 'failed');
  // Publication d'état (lignes courantes) puis tentative complète de l'ancien chemin (lignes non courantes d'une tentative complete).
  const published = await publishMeta(ns, from, to, records(100));await age([legacyFailed], '12 days');
  const legacyComplete = await legacyMeta(ns, from, to, records(100), 'complete');await age([legacyComplete], '2 days');
  // Lecture incomplète (20 pages atteintes) : clôture « partial », jamais reprise ; puis une tentative « failed ».
  const partial = await begin(ns, from, to);await importPage(partial, records(7));
  await sql.query("SELECT finish_sync($1,'partial',4,0,false,'PAGE_LIMIT_REACHED')", [partial]);
  const failed = await legacyMeta(ns, from, to, records(8), 'failed');
  await age([partial, failed], '25 hours');
  const recent = await legacyMeta(ns, from, to, records(9), 'failed');
  // Inscriptions : une observation jamais publiée d'une tentative en échec (plus de 24 h), une d'une tentative en cours,
  // les observations publiées et courantes ; une observation antérieure à 018.
  // Publiées : deux observations, puis une modification réelle de kept-b (version d'audit publiée, non courante) ; datées de 2 jours.
  const site = 'site-cleanup';const c = await claimAs(site, 'cleanup-v1');await stage(c, [leadIn(site, 'kept-a'), leadIn(site, 'kept-b')]);await publishLeads(c);
  const c2 = await claimAs(site, 'cleanup-v1');await stage(c2, [leadIn(site, 'kept-b', '2026-08-02T00:00:00Z')]);await publishLeads(c2);
  await age([c.runId, c2.runId], '2 days');
  const leads = await failedLeadRun(site, 'staged-failed');await stage(leads.running, [leadIn(site, 'staged-running')], false, 0);
  await age([leads.failed], '25 hours');
  const old = await failedLeadRun('site-before-018', 'staged-old');await age([old.failed], '12 days');
  const byRun = async (table: string, column: string, run: string) => n(table, `${column}=$1`, [run]);
  const snapshot = async () => ({
    ad: { legacyFailed: await byRun('ad_daily', 'sync_run_id', legacyFailed), current: await n('ad_daily', `is_current AND ${inNs(ns)}`), legacyComplete: await byRun('ad_daily', 'sync_run_id', legacyComplete), partial: await byRun('ad_daily', 'sync_run_id', partial), failed: await byRun('ad_daily', 'sync_run_id', failed), recent: await byRun('ad_daily', 'sync_run_id', recent) },
    conversions: { partial: await byRun('meta_conversions_daily', 'sync_run_id', partial), failed: await byRun('meta_conversions_daily', 'sync_run_id', failed), others: await n('meta_conversions_daily', `sync_run_id<>ALL($1) AND ${inNs(ns)}`, [[partial, failed]]) },
    leads: { published: await n('lead_source_observations', `source_namespace=$1 AND published_at IS NOT NULL`, [site]), publishedNotCurrent: await n('lead_source_observations', `source_namespace=$1 AND published_at IS NOT NULL AND NOT is_current`, [site]), failed: await byRun('lead_source_observations', 'run_id', leads.failed), running: await byRun('lead_source_observations', 'run_id', leads.running.runId), before018: await byRun('lead_source_observations', 'run_id', old.failed) },
  });
  const before = await snapshot();
  assert.deepEqual(before.ad, { legacyFailed: 4, current: 4, legacyComplete: 4, partial: 4, failed: 4, recent: 4 });
  assert.deepEqual(before.leads, { published: 3, publishedNotCurrent: 1, failed: 1, running: 1, before018: 1 });
  const currentIds = (await sql.query(`SELECT id, spend_minor FROM ad_daily WHERE is_current AND ${inNs(ns)} ORDER BY id`)).rows, readBefore = await view(ns), conversionsBefore = await conversionsView(ns);
  // Borne par table et par appel : 8 lignes éligibles par table Meta, 5 supprimées au premier appel, 3 au suivant.
  const first = await cleanup(5);
  assert.deepEqual(first, { source_aggregates: 0, ad_daily: 5, meta_conversions_daily: 5, lead_source_observations: 1 });
  const second = await cleanup();
  assert.deepEqual(second, { source_aggregates: 0, ad_daily: 3, meta_conversions_daily: 3, lead_source_observations: 0 });
  assert.deepEqual(await cleanup(), { source_aggregates: 0, ad_daily: 0, meta_conversions_daily: 0, lead_source_observations: 0 }, 'rejouable : plus rien d’éligible');
  const after = await snapshot();
  assert.deepEqual(after.ad, { ...before.ad, partial: 0, failed: 0 }, 'seules les tentatives partial et failed de plus de 24 h, commencées après 018');
  assert.deepEqual(after.conversions, { ...before.conversions, partial: 0, failed: 0 });
  assert.deepEqual(after.leads, { ...before.leads, failed: 0 }, 'publiées, en cours et antérieures à 018 intactes');
  assert.deepEqual((await sql.query(`SELECT id, spend_minor FROM ad_daily WHERE is_current AND ${inNs(ns)} ORDER BY id`)).rows, currentIds, 'lignes courantes intactes');
  assert.deepStrictEqual(await view(ns), readBefore, 'v_ad_daily inchangée');assert.deepStrictEqual(await conversionsView(ns), conversionsBefore, 'v_meta_conversions_daily inchangée');
  assert.ok(published.run);
  await assert.rejects(cleanup(0), { code: '23514' });await assert.rejects(cleanup(5001), { code: '23514' });
  cleanupReport.meta_leads = { before, after, calls: [first, second] };
});

test('migration 019 : pannes répétées sans aucune publication réussie, passages réels du tick ; lignes préparées bornées à la dernière tentative de moins de 24 h', async () => {
  const pdb = postgresDatabase(target.href), env = { COCKPIT_MODE: 'live', META_AD_ACCOUNT_ID: 'kpi-cleanup', META_ACCESS_TOKEN: 'synthetic' } as unknown as NodeJS.ProcessEnv;
  const ns = 'kpi-cleanup', from = '2026-09-10', to = '2026-09-13';
  const batch = (value: number): KpiSourceBatch => ({ from, to, observedAt: '2026-09-13T08:00:00Z', rows: days(from, 3).flatMap(day => [{ day, key: 'c1', data: { spend: value } }, { day, key: 'c2', data: { spend: value } }]) });
  // Publication impossible (panne en fin de tentative) : les 9 lignes préparées restent, la tentative passe « failed ».
  const failing = (db: Database): Database => ({ ...db, rpc: async <T,>(fn: string, args: Row) => { if (fn === 'cockpit_publish_aggregate_state') throw new Error('panne synthétique'); return db.rpc<T>(fn, args); } });
  const staged = () => n('source_aggregates', `source_namespace=$1 AND NOT is_current`, [ns]);
  const after018 = () => n('source_aggregates', `source_namespace=$1 AND NOT is_current AND sync_run_id IN (SELECT id FROM sync_runs WHERE started_at>=(SELECT applied_at FROM cockpit_migrations WHERE version=18))`, [ns]);
  const current = () => sql.query(`SELECT id, value, dimensions FROM source_aggregates WHERE source_namespace=$1 AND is_current ORDER BY id`, [ns]).then(r => r.rows);
  // État de départ : une publication réussie (9 lignes courantes, datée de 2 jours), une tentative en échec antérieure à 018.
  const ok = await syncKpiSource(pdb, 'meta', ns, from, to, async () => batch(1));await age([ok.runId], '2 days');
  await assert.rejects(syncKpiSource(failing(pdb), 'meta', ns, from, to, async () => batch(2)));
  const oldRun = (await one(`SELECT id FROM sync_runs WHERE source_namespace=$1 AND status='failed'`, [ns])).id;await age([oldRun], '12 days');
  const reference = await current();assert.equal(reference.length, 9);
  let pass = 0;const passes: Record<string, unknown>[] = [];
  const tick = async () => {
    pass++;const summary = await tickSyncJobs(pdb, env, { sharedLease: databaseTickLease(pdb), now: () => Date.now() + 20 * 60_000, budget: { sourceFetch: async () => assert.fail('aucune lecture source'), canStart: () => true, dispose: () => {} },
      execute: async (job: SyncJob, ctx) => job === 'kpi_meta' ? syncKpiSource(failing(ctx.db), 'meta', ns, from, to, async () => batch(10 + pass)) : { status: 'complete' } });
    assert.equal(summary.lock?.kind, 'shared');assert.deepEqual(summary.unitResults.find(unit => unit.job === 'kpi_meta'), { job: 'kpi_meta', status: 'failed' });
    const row = { pass, deleted: (summary.cleanup as { deleted: Record<string, number> }).deleted.source_aggregates, stagedAfter018: await after018(), stagedTotal: await staged(), current: (await current()).length };
    passes.push(row);return row;
  };
  const failedRuns = async () => (await sql.query(`SELECT id FROM sync_runs WHERE source_namespace=$1 AND status='failed' AND id<>$2 ORDER BY started_at`, [ns, oldRun])).rows.map(r => r.id as string);
  // Trois pannes consécutives dans la journée : rien n'a 24 h, rien n'est supprimé ; 27 lignes préparées (+ 9 antérieures à 018).
  for (let i = 0; i < 3; i++) assert.equal((await tick()).deleted, 0);
  assert.equal(await after018(), 27);assert.equal(await staged(), 36);
  // 25 heures plus tard, toujours aucune publication réussie : le passage suivant échoue encore et supprime les 27 lignes.
  await age(await failedRuns(), '25 hours');
  const fourth = await tick();
  assert.equal(fourth.deleted, 27);assert.equal(fourth.stagedAfter018, 9, 'bornées aux lignes de la dernière tentative en échec de moins de 24 h');
  assert.equal(await staged(), 9 + 9, 'les 9 lignes antérieures à 018 restent');
  // Encore deux pannes puis 25 heures : même borne, indépendante du nombre de pannes.
  await tick();await tick();await age(await failedRuns(), '25 hours');
  const seventh = await tick();assert.equal(seventh.deleted, 27);assert.equal(seventh.stagedAfter018, 9);
  assert.deepEqual(await current(), reference, 'lignes courantes de la dernière publication réussie intactes');
  assert.equal(await n('sync_runs', `source_namespace=$1 AND status='failed'`, [ns]), 8, 'le journal garde toutes les tentatives (aucune purge de sync_runs)');
  cleanupReport.kpi_tick = { passes };
});

test('migration 019 : droits service_role seulement, fonction rejouable, une inscription', async () => {
  for (const role of ['anon', 'authenticated']) assert.equal((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS ok', [role, 'public.cockpit_cleanup_staged(integer)'])).ok, false, role);
  assert.equal((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS ok', ['service_role', 'public.cockpit_cleanup_staged(integer)'])).ok, true);
  await sql.query(MIGRATION_019);await sql.query(MIGRATION_019);
  assert.equal(await n('cockpit_migrations', 'version=19'), 1);
  for (const role of ['anon', 'authenticated']) {
    await sql.query('BEGIN');
    try { await sql.query(`SET LOCAL ROLE ${role}`);await assert.rejects(sql.query('SELECT cockpit_cleanup_staged()'), { code: '42501' }); } finally { await sql.query('ROLLBACK'); }
  }
  console.log('CLEANUP_REPORT ' + JSON.stringify(cleanupReport));
});
