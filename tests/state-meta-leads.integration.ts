import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { postgresDatabase } from '../src/lib/db';
import { synchronizeMetaAds } from '../src/lib/sync';

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
