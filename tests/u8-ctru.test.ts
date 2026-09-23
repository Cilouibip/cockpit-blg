import test from 'node:test';
import assert from 'node:assert/strict';
import { readKpiMeta, kpiWindows, kpiCampaignSetKey, kpiAccountRowKey, KPI_MASTERCLASS_CAMPAIGNS } from '../src/connectors/kpi-meta';
import { readKpiWindows, syncKpiSource, type KpiSourceBatch } from '../src/lib/kpi-source-store';
import { readLiveKpiFunnel } from '../src/lib/kpi-funnel-live';
import { kpiFunnelCsv } from '../src/lib/kpi-funnel-export';
import { kpiFunnelSnapshotSchema } from '../src/lib/kpi-funnel-contract';
import { memoryKpiDatabase } from './helpers/kpi-memory';
import type { DashboardFilters } from '../src/lib/ui-contract';
import type { Row } from '../src/lib/db';

// U8b étape B · CTRU (CTR unique Meta) : lecture niveau compte par jour et lectures de fenêtre, doublées par un faux fetch.
// Aucune lecture Meta réelle ; valeurs synthétiques (ni l'Excel de démonstration, ni des résultats BLG).
const [A, B, C] = [...KPI_MASTERCLASS_CAMPAIGNS].sort();
const FROM = '2026-08-22', TO = '2026-09-27', TODAY = '2026-09-26', OBSERVED = '2026-09-26T15:00:00Z', NOW = '2026-09-26T16:00:00Z';
const days = ['2026-09-20','2026-09-21','2026-09-22','2026-09-23','2026-09-24','2026-09-25','2026-09-26'];
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', META_AD_ACCOUNT_ID: 'act_123', META_ACCESS_TOKEN: 'synthetic-token' };
const liveEnv: NodeJS.ProcessEnv = { NODE_ENV: 'test', META_AD_ACCOUNT_ID: '123' };
const filters = (from: string, to: string, campaign = ''): DashboardFilters => ({ from, to, source: 'all', tunnel: 'masterclass', campaign, compare: false });
// Par jour d (0..6) : deux campagnes actives ; comptes uniques du niveau compte (dédoublonnés) < somme des campagnes.
const campaignRow = (day: string, d: number, id: string) => id === A
  ? { account_id: '123', campaign_id: A, date_start: day, date_stop: day, spend: '30.00', impressions: '1000', reach: '800', inline_link_clicks: '30', unique_inline_link_clicks: '25', outbound_clicks: [{ action_type: 'outbound_click', value: String(20 + d) }], actions: [] }
  : { account_id: '123', campaign_id: B, date_start: day, date_stop: day, spend: '10.00', impressions: '500', reach: '450', inline_link_clicks: '10', unique_inline_link_clicks: '9', outbound_clicks: [{ action_type: 'outbound_click', value: '7' }], actions: [] };
const accountRow = (day: string, d: number) => ({ account_id: '123', date_start: day, date_stop: day, reach: String(1100 + 50 * d), impressions: '1500', inline_link_clicks: '40', unique_inline_link_clicks: String(32 + d), outbound_clicks: [{ action_type: 'outbound_click', value: String(27 + d) }] });
// Fenêtres : comptes touchés sur toute la fenêtre (une personne vue trois jours compte une fois), jamais la somme des jours.
const windowValues: Record<string, { reach: number; unique: number }> = { '2026-09-24|2026-09-26': { reach: 2900, unique: 90 }, '2026-09-20|2026-09-26': { reach: 5200, unique: 190 }, '2026-08-28|2026-09-26': { reach: 9000, unique: 400 }, '2026-09-23|2026-09-25': { reach: 2800, unique: 88 }, '2026-09-19|2026-09-25': { reach: 5000, unique: 180 }, '2026-08-27|2026-09-25': { reach: 8900, unique: 395 } };

function fakeMeta(options: { windowDateStop?: string; latencyMs?: number } = {}) {
  const urls: URL[] = [];
  const fetcher = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input)); urls.push(url);
    if (options.latencyMs) await new Promise(resolve => setTimeout(resolve, options.latencyMs));
    if (!url.pathname.endsWith('/insights')) return new Response(JSON.stringify({ account_id: '123', currency: 'EUR', timezone_name: 'Europe/Paris' }));
    const range = JSON.parse(url.searchParams.get('time_range')!) as { since: string; until: string };
    if (url.searchParams.get('level') === 'campaign') return new Response(JSON.stringify({ data: days.flatMap((day, d) => [campaignRow(day, d, A), campaignRow(day, d, B)]) }));
    if (url.searchParams.get('time_increment') === '1') return new Response(JSON.stringify({ data: days.map((day, d) => accountRow(day, d)) }));
    const value = windowValues[`${range.since}|${range.until}`];
    return new Response(JSON.stringify({ data: value ? [{ account_id: '123', date_start: range.since, date_stop: options.windowDateStop ?? range.until, reach: String(value.reach), impressions: '99999', inline_link_clicks: '999', unique_inline_link_clicks: String(value.unique), outbound_clicks: [{ action_type: 'outbound_click', value: '500' }] }] : [] }));
  }) as typeof fetch;
  return { urls, fetcher };
}
async function published(batch: KpiSourceBatch, observedAt = OBSERVED) {
  const memory = memoryKpiDatabase({}, () => observedAt);
  await syncKpiSource(memory.db, 'meta', '123', FROM, TO, async () => ({ ...batch, observedAt }));
  return memory;
}
async function snapshot(memory: ReturnType<typeof memoryKpiDatabase>, f: DashboardFilters) {
  const response = await readLiveKpiFunnel(memory.db, f, { env: liveEnv, now: NOW });
  assert.equal(response.status, 'ready'); if (response.status !== 'ready') throw Error('not ready');
  return response.snapshot;
}

test('U8b Meta : campagne × jour inchangée, lecture compte par jour filtrée sur les campagnes Masterclass, six fenêtres (7 lectures de plus)', async () => {
  const { urls, fetcher } = fakeMeta();
  const batch = await readKpiMeta(FROM, TO, env, fetcher);
  assert.equal(urls.length, 9, 'identité du compte + campagne × jour + compte × jour + six fenêtres (avant U8b : 2)');
  const campaign = urls.find(u => u.searchParams.get('level') === 'campaign')!;
  assert.equal(campaign.searchParams.get('fields'), 'account_id,campaign_id,campaign_name,date_start,date_stop,spend,impressions,inline_link_clicks,unique_inline_link_clicks,actions', 'requête campagne × jour identique à celle d’avant U8b');
  const accountCalls = urls.filter(u => u.searchParams.get('level') === 'account');
  assert.equal(accountCalls.length, 7);
  for (const url of accountCalls) {
    assert.deepEqual(JSON.parse(url.searchParams.get('filtering')!), [{ field: 'campaign.id', operator: 'IN', value: [A, B, C] }], 'filtre sur les trois campagnes Masterclass');
    assert.ok(['reach', 'unique_inline_link_clicks', 'outbound_clicks', 'impressions'].every(field => url.searchParams.get('fields')!.split(',').includes(field)));
  }
  const [daily, ...windows] = accountCalls;
  assert.equal(daily.searchParams.get('time_increment'), '1');
  assert.deepEqual(JSON.parse(daily.searchParams.get('time_range')!), { since: FROM, until: TODAY });
  assert.ok(windows.every(url => url.searchParams.get('time_increment') === null), 'une fenêtre est lue entière, sans découpage par jour');
  assert.deepEqual(windows.map(url => JSON.parse(url.searchParams.get('time_range')!)), kpiWindows(FROM, TO));
  assert.deepEqual(kpiWindows(FROM, TO).map(w => `${w.since}→${w.until}`), ['2026-09-23→2026-09-25', '2026-09-19→2026-09-25', '2026-08-27→2026-09-25', '2026-09-24→2026-09-26', '2026-09-20→2026-09-26', '2026-08-28→2026-09-26'], '3, 7, 30 jours finissant hier puis aujourd’hui');
  const accountDay = batch.rows.find(r => r.day === '2026-09-22' && r.key === kpiAccountRowKey([A, B, C]))!;
  assert.deepEqual(accountDay.data, { level: 'account', campaignIds: [A, B, C], reach: 1200, impressions: 1500, link_clicks: 40, unique_link_clicks: 34, outbound_clicks: 29 });
  assert.equal(batch.rows.find(r => r.day === '2026-09-22' && r.key === A)!.data.reach, undefined, 'aucun champ nouveau sur la lecture campagne × jour');
  assert.deepEqual(batch.uniqueReads, { status: 'complete', failedWindows: [] });
  assert.equal(batch.windows?.length, 6);
  assert.deepEqual(batch.windows?.find(w => w.from === '2026-09-24')?.data?.reach, 2900);
  // Une fenêtre renvoyée sur d'autres dates est refusée (domaine d'échec séparé) : aucune fenêtre écrite, le passage reste publiable.
  const shifted = await readKpiMeta(FROM, TO, env, fakeMeta({ windowDateStop: '2026-09-22' }).fetcher);
  assert.equal(shifted.windows, undefined);assert.equal(shifted.uniqueReads.status, 'partial');
  assert.deepEqual(shifted.uniqueReads.failedWindows.map(w => w.error), Array(6).fill('KPI_META_WINDOW_SCOPE'));
});

test('U8b CTRU : par jour = comptes ayant cliqué / comptes touchés du niveau compte ; récapitulatif = lecture de la fenêtre, jamais une moyenne ni une somme', async () => {
  const batch = await readKpiMeta(FROM, TO, env, fakeMeta().fetcher);
  const data = await snapshot(await published(batch), filters(days[0], days[6]));
  assert.deepEqual(data.daily.map(d => d.meta_reach), days.map((_, d) => 1100 + 50 * d));
  assert.deepEqual(data.daily.map(d => d.ratios.ctru), days.map((_, d) => (32 + d) / (1100 + 50 * d)));
  assert.notEqual(data.daily[0].ratios.ctru, (25 + 9) / (800 + 450), 'jamais les uniques additionnés par campagne');
  const [global, three, seven] = data.summaries;
  assert.deepEqual([three.meta_reach, three.meta_unique_link_clicks, three.ratios.ctru], [2900, 90, 90 / 2900], 'lecture de la fenêtre 24→26');
  assert.deepEqual([seven.ratios.ctru, global.ratios.ctru], [190 / 5200, 190 / 5200], 'Global = 7 derniers jours = fenêtre 20→26');
  const lastThree = data.daily.slice(4);
  const mean = lastThree.reduce((n, d) => n + d.ratios.ctru!, 0) / 3, sumRatio = lastThree.reduce((n, d) => n + d.meta_unique_link_clicks!, 0) / lastThree.reduce((n, d) => n + d.meta_reach!, 0);
  assert.notEqual(three.ratios.ctru, mean, 'jamais la moyenne des CTRU quotidiens');
  assert.notEqual(three.ratios.ctru, sumRatio, 'jamais la somme des uniques sur la somme des comptes touchés');
  assert.notEqual(three.meta_reach, lastThree.reduce((n, d) => n + d.meta_reach!, 0), 'fenêtre ≠ somme des jours');
  for (const row of [...data.daily, ...data.summaries]) {
    assert.ok(row.meta_unique_link_clicks! <= row.link_clicks!, 'uniques ≤ clics lien');
    assert.ok(row.meta_reach! <= row.impressions!, 'comptes touchés ≤ impressions');
  }
  assert.equal(data.daily[2].ratios.outbound_click_rate, 29 / 1500, 'détail : clics sortants / impressions (somme des campagnes)');
  const coverage = data.coverage.find(c => c.field_group === 'Fenêtres Meta (CTR unique)')!;
  assert.equal(coverage.status, 'available'); assert.equal(coverage.through, OBSERVED);
  assert.match(coverage.reason!, /3, 7, 30 jours finissant le 25\/09\/2026 et le 26\/09\/2026/);
  // Le contrat refuse un CTRU de récapitulatif moyenné.
  const forged = structuredClone(data); forged.summaries[1].ratios.ctru = mean;
  assert.equal(kpiFunnelSnapshotSchema.safeParse(forged).success, false);
  // CSV : CTRU en pourcentage décimal, comptes touchés de la fenêtre dans le détail.
  const csv = kpiFunnelCsv(data).split('\r\n'), three_line = csv.find(line => line.startsWith('"3 derniers jours'))!.split(';');
  assert.equal(three_line[7], `"${String(Math.round(90 / 2900 * 10000) / 100).replace('.', ',')}"`);
});

test('U8b CTRU : fenêtre non lue, période sans fenêtre, campagne seule, lecture incohérente : non mesuré avec le motif', async () => {
  const batch = await readKpiMeta(FROM, TO, env, fakeMeta().fetcher);
  // Période du 21 au 26 : aucune fenêtre de six jours lue ; 3 et 7 derniers jours restent lus.
  const six = await snapshot(await published(batch), filters(days[1], days[6]));
  assert.equal(six.summaries[0].ratios.ctru, null);
  assert.equal(six.summaries[0].reasons.ctru, 'CTR unique non mesuré : fenêtre non lue à la source (jamais une moyenne ni une somme de jours) ; dernière fenêtre Meta lue le 26/09/2026 17:00.');
  assert.equal(six.summaries[1].ratios.ctru, 90 / 2900);
  assert.equal(six.summaries[2].within_period, false);
  // Sans lectures de fenêtre (lecteur antérieur) : récapitulatifs non mesurés, jours mesurés.
  const withoutWindows = await snapshot(await published({ ...batch, windows: undefined }), filters(days[0], days[6]));
  assert.ok(withoutWindows.summaries.every(s => s.ratios.ctru === null && /fenêtre non lue/.test(s.reasons.ctru)));
  assert.ok(withoutWindows.daily.every(d => d.ratios.ctru !== null));
  // Une seule campagne sélectionnée : les uniques ne sont lus que pour l'ensemble Masterclass (la lecture campagne × jour reste inchangée).
  const single = await snapshot(await published(batch), filters(days[0], days[6], `meta:${A}`));
  assert.ok(single.daily.every(d => d.ratios.ctru === null && d.reasons.ctru === 'CTR unique non mesuré : comptes touchés lus seulement pour l’ensemble des campagnes Masterclass.'));
  assert.ok(single.daily.every(d => d.spend_eur === 30), 'dépense de la campagne seule');
  assert.ok(single.summaries.every(s => s.ratios.ctru === null));
  // Lecture incohérente (comptes uniques > clics lien du jour) : non mesuré, jamais publié.
  const broken = structuredClone(batch); const row = broken.rows.find(r => r.day === '2026-09-22' && r.key.startsWith('account:'))!; row.data.unique_link_clicks = 41;
  const inconsistent = await snapshot(await published(broken), filters(days[0], days[6]));
  assert.equal(inconsistent.daily[2].ratios.ctru, null);
  assert.match(inconsistent.daily[2].reasons.ctru, /lecture Meta incohérente/);
  // Fenêtre 23→25 lue le 25/09 à 22:00 (Paris), avant la fin de son dernier jour, affichée le 26 : non couverte (D3).
  const early = await snapshot(await published(batch, '2026-09-25T20:00:00Z'), filters(days[0], days[5]));
  assert.equal(early.summaries[1].ratios.ctru, null);
  assert.equal(early.summaries[1].reasons.meta_reach, 'CTR unique non mesuré : la lecture de la fenêtre précède la fin de son dernier jour.');
});

test('U8b fenêtres : état courant par identifiant stable (double mémoire) ; collecte identique 6 → 6, valeur modifiée même id, rejeu, lendemain', async () => {
  const setKey = kpiCampaignSetKey([A, B, C]);
  let at = OBSERVED;
  const memory = memoryKpiDatabase({}, () => at);
  const windowRows = (value = 0, today = TODAY) => kpiWindows(FROM, nextDay(today)).map(w => ({ from: w.since, to: nextDay(w.until), key: setKey, data: { level: 'account', campaignIds: [A, B, C], reach: 1000 + value, impressions: 5000, link_clicks: 100, unique_link_clicks: 50, outbound_clicks: 40 } }));
  const collect = (value = 0, today = TODAY) => { const to = nextDay(today); return syncKpiSource(memory.db, 'meta', '123', FROM, to, async () => ({ from: FROM, to, observedAt: at, rows: [], windows: windowRows(value, today) })); };
  const windowTable = () => memory.get('source_aggregates').filter(r => String(r.metric_key).startsWith('kpi_window_'));
  await collect();
  assert.equal(windowTable().filter(r => r.metric_key === 'kpi_window_row').length, 6);
  const ids = windowTable().map(r => r.id).sort();
  at = '2026-09-26T15:30:00Z'; await collect();
  assert.equal(windowTable().filter(r => r.metric_key === 'kpi_window_row').length, 6, 'collecte identique : 6 → 6');
  assert.deepEqual(windowTable().map(r => r.id).sort(), ids, 'mêmes lignes');
  at = '2026-09-26T16:00:00Z'; const changed = await collect(7);
  assert.deepEqual(windowTable().map(r => r.id).sort(), ids, 'valeur modifiée : même identifiant');
  assert.ok(windowTable().filter(r => r.metric_key === 'kpi_window_row').every(r => (r.dimensions as Row & { data: Row }).data.reach === 1007));
  const before = structuredClone(windowTable());
  const replay = await memory.db.rpc<{ duplicate: boolean }>('cockpit_publish_aggregate_state', { p_run: changed.runId, p_metric_keys: '{kpi_daily_row,kpi_daily_manifest,kpi_window_row,kpi_window_manifest}', p_read: 6 });
  assert.equal(replay.duplicate, true); assert.deepEqual(windowTable(), before, 'rejeu : aucun changement');
  const read = await readKpiWindows(memory.db, 'meta', '123');
  assert.equal(read.size, 6); assert.equal(read.get(`2026-09-24|2026-09-27|${setKey}`)?.data?.reach, 1007);
  // Lendemain : les fenêtres « finissant hier » sont celles lues la veille « finissant aujourd’hui » (mêmes lignes) ; trois nouvelles ; trois retirées, conservées.
  at = '2026-09-27T09:00:00Z'; await collect(7, '2026-09-27');
  assert.equal(windowTable().filter(r => r.metric_key === 'kpi_window_row').length, 9);
  assert.equal(windowTable().filter(r => r.metric_key === 'kpi_window_row' && r.is_current).length, 6);
  assert.equal(windowTable().filter(r => r.metric_key === 'kpi_window_row' && !r.is_current).length, 3, 'retirées, jamais effacées');
});

const nextDay = (day: string) => new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

// Complément U8b : les lectures d'uniques (compte × jour, fenêtres) forment un domaine d'échec séparé de la lecture campagne × jour.
function failing(options: { account?: number; window?: string; campaign?: number } = {}) {
  const base = fakeMeta(), urls: URL[] = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input)); urls.push(url);
    const range = url.searchParams.get('time_range') ? JSON.parse(url.searchParams.get('time_range')!) as { since: string; until: string } : null;
    if (options.campaign && url.searchParams.get('level') === 'campaign') return new Response('{"error":{"message":"refus synthétique"}}', { status: options.campaign });
    if (options.account && url.searchParams.get('level') === 'account' && url.searchParams.get('time_increment') === '1') return new Response('{"error":{"message":"(#100) param refusé"}}', { status: options.account });
    if (options.window && url.searchParams.get('level') === 'account' && !url.searchParams.get('time_increment') && `${range!.since}|${range!.until}` === options.window) throw new DOMException('délai dépassé', 'TimeoutError');
    return base.fetcher(input, init);
  }) as typeof fetch;
  return { urls, fetcher };
}
const windowState = (memory: ReturnType<typeof memoryKpiDatabase>) => memory.get('source_aggregates').filter(r => String(r.metric_key).startsWith('kpi_window_')).map(r => ({ id: r.id, metric: r.metric_key, current: r.is_current, run: r.sync_run_id, dimensions: structuredClone(r.dimensions) }));

test('U8b échec isolé (a) : lecture niveau compte en échec → passage publié, dépense et impressions présentes, CTRU du jour non mesuré avec le code, aucune fenêtre écrite, fenêtres précédentes intactes', async () => {
  let at = '2026-09-26T14:30:00Z';
  const memory = memoryKpiDatabase({}, () => at);
  await syncKpiSource(memory.db, 'meta', '123', FROM, TO, async () => ({ ...(await readKpiMeta(FROM, TO, env, fakeMeta().fetcher)), observedAt: at }));
  const before = windowState(memory);
  assert.equal(before.filter(r => r.metric === 'kpi_window_row').length, 6);
  at = OBSERVED;
  const { urls, fetcher } = failing({ account: 400 });
  const batch = await readKpiMeta(FROM, TO, env, fetcher);
  assert.deepEqual(batch.uniqueReads, { status: 'failed', error: 'UPSTREAM_HTTP_ERROR (HTTP 400)', failedWindows: [] });
  assert.equal(urls.length, 3, 'identité + campagne × jour + compte × jour refusée ; aucune lecture de fenêtre');
  assert.equal(batch.windows, undefined);
  const result = await syncKpiSource(memory.db, 'meta', '123', FROM, TO, async () => ({ ...batch, observedAt: at }));
  assert.equal(result.status, 'complete', 'le passage est publié');
  assert.deepEqual(windowState(memory), before, 'lignes de fenêtre précédentes intactes (mêmes lignes, mêmes valeurs, même datation)');
  const data = await snapshot(memory, filters(days[0], days[6]));
  assert.deepEqual(data.daily.map(d => d.spend_eur), days.map(() => 40));
  assert.deepEqual(data.daily.map(d => d.impressions), days.map(() => 1500));
  assert.equal(data.coverage.find(c => c.field_group === 'Diffusion Meta')?.through, OBSERVED, 'la dépense est datée du passage en cours');
  for (const day of data.daily) {
    assert.deepEqual([day.meta_reach, day.meta_unique_link_clicks, day.outbound_clicks, day.ratios.ctru], [null, null, null, null]);
    assert.equal(day.reasons.ctru, 'Non mesuré : lecture des uniques Meta en échec (UPSTREAM_HTTP_ERROR (HTTP 400)).');
  }
  assert.ok(data.summaries.every(s => s.ratios.ctru === null && s.reasons.ctru === 'CTR unique non mesuré : fenêtre non lue à la source (lecture des uniques Meta en échec, UPSTREAM_HTTP_ERROR (HTTP 400)) ; dernière fenêtre Meta lue le 26/09/2026 16:30.'));
  assert.match(data.coverage.find(c => c.field_group === 'Fenêtres Meta (CTR unique)')!.detail!, /^Dernière lecture des uniques Meta en échec \(UPSTREAM_HTTP_ERROR \(HTTP 400\)\)/);
  const text = JSON.stringify(data);
  assert.ok(!text.includes('graph.facebook') && !text.includes('synthetic-token') && !text.includes('param refusé'), 'ni URL, ni jeton, ni message de Meta');
});

test('U8b échec isolé (b) : une fenêtre sur six en échec → les cinq autres écrites et courantes, la sixième absente avec motif', async () => {
  let at = '2026-09-26T14:30:00Z';
  const memory = memoryKpiDatabase({}, () => at);
  await syncKpiSource(memory.db, 'meta', '123', FROM, TO, async () => ({ ...(await readKpiMeta(FROM, TO, env, fakeMeta().fetcher)), observedAt: at }));
  at = OBSERVED;
  const batch = await readKpiMeta(FROM, TO, env, failing({ window: '2026-09-24|2026-09-26' }).fetcher);
  assert.equal(batch.uniqueReads.status, 'partial');
  assert.deepEqual(batch.uniqueReads.failedWindows, [{ from: '2026-09-24', to: '2026-09-27', error: 'NETWORK_ERROR' }], 'délai dépassé : code sûr');
  assert.equal(batch.windows?.length, 5);
  await syncKpiSource(memory.db, 'meta', '123', FROM, TO, async () => ({ ...batch, observedAt: at }));
  const current = await readKpiWindows(memory.db, 'meta', '123');
  assert.equal(current.size, 5, 'cinq fenêtres courantes');
  assert.ok([...current.values()].every(w => w.observedAt === OBSERVED), 'écrites par ce passage');
  assert.equal([...current.keys()].some(id => id.startsWith('2026-09-24|2026-09-27|')), false, 'la sixième est absente de l’état courant (retirée, conservée)');
  assert.equal(memory.get('source_aggregates').filter(r => r.metric_key === 'kpi_window_row' && !r.is_current && (r.dimensions as Row).from === '2026-09-24').length, 1);
  const data = await snapshot(memory, filters(days[0], days[6]));
  assert.equal(data.summaries[1].ratios.ctru, null);
  assert.equal(data.summaries[1].reasons.ctru, 'CTR unique non mesuré : fenêtre non lue à la source (jamais une moyenne ni une somme de jours) ; dernière fenêtre Meta lue le 26/09/2026 17:00.');
  assert.equal(data.summaries[2].ratios.ctru, 190 / 5200, 'les autres fenêtres restent lues');
  assert.ok(data.daily.every(d => d.ratios.ctru !== null), 'la lecture compte × jour a réussi');
});

test('U8b échec isolé (c) : lecture campagne × jour en échec → passage en échec, rien de publié (règle existante)', async () => {
  let at = '2026-09-26T14:30:00Z';
  const memory = memoryKpiDatabase({}, () => at);
  await syncKpiSource(memory.db, 'meta', '123', FROM, TO, async () => ({ ...(await readKpiMeta(FROM, TO, env, fakeMeta().fetcher)), observedAt: at }));
  const rowsBefore = structuredClone(memory.get('source_aggregates'));
  at = OBSERVED;
  const { urls, fetcher } = failing({ campaign: 500 });
  await assert.rejects(syncKpiSource(memory.db, 'meta', '123', FROM, TO, () => readKpiMeta(FROM, TO, env, fetcher)), /UPSTREAM_HTTP_ERROR/);
  assert.equal(urls.length, 2, 'aucune lecture d’uniques après l’échec de la lecture campagne × jour');
  assert.deepEqual(memory.get('source_aggregates'), rowsBefore, 'rien de publié ni de modifié');
  assert.equal(memory.get('sync_runs').at(-1)?.status, 'failed');
  const data = await snapshot(memory, filters(days[0], days[6]));
  assert.equal(data.coverage.find(c => c.field_group === 'Diffusion Meta')?.through, '2026-09-26T14:30:00Z', 'dernière publication conservée');
});
