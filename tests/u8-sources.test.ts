import test from 'node:test';
import assert from 'node:assert/strict';
import { syncKpiSource } from '../src/lib/kpi-source-store';
import { KPI_MASTERCLASS_CAMPAIGNS, readLiveKpiFunnel } from '../src/lib/kpi-funnel-live';
import { readKpiMeta } from '../src/connectors/kpi-meta';
import { kpiBookingQuery } from '../src/connectors/journey-analytics';
import { memoryKpiDatabase } from './helpers/kpi-memory';
import type { DashboardFilters } from '../src/lib/ui-contract';

// U8 · colonnes Meta, clics bilan PostHog et détail par annonce. Données synthétiques uniquement :
// seuls les identifiants de campagne et d'annonce Meta déjà présents dans le code sont repris.
const from = '2026-09-20', to = '2026-09-22', observedAt = '2026-09-22T10:00:00Z', now = '2026-09-22T10:30:00Z';
const account = 'synthetic-account', project = '424242';
const filters: DashboardFilters = { from, to: '2026-09-21', source: 'all', tunnel: 'masterclass', campaign: '', compare: false };
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', META_AD_ACCOUNT_ID: account, POSTHOG_PROJECT_ID: project, ...extra });
const CURRENT = '120248808857790714', OLD_A = '120248692698770714', OLD_B = '120248692706180714';
const FOREIGN = '120249000000000001'; // campagne de reciblage fictive, hors masterclass
const AD_VID52 = '120248824582140714', AD_B = '120248809668370714', AD_V3 = '120248824721600714';
const LINK_VID52 = '6f1c2d3e-4a5b-4c6d-8e7f-a1b2c3d4e5f6';
const metaRow = (day: string, campaignId: string, spend: number, extra: Record<string, unknown> = {}) => ({ day, key: campaignId, data: { campaignId, spend_eur: spend, impressions: spend * 100, link_clicks: spend * 2, unique_link_clicks_campaign_sum: spend, landing_page_views: spend, booking_meta_attributed: 1, ...extra } });

async function seedMeta() {
  const memory = memoryKpiDatabase({}, () => observedAt);
  const rows = [from, '2026-09-21'].flatMap(day => [metaRow(day, CURRENT, 10), metaRow(day, OLD_A, 2), metaRow(day, OLD_B, 3), metaRow(day, FOREIGN, 1000)]);
  await syncKpiSource(memory.db, 'meta', account, from, to, async () => ({ from, to, observedAt, rows }));
  return memory;
}

test('U8 Meta : le périmètre couvre les trois campagnes masterclass, dont la campagne actuelle, et exclut le reciblage', async () => {
  assert.ok(KPI_MASTERCLASS_CAMPAIGNS.includes(CURRENT), 'la campagne des trois publicités actives est dans le périmètre par défaut');
  const memory = await seedMeta();
  const response = await readLiveKpiFunnel(memory.db, filters, { env: env(), now });
  assert.equal(response.status, 'ready'); if (response.status !== 'ready') return;
  const { daily, totals, metadata } = response.snapshot;
  assert.deepEqual(metadata.campaign_ids, KPI_MASTERCLASS_CAMPAIGNS);
  // 10 + 2 + 3 par jour ; la campagne étrangère (1000) n'entre jamais.
  assert.deepEqual(daily.map(d => d.spend_eur), [15, 15]);
  assert.equal(totals.spend_eur, 30);
  assert.equal(totals.impressions, 3000);
  assert.equal(totals.link_clicks, 60);
  assert.equal(totals.landing_page_views, 30);
  assert.equal(totals.booking_meta_attributed, 6);
  assert.equal(totals.unique_link_clicks_campaign_sum, 30, 'somme campagne-jour, sans déduplication');
});

test('U8 Meta : surcharge BLG_KPI_MASTERCLASS_CAMPAIGN_IDS et sélection explicite d’une campagne', async () => {
  const memory = await seedMeta();
  const only = await readLiveKpiFunnel(memory.db, filters, { env: env({ BLG_KPI_MASTERCLASS_CAMPAIGN_IDS: ` ${CURRENT} , pas-un-id ` }), now });
  assert.equal(only.status, 'ready'); if (only.status !== 'ready') return;
  assert.equal(only.snapshot.totals.spend_eur, 20, 'seuls les identifiants numériques de la surcharge sont retenus');
  assert.deepEqual(only.snapshot.metadata.campaign_ids, [CURRENT]);
  const blank = await readLiveKpiFunnel(memory.db, filters, { env: env({ BLG_KPI_MASTERCLASS_CAMPAIGN_IDS: '   ' }), now });
  if (blank.status === 'ready') assert.equal(blank.snapshot.totals.spend_eur, 30, 'surcharge vide = périmètre par défaut');
  const selected = await readLiveKpiFunnel(memory.db, { ...filters, campaign: `meta:${OLD_A}` }, { env: env(), now });
  if (selected.status === 'ready') assert.equal(selected.snapshot.totals.spend_eur, 4);
  const organic = await readLiveKpiFunnel(memory.db, { ...filters, source: 'organic' }, { env: env(), now });
  assert.equal(organic.status, 'ready'); if (organic.status !== 'ready') return;
  assert.equal(organic.snapshot.totals.spend_eur, null, 'un filtre organique ne répartit pas la dépense Meta : non mesuré, jamais zéro');
  assert.equal(organic.snapshot.coverage.find(c => c.field_group === 'Diffusion Meta')?.status, 'missing');
});

test('U8 Meta : une journée sans ligne masterclass reste non mesurée, jamais zéro', async () => {
  const memory = memoryKpiDatabase({}, () => observedAt);
  await syncKpiSource(memory.db, 'meta', account, from, to, async () => ({ from, to, observedAt, rows: [metaRow(from, CURRENT, 10), metaRow('2026-09-21', FOREIGN, 5)] }));
  const response = await readLiveKpiFunnel(memory.db, filters, { env: env(), now });
  assert.equal(response.status, 'ready'); if (response.status !== 'ready') return;
  assert.deepEqual(response.snapshot.daily.map(d => d.spend_eur), [10, null]);
  assert.equal(response.snapshot.totals.spend_eur, null);
});

test('U8 Meta : lecteur quotidien = campagne × jour, 7 jours clic / 1 jour vue au jour de l’impression, conversion personnalisée exacte', async () => {
  const urls: URL[] = [];
  const insight = (campaign_id: string, actions?: { action_type: string; value: string }[]) => ({ account_id: '123', campaign_id, date_start: from, date_stop: from, spend: '12.34', impressions: '1000', inline_link_clicks: '40', unique_inline_link_clicks: '35', ...(actions ? { actions } : {}) });
  const fetcher = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input)); urls.push(url);
    const body = url.pathname.endsWith('/insights')
      ? { data: [
        insight(CURRENT, [{ action_type: 'landing_page_view', value: '30' }, { action_type: 'schedule', value: '9' }, { action_type: 'offsite_conversion.custom.2154825181913636', value: '2' }]),
        insight(OLD_A, [{ action_type: 'landing_page_view', value: '3' }]),
        insight(OLD_B),
      ] }
      : { account_id: '123', currency: 'EUR', timezone_name: 'Europe/Paris' };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const base: NodeJS.ProcessEnv = { NODE_ENV: 'test', META_AD_ACCOUNT_ID: 'act_123', META_ACCESS_TOKEN: 'synthetic-token' };
  const batch = await readKpiMeta(from, '2026-09-21', base, fetcher);
  const request = urls.find(u => u.pathname.endsWith('/insights'))!;
  assert.equal(request.searchParams.get('level'), 'campaign');
  assert.equal(request.searchParams.get('time_increment'), '1');
  assert.deepEqual(JSON.parse(request.searchParams.get('action_attribution_windows')!), ['7d_click', '1d_view']);
  assert.equal(request.searchParams.get('action_report_time'), 'impression');
  assert.deepEqual(JSON.parse(request.searchParams.get('time_range')!), { since: from, until: from });
  const byCampaign = new Map(batch.rows.map(r => [r.key, r.data]));
  assert.equal(byCampaign.get(CURRENT)?.booking_meta_attributed, 2, 'conversion personnalisée, jamais l’action générique schedule');
  assert.equal(byCampaign.get(CURRENT)?.spend_eur, 12.34);
  assert.equal(byCampaign.get(OLD_A)?.booking_meta_attributed, 0, 'tableau d’actions présent sans la conversion : zéro');
  assert.equal(byCampaign.get(OLD_B)?.booking_meta_attributed, null, 'ligne sans tableau d’actions : non mesuré');
  assert.equal(byCampaign.get(OLD_B)?.landing_page_views, null);
  const overridden = await readKpiMeta(from, '2026-09-21', { ...base, BLG_KPI_META_BOOKING_ACTION: 'schedule' }, fetcher);
  assert.equal(overridden.rows.find(r => r.key === CURRENT)?.data.booking_meta_attributed, 9, 'la surcharge serveur change l’action lue');
});

test('U8 PostHog : requête des clics bilan = sessions de production datées à Paris, première origine, marqueur d’essai conservé', () => {
  const query = kpiBookingQuery(from, '2026-09-21');
  for (const fragment of ["event='mc_booking_click'", "event='mc_booking_confirmed'", "'blg-rugby-mc'", "= 'production'", "'/masterclass26'", "'www.blg-studio.fr'", "'Europe/Paris'", 'AS is_test', 'count() AS sessions', 'first_origin', 'first_touch', 'blg_link_id', 'utm_content'])
    assert.ok(query.includes(fragment), `fragment attendu : ${fragment}`);
  assert.match(query, /GROUP BY sid/, 'une session compte une fois par type, à son premier événement');
  assert.match(query, /minIf\(timestamp,event='mc_booking_click'\)/);
  assert.match(query, /test-mehdi/);
});

async function seedPostHog(includeRows = true) {
  const memory = memoryKpiDatabase({
    ads: [
      { id: 'ad-row-1', external_id: AD_VID52, campaign_id: CURRENT, creative_id: 'creative-1', ad_name: 'Annonce A' },
      { id: 'ad-row-2', external_id: AD_B, campaign_id: CURRENT, creative_id: 'creative-2', ad_name: 'Annonce B' },
      { id: 'ad-row-3', external_id: AD_V3, campaign_id: CURRENT, creative_id: 'creative-3', ad_name: 'Annonce C' },
    ],
    link_revisions: [{ id: LINK_VID52, campaign: 'masterclass-sept', medium: 'paid_social', label: 'Lien court A' }],
  }, () => observedAt);
  const session = (day: string, kind: 'click' | 'confirmed', origin: { ad?: string; campaign?: string; source?: string; medium?: string; link?: string }, sessions: number, isTest = false) => {
    const data = { kind, ad: origin.ad ?? '', campaign: origin.campaign ?? '', source: origin.source ?? '', medium: origin.medium ?? '', link: origin.link ?? '', isTest, sessions };
    return { day, key: JSON.stringify([day, data.kind, data.ad, data.campaign, data.source, data.medium, data.link, isTest]), data };
  };
  const paid = { source: 'facebook', medium: 'paid_social', campaign: CURRENT };
  const rows = includeRows ? [
    session(from, 'click', { ...paid, ad: AD_VID52 }, 4), session(from, 'confirmed', { ...paid, ad: AD_VID52 }, 1),
    session(from, 'click', { ...paid, ad: AD_B }, 3),
    session('2026-09-21', 'click', { ...paid, ad: AD_V3 }, 2), session('2026-09-21', 'confirmed', { ...paid, ad: AD_V3 }, 2),
    session('2026-09-21', 'click', { source: 'facebook', medium: 'paid_social', link: LINK_VID52 }, 5),
    session('2026-09-21', 'confirmed', { source: 'facebook', medium: 'paid_social', link: LINK_VID52 }, 1),
    session('2026-09-21', 'click', { campaign: CURRENT, source: 'facebook', medium: 'paid_social' }, 1),
    session('2026-09-21', 'click', {}, 6),
    session('2026-09-21', 'click', { source: 'test', medium: 'recette', ad: AD_VID52 }, 9, true),
  ] : [];
  await syncKpiSource(memory.db, 'posthog', project, from, to, async () => ({ from, to, observedAt, rows }));
  return memory;
}

test('U8 PostHog : clics bilan et confirmations = sessions par type, essais exclus sauf option', async () => {
  const memory = await seedPostHog();
  const response = await readLiveKpiFunnel(memory.db, filters, { env: env(), now });
  assert.equal(response.status, 'ready'); if (response.status !== 'ready') return;
  assert.deepEqual(response.snapshot.daily.map(d => [d.booking_clicks, d.booking_confirmed_browser]), [[7, 1], [14, 3]]);
  assert.equal(response.snapshot.totals.booking_clicks, 21);
  const withTests = await readLiveKpiFunnel(memory.db, filters, { env: env(), now, includeTests: true });
  if (withTests.status === 'ready') assert.equal(withTests.snapshot.totals.booking_clicks, 30);
  const ad = await readLiveKpiFunnel(memory.db, { ...filters, campaign: `meta-ad:${AD_V3}` }, { env: env(), now });
  if (ad.status === 'ready') assert.deepEqual([ad.snapshot.totals.booking_clicks, ad.snapshot.totals.booking_confirmed_browser], [2, 2]);
  const empty = await seedPostHog(false);
  const zero = await readLiveKpiFunnel(empty.db, filters, { env: env(), now });
  if (zero.status === 'ready') assert.deepEqual(zero.snapshot.daily.map(d => d.booking_clicks), [0, 0], 'une journée publiée sans session est un zéro mesuré');
});

test('U8 détail par annonce : publicité, sinon lien identifié, sinon campagne ; le lien court n’est pas « non attribué »', async () => {
  const memory = await seedPostHog();
  const response = await readLiveKpiFunnel(memory.db, filters, { env: env(), now });
  assert.equal(response.status, 'ready'); if (response.status !== 'ready') return;
  const rows = response.snapshot.attribution_breakdown.rows;
  const byAd = new Map(rows.filter(r => r.ad_id).map(r => [r.ad_id, r]));
  assert.deepEqual([AD_VID52, AD_B, AD_V3].map(id => [byAd.get(id)?.label, byAd.get(id)?.booking_click_sessions, byAd.get(id)?.booking_confirmed_browser]), [['Annonce A', 4, 1], ['Annonce B', 3, 0], ['Annonce C', 2, 2]]);
  const link = rows.filter(r => r.label.startsWith('Lien identifié'));
  assert.equal(link.length, 1);
  assert.equal(link[0].label, 'Lien identifié · Lien court A', 'le libellé du registre distingue deux liens');
  assert.deepEqual([link[0].ad_id, link[0].booking_click_sessions, link[0].booking_confirmed_browser], [null, 5, 1]);
  const campaign = rows.find(r => r.label === `Campagne ${CURRENT}`);
  assert.equal(campaign?.booking_click_sessions, 1);
  const unattributed = rows.find(r => r.label === 'Non attribué');
  assert.equal(unattributed?.booking_click_sessions, 6, 'seules les sessions sans aucune origine restent non attribuées');
  assert.equal(rows.reduce((n, r) => n + r.booking_click_sessions, 0), response.snapshot.totals.booking_clicks, 'la répartition reconstitue les clics bilan du tableau');
});
