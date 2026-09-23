import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { syncKpiSource } from '../src/lib/kpi-source-store';
import { readLiveKpiFunnel } from '../src/lib/kpi-funnel-live';
import { KPI_EXCEL_COLUMNS, KPI_DETAIL_COLUMNS, kpiFunnelCsv } from '../src/lib/kpi-funnel-export';
import { KPI_BLOCKS, KPI_FUNNEL_SCHEMA_VERSION, kpiFunnelSnapshotSchema, kpiRatios, type KpiMeasures } from '../src/lib/kpi-funnel-contract';
import { KpiFunnelReadyTable } from '../src/components/KpiFunnelTable';
import { buildBookingResults } from '../src/lib/booking-results';
import { buildAdFunnel } from '../src/lib/ad-funnel';
import { memoryKpiDatabase } from './helpers/kpi-memory';
import { leadEntryProfile, wixLeadEntryConfig } from '../src/connectors/wix-lead-entries';
import { VISUAL_JOURNEY_FORM_ID } from '../src/lib/visual-journey-report';
import type { Row } from '../src/lib/db';
import type { DashboardFilters } from '../src/lib/ui-contract';

// U8b · tableau conforme à l'Excel de référence : colonnes, inscrits, appels réservés, ratios inter-blocs (D3), récapitulatifs, export.
// Identifiants et montants synthétiques ; aucune donnée BLG, aucune valeur de l'Excel de démonstration.
const CAMPAIGN = '120248808857790714', ACCOUNT = 'synthetic-account', AD = '120248824582140714';
const config = wixLeadEntryConfig(JSON.stringify({ formIds: [VISUAL_JOURNEY_FORM_ID], ignoredFormIds: [], formEmailField: 'email' }))!;
const profile = leadEntryProfile('forms', config);
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', META_AD_ACCOUNT_ID: ACCOUNT, WIX_SITE_ID: 'site', WIX_LEAD_ENTRY_CONFIG: JSON.stringify(config), NOTION_DATA_SOURCE_ID: 'notion-ds' };
const run = (id: string, source: string, namespace: string, stream: string, profileKey: string, at: string): Row => ({ id, source, source_namespace: namespace, stream_key: stream, query_profile_key: profileKey, status: 'complete', pagination_complete: true, rows_rejected: 0, started_at: at, finished_at: at, source_as_of: at, period_to: at });
const paid = { source: 'facebook', medium: 'paid_social', ad: AD };
let sequence = 0;
const registration = (person: string | null, day: string, options: { identity?: string | null; origin?: Row } = {}): Row => {
  const index = ++sequence;
  return { id: `obs-${index}`, external_id: `entry-${index}`, family: 'forms', source: 'wix', source_namespace: 'site', source_container_id: VISUAL_JOURNEY_FORM_ID, is_current: true, run_id: 'forms-run', published_at: '2026-09-18T00:00:00Z', mapping_profile: profile, eligible: true, identity_key: options.identity === undefined ? `identity-${person}` : options.identity, identity_state: person ? 'linked' : 'unresolved', person_id: person, occurred_day: day, occurred_at: `${day}T08:00:${String(index % 60).padStart(2, '0')}Z`, properties: { origin: options.origin ?? paid } };
};
const prospect = (id: string, person: string, business: Row, extra: Row = {}): Row => ({ id, external_id: `ext-${id}`, source: 'notion', source_namespace: 'notion-ds', person_id: person, display_name: 'Prospect synthétique', source_status: 'RDV Programmé', business, archived: false, ...extra });
const slot = (id: string, prospectId: string, day: string, extra: Row = {}): Row => ({ id, prospect_id: prospectId, source: 'notion', source_namespace: 'notion-ds', identity_basis: 'notion_current_slot', scheduled_at: `${day}T10:00:00Z`, scheduled_day: day, status: 'unknown', source_status: 'RDV Programmé', ...extra });

type Setup = { from: string; to: string; now: string; readAt: string; notionAt?: string; spend?: Record<string, number | undefined>; registrations: Row[]; prospects?: Row[]; appointments?: Row[] };
async function build(setup: Setup) {
  const memory = memoryKpiDatabase({
    sync_runs: [run('forms-run', 'wix', 'site', 'lead_entries_forms', profile, setup.readAt), run('notion-run', 'notion', 'notion-ds', 'prospects_business', 'notion-profile', setup.notionAt ?? setup.readAt)],
    lead_source_observations: setup.registrations, prospects: setup.prospects ?? [], appointments: setup.appointments ?? [],
  }, () => setup.readAt);
  const end = new Date(Date.parse(`${setup.to}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const rows = Object.entries(setup.spend ?? {}).filter(([, spend]) => spend !== undefined).map(([day, spend]) => ({ day, key: CAMPAIGN, data: { campaignId: CAMPAIGN, spend_eur: spend!, impressions: spend! * 40, link_clicks: Math.round(spend! / 2), unique_link_clicks_campaign_sum: Math.round(spend! / 3), landing_page_views: 1, booking_meta_attributed: 0 } }));
  await syncKpiSource(memory.db, 'meta', ACCOUNT, setup.from, end, async () => ({ from: setup.from, to: end, observedAt: setup.readAt, rows }));
  return memory;
}
async function snapshotOf(memory: Awaited<ReturnType<typeof build>>, filters: DashboardFilters, now: string) {
  const response = await readLiveKpiFunnel(memory.db, filters, { env, now });
  assert.equal(response.status, 'ready'); if (response.status !== 'ready') throw Error('not ready');
  return response.snapshot;
}
const filtersFor = (from: string, to: string, extra: Partial<DashboardFilters> = {}): DashboardFilters => ({ from, to, source: 'all', tunnel: 'masterclass', campaign: '', compare: false, ...extra });

// Jeu commun des appels réservés (période 20→22/09, lectures complètes le 23/09).
function bookingFixture(options: { outsideCohort?: boolean } = {}) {
  const registrations = [
    registration('pa', '2026-09-20'), registration('pb', '2026-09-20'), registration('pc', '2026-09-21'), registration('pd', '2026-09-22'),
    registration('pe', '2026-09-22', { origin: { source: 'test', medium: 'recette' } }), registration('pf', '2026-09-20'), registration('pg', '2026-09-21'), registration('ph', '2026-09-20'),
    ...(options.outsideCohort ? [registration('px', '2026-09-10')] : []),
  ];
  const prospects = [
    prospect('Pa', 'pa', { scheduledDay: '2026-09-25', dates: { booked: '2026-09-20T09:00:00Z' }, attendance: 'scheduled' }),
    prospect('Pb', 'pb', { scheduledDay: '2026-09-22', dates: { booked: '2026-09-21T09:00:00Z' }, attendance: 'cancelled' }, { source_status: 'RDV Annulé' }),
    prospect('Pc', 'pc', { scheduledDay: '2026-09-24', attendance: 'scheduled' }, { source_status: 'RDV Reporté' }),
    prospect('Pd', 'pd', { dates: { booked: '2026-09-22' } }),
    prospect('Pe', 'pe', { scheduledDay: '2026-09-26', dates: { booked: '2026-09-22T09:00:00Z' } }),
    prospect('Pf', 'pf', { scheduledDay: '2026-09-21', dates: { booked: '2026-09-19T09:00:00Z' }, attendance: 'show_up' }),
    prospect('Pg', 'pg', { scheduledDay: '2026-09-28', dates: { booked: '2026-09-23T07:00:00Z' } }),
    prospect('Ph', 'ph', { scheduledDay: '2026-09-27' }),
    prospect('Parch', 'pa', { dates: { booked: '2026-09-21' } }, { archived: true }),
    ...(options.outsideCohort ? [prospect('Px', 'px', { scheduledDay: '2026-09-29', dates: { booked: '2026-09-21T09:00:00Z' } })] : []),
  ];
  const appointments = [
    slot('a-pa', 'Pa', '2026-09-25'),
    slot('a-pb', 'Pb', '2026-09-22', { status: 'cancelled', source_status: 'RDV Annulé' }),
    slot('a-pc', 'Pc', '2026-09-24', { booked_at: '2026-09-21T10:00:00Z', source_status: 'RDV Reporté' }),
    slot('a-pe', 'Pe', '2026-09-26'), slot('a-pf', 'Pf', '2026-09-21'), slot('a-pg', 'Pg', '2026-09-28'), slot('a-ph', 'Ph', '2026-09-27'),
    ...(options.outsideCohort ? [slot('a-px', 'Px', '2026-09-29')] : []),
  ];
  return { registrations, prospects, appointments };
}

test('U8b colonnes : ordre et intitulés de l’Excel (A→AI, V vide), huit groupes, formulaires « sans objet » grisés, jours + 3 récapitulatifs', async () => {
  assert.deepEqual(KPI_EXCEL_COLUMNS.map(column => column.excel), ['B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','W','X','Y','Z','AA','AB','AC','AD','AE','AF','AG','AH','AI']);
  assert.deepEqual(KPI_EXCEL_COLUMNS.map(column => column.label), ['Dépense','Impressions','CPM','Clics lien','CTR','CPC','CTRU','Inscrits','Inscrits / clics','Coût par inscrit','Vues du CTA','Vues CTA / inscrits','Coût par vue du CTA','Formulaires','Formulaires / vues CTA','Coût par formulaire','Appels réservés','Réservés / vues du CTA','Coût par réservation','Inscrits → réservés','Appels planifiés','Appels réalisés','Présence','Offres faites','Offres / appels réalisés','Coût par offre','Ventes','Ventes / offres','Coût par client','Cash encaissé','CA contracté','ROAS cash','ROAS']);
  assert.deepEqual([...new Set(KPI_EXCEL_COLUMNS.map(column => column.group))], ['publicite','inscription','video','formulaire','reservation','appels','offres','ventes']);
  for (const label of ['Vues de page Meta','Clics bilan','Confirmations navigateur','RDV attribués Meta','Inscriptions (soumissions)','Répétitions','Ventes / appels réalisés','Clics sortants / impressions']) assert.ok(KPI_DETAIL_COLUMNS.some(column => column.label === label), `${label} passe dans le détail`);
  const memory = await build({ from: '2026-09-20', to: '2026-09-22', now: '2026-09-23T10:00:00Z', readAt: '2026-09-23T09:00:00Z', spend: { '2026-09-20': 100, '2026-09-21': 200, '2026-09-22': 300 }, ...bookingFixture() });
  const snapshot = await snapshotOf(memory, filtersFor('2026-09-20', '2026-09-22'), '2026-09-23T10:00:00Z');
  assert.equal(snapshot.metadata.schema_version, KPI_FUNNEL_SCHEMA_VERSION);
  const html = renderToStaticMarkup(createElement(KpiFunnelReadyTable, { snapshot }));
  const table = html.slice(html.indexOf('<table class="kpi-funnel-excel">'), html.indexOf('</table>', html.indexOf('kpi-funnel-excel')));
  assert.equal((table.match(/<tr/g) ?? []).length - 2, snapshot.daily.length + 3, 'lignes = jours + 3 récapitulatifs');
  for (const group of ['Publicité','Inscription','Vidéo','Formulaire','Réservation','Appels','Offres','Ventes']) assert.match(table, new RegExp(`scope="colgroup"[^>]*>${group}<`));
  assert.match(table, /title="CTR unique Meta : comptes ayant cliqué le lien \/ comptes touchés \(reach\) ; les jours ne s’additionnent pas\./, 'définition du CTRU en info-bulle');
  assert.equal((table.match(/>Sans objet</g) ?? []).length, 3 * (snapshot.daily.length + 3), 'trois colonnes formulaire grisées sur chaque ligne');
  const body = table.slice(table.indexOf('<tbody>')).split('</tr>');
  assert.match(body[0], /<strong>Global<\/strong><small>du 20\/09\/2026 au 22\/09\/2026<\/small>/);
  assert.match(body[1], /<strong>3 derniers jours<\/strong><small>du 20\/09\/2026 au 22\/09\/2026<\/small>/);
  assert.match(body[2], /<strong>7 derniers jours<\/strong><small>du 16\/09\/2026 au 22\/09\/2026<\/small>/);
  assert.doesNotMatch(html, /Conversion page et CPL restent indisponibles/);
});

test('U8b inscrits : contacts distincts du jour, puis de la fenêtre (jamais la somme des jours) ; une clé manquante rend le jour non mesuré', async () => {
  const registrations = [registration('pa', '2026-09-20'), registration('pa', '2026-09-20'), registration('pa', '2026-09-21'), registration('pb', '2026-09-21'), registration('pc', '2026-09-22')];
  const memory = await build({ from: '2026-09-20', to: '2026-09-22', now: '2026-09-23T10:00:00Z', readAt: '2026-09-23T09:00:00Z', registrations });
  const snapshot = await snapshotOf(memory, filtersFor('2026-09-20', '2026-09-22'), '2026-09-23T10:00:00Z');
  assert.deepEqual(snapshot.daily.map(d => [d.wix_form_submission_occurrences, d.registrants]), [[2, 1], [2, 2], [1, 1]], 'soumissions conservées, contacts distincts du jour');
  assert.equal(snapshot.summaries[0].registrants, 3, 'Global : pa, pb, pc une fois chacun (somme des jours = 4)');
  assert.equal(snapshot.summaries[1].registrants, 3);
  assert.equal(snapshot.totals.registrants, 3); assert.equal(snapshot.totals.wix_distinct_contacts, 3); assert.equal(snapshot.summaries[0].wix_form_submission_occurrences, 5);
  const missing = await build({ from: '2026-09-20', to: '2026-09-22', now: '2026-09-23T10:00:00Z', readAt: '2026-09-23T09:00:00Z', registrations: [...registrations, registration(null, '2026-09-21', { identity: null })] });
  const partial = await snapshotOf(missing, filtersFor('2026-09-20', '2026-09-22'), '2026-09-23T10:00:00Z');
  assert.deepEqual(partial.daily.map(d => d.registrants), [1, null, 1], 'seul le jour sans clé devient non mesuré');
  assert.equal(partial.daily[1].wix_form_submission_occurrences, 3, 'la soumission reste comptée');
  assert.match(partial.daily[1].reasons.registrants, /sans clé de contact/);
  assert.equal(partial.summaries[0].registrants, null, 'la fenêtre contient ce jour');
  // Le contrat refuse une fenêtre d’inscrits au-delà de la somme des jours.
  const forged = structuredClone(snapshot); forged.summaries[1].registrants = 5;
  assert.equal(kpiFunnelSnapshotSchema.safeParse(forged).success, false);
});

test('U8b appels réservés : date de réservation (jamais création ni jour du call), annulé et reporté comptés une fois, fiche sans créneau, essais exclus', async () => {
  const memory = await build({ from: '2026-09-20', to: '2026-09-22', now: '2026-09-23T10:00:00Z', readAt: '2026-09-23T09:00:00Z', ...bookingFixture() });
  const snapshot = await snapshotOf(memory, filtersFor('2026-09-20', '2026-09-22'), '2026-09-23T10:00:00Z');
  // 20/09 : pa. 21/09 : pb (annulé ensuite) et pc (reporté, booked_at du créneau). 22/09 : pd (fiche sans créneau). pe essai, pf avant, pg après, ph sans date : exclus.
  assert.deepEqual(snapshot.daily.map(d => d.calls_booked), [1, 2, 1]);
  assert.equal(snapshot.summaries[0].calls_booked, 4);
  assert.deepEqual(snapshot.daily.map(d => d.calls_scheduled), [0, 1, 0], 'les planifiés restent datés au jour du call (pf, 21/09)');
  const unlinked = await build({ from: '2026-09-20', to: '2026-09-22', now: '2026-09-23T10:00:00Z', readAt: '2026-09-23T09:00:00Z', ...bookingFixture(), registrations: [...bookingFixture().registrations, registration(null, '2026-09-21', { identity: 'orphan' })] });
  const cohort = await snapshotOf(unlinked, filtersFor('2026-09-20', '2026-09-22'), '2026-09-23T10:00:00Z');
  assert.deepEqual(cohort.daily.map(d => d.calls_booked), [null, null, null], 'règle actuelle cohortComplete');
  assert.match(cohort.daily[0].reasons.calls_booked, /non reliée/);
  assert.match(cohort.daily[0].reasons.registrant_to_booked, /non reliée/, 'le motif du taux remonte au terme manquant');
});

test('U8b appels réservés : même nombre que la carte Résultats « Réservés · date de réservation » sur la même période et les mêmes filtres', async () => {
  const now = '2026-09-23T10:00:00Z';
  for (const source of ['all', 'paid'] as const) for (const tunnel of ['masterclass', 'all'] as const) {
    const memory = await build({ from: '2026-09-20', to: '2026-09-22', now, readAt: '2026-09-23T09:00:00Z', ...bookingFixture() });
    const filters = filtersFor('2026-09-20', '2026-09-22', { source, tunnel });
    const snapshot = await snapshotOf(memory, filters, now);
    const tableCount = snapshot.summaries[0].calls_booked;
    const adFilters = { from: filters.from, to: filters.to, tunnel, source, campaign: '', includeTests: false };
    const funnel = await buildAdFunnel(memory.db, adFilters, { env, now, includeCommerce: false });
    const results = await buildBookingResults(memory.db, adFilters, { env, now, funnel });
    assert.equal(results.summary.booked, 4, `${source}/${tunnel} : précondition, la carte Résultats compte quatre réservations`);
    assert.equal(tableCount, results.summary.booked, `${source}/${tunnel} : tableau = carte Résultats`);
    assert.equal(tableCount, funnel.totals.appointmentsReserved);
  }
  // Écart documenté (hors jeu commun) : une personne inscrite avant la période qui réserve pendant la période est comptée par
  // Résultats (toute origine correspondant aux filtres) mais pas par le tableau (cohorte des inscrits de la période, règle du brief).
  const memory = await build({ from: '2026-09-20', to: '2026-09-22', now, readAt: '2026-09-23T09:00:00Z', ...bookingFixture({ outsideCohort: true }) });
  const filters = filtersFor('2026-09-20', '2026-09-22', { tunnel: 'all' });
  const adFilters = { from: filters.from, to: filters.to, tunnel: 'all' as const, source: 'all' as const, campaign: '', includeTests: false };
  const funnel = await buildAdFunnel(memory.db, adFilters, { env, now, includeCommerce: false });
  const results = await buildBookingResults(memory.db, adFilters, { env, now, funnel });
  assert.deepEqual([(await snapshotOf(memory, filters, now)).summaries[0].calls_booked, results.summary.booked], [4, 5]);
});

test('U8b coût par réservation : dépense du même jour / réservations du jour, jamais la dépense de la veille', async () => {
  const memory = await build({ from: '2026-09-20', to: '2026-09-22', now: '2026-09-23T10:00:00Z', readAt: '2026-09-23T09:00:00Z', spend: { '2026-09-20': 100, '2026-09-21': 200, '2026-09-22': 300 }, ...bookingFixture() });
  const snapshot = await snapshotOf(memory, filtersFor('2026-09-20', '2026-09-22'), '2026-09-23T10:00:00Z');
  assert.deepEqual(snapshot.daily.map(d => d.ratios.cost_per_booking), [100, 100, 300], 'l’Excel (T9, T11, T16) aurait donné –, 50, 200');
  assert.equal(snapshot.summaries[0].ratios.cost_per_booking, 600 / 4);
  const registrants = snapshot.daily.map(d => d.registrants);
  assert.deepEqual(snapshot.daily.map(d => d.ratios.registrant_to_booked), snapshot.daily.map((d, i) => d.calls_booked! / registrants[i]!), 'inscrits → réservés = réservés / inscrits du jour');
});

test('U8b D3 : un taux inter-blocs n’est calculé que si chaque bloc couvre le jour ; le motif nomme les blocs manquants', async () => {
  const all = Object.fromEntries(KPI_BLOCKS.map(block => [block, true])) as Record<(typeof KPI_BLOCKS)[number], boolean>;
  const values = { spend_eur: 120, calls_booked: 2, registrants: 4, link_clicks: 40, impressions: 1000 } as unknown as KpiMeasures;
  assert.equal(kpiRatios(values, all, { grain: 'day' }).ratios.cost_per_booking, 60);
  const withoutNotion = kpiRatios(values, { ...all, notion: false }, { grain: 'day' });
  assert.equal(withoutNotion.ratios.cost_per_booking, null, 'termes présents mais Notion ne couvre pas le jour');
  assert.equal(withoutNotion.reasons.cost_per_booking, 'Non mesuré : Rendez-vous (Notion) ne couvre pas ce jour.');
  assert.equal(withoutNotion.ratios.cpc, 3, 'un taux d’un seul bloc couvert reste calculé');
  assert.equal(kpiRatios(values, { ...all, meta: false, forms: false }, { grain: 'window' }).reasons.cost_per_registrant, 'Non mesuré : Diffusion Meta et Inscriptions (formulaire Wix) ne couvrent pas toute la fenêtre.');
  // De bout en bout : Notion lu le 21/09 à 17:00 (Paris) ; Meta et inscriptions lus le 23/09.
  const memory = await build({ from: '2026-09-20', to: '2026-09-22', now: '2026-09-23T10:00:00Z', readAt: '2026-09-23T09:00:00Z', notionAt: '2026-09-21T15:00:00Z', spend: { '2026-09-20': 100, '2026-09-21': 200, '2026-09-22': 300 }, ...bookingFixture() });
  const snapshot = await snapshotOf(memory, filtersFor('2026-09-20', '2026-09-22'), '2026-09-23T10:00:00Z');
  assert.deepEqual(snapshot.daily.map(d => d.blocks.notion), [true, false, false]);
  assert.deepEqual(snapshot.daily.map(d => d.ratios.cost_per_booking), [100, null, null]);
  assert.equal(snapshot.daily[1].reasons.cost_per_booking, 'Non mesuré : Rendez-vous (Notion) ne couvre pas ce jour.');
  assert.equal(snapshot.summaries[0].ratios.cost_per_booking, null);
  assert.equal(snapshot.summaries[0].reasons.cost_per_booking, 'Non mesuré : Rendez-vous (Notion) ne couvre pas toute la fenêtre.');
  assert.equal(snapshot.daily[1].ratios.cost_per_registrant, 200 / 2, 'Meta × inscriptions reste calculé : les deux blocs couvrent le 21/09 (pc, pg)');
  // Le contrat refuse un taux inter-blocs publié sur un jour non couvert, même si ses termes sont présents.
  const forged = structuredClone(snapshot); forged.daily[0].blocks.notion = false;
  assert.equal(kpiFunnelSnapshotSchema.safeParse(forged).success, false);
});

test('U8b taux : dénominateur nul = non calculé (jamais 0 % ni Infinity), terme jamais mesuré = responsable', () => {
  const all = Object.fromEntries(KPI_BLOCKS.map(block => [block, true])) as Record<(typeof KPI_BLOCKS)[number], boolean>;
  const values = { spend_eur: 50, impressions: 0, link_clicks: 0, calls_booked: 0, registrants: 3, reached_cta_oral: null, offers_made: null, sales: 0, calls_held: 2, cash_collected_eur: 0, contracted_revenue_eur: null } as unknown as KpiMeasures;
  const { ratios, reasons } = kpiRatios(values, all, { grain: 'day' });
  for (const key of ['ctr','cpm','cpc','cost_per_booking','cost_per_customer'] as const) { assert.equal(ratios[key], null); assert.match(reasons[key]!, /^Non calculé : .* = 0\.$/); }
  assert.equal(ratios.registrant_to_booked, 0, 'zéro réservé sur trois inscrits : 0 % mesuré');
  assert.equal(ratios.sales_per_call_held, 0);
  assert.match(reasons.cta_views_per_registrant!, /Mehdi et Codex/);
  assert.match(reasons.close_rate!, /Jérôme avec Codex/);
  assert.match(reasons.roas!, /lot finance/);
  assert.ok(Object.values(ratios).every(value => value === null || Number.isFinite(value)));
});

test('U8b récapitulatifs : Global, 3 et 7 derniers jours datés ; sommes puis taux des sommes, jamais une moyenne ; un jour non mesuré rend la somme non mesurée', async () => {
  const days = ['2026-09-20','2026-09-21','2026-09-22','2026-09-23','2026-09-24','2026-09-25','2026-09-26'];
  const spend = Object.fromEntries(days.map((day, i) => [day, [40, 80, 10, 120, 60, 20, 200][i]]));
  const registrations = [...days.map((day, i) => registration(`p${i}`, day)), registration('p0', '2026-09-25'), registration('p4', '2026-09-26')];
  const memory = await build({ from: days[0], to: days[6], now: '2026-09-27T10:00:00Z', readAt: '2026-09-27T09:00:00Z', spend, registrations });
  const snapshot = await snapshotOf(memory, filtersFor(days[0], days[6]), '2026-09-27T10:00:00Z');
  const [global, three, seven] = snapshot.summaries;
  assert.deepEqual([global.label, three.label, seven.label], ['Global · du 20/09/2026 au 26/09/2026', '3 derniers jours · du 24/09/2026 au 26/09/2026', '7 derniers jours · du 20/09/2026 au 26/09/2026']);
  assert.equal(three.spend_eur, 280); assert.equal(three.link_clicks, snapshot.daily.slice(4).reduce((n, d) => n + d.link_clicks!, 0));
  assert.equal(three.ratios.ctr, three.link_clicks! / three.impressions!, 'ratio des sommes');
  const mean = snapshot.daily.slice(4).reduce((n, d) => n + d.ratios.cost_per_registrant!, 0) / 3;
  assert.equal(three.ratios.cost_per_registrant, 280 / 4, 'coût par inscrit = dépense de la fenêtre / inscrits distincts de la fenêtre (p4, p5, p6, p0)');
  assert.notEqual(three.ratios.cost_per_registrant, mean, 'jamais la moyenne des coûts quotidiens');
  assert.equal(three.registrants, 4, 'p4 inscrit deux fois dans la fenêtre compte une fois');
  assert.equal(seven.spend_eur, global.spend_eur);
  // Un jour Meta non mesuré dans la fenêtre : sommes et taux Meta non mesurés, les inscriptions restent mesurées.
  const gap = await build({ from: days[0], to: days[6], now: '2026-09-27T10:00:00Z', readAt: '2026-09-27T09:00:00Z', spend: { ...spend, '2026-09-25': undefined }, registrations });
  const withGap = await snapshotOf(gap, filtersFor(days[0], days[6]), '2026-09-27T10:00:00Z');
  assert.equal(withGap.daily[5].spend_eur, null);
  assert.equal(withGap.summaries[1].spend_eur, null); assert.equal(withGap.summaries[1].ratios.ctr, null); assert.equal(withGap.summaries[0].spend_eur, null);
  assert.equal(withGap.summaries[1].registrants, 4);
  // Une fenêtre qui commence avant la période est signalée et reste non mesurée, sans la tronquer.
  const short = await snapshotOf(memory, filtersFor('2026-09-25', '2026-09-26'), '2026-09-27T10:00:00Z');
  assert.deepEqual(short.summaries.map(s => [s.from, s.within_period]), [['2026-09-25', true], ['2026-09-24', false], ['2026-09-20', false]]);
  assert.equal(short.summaries[1].spend_eur, null);
  assert.equal(short.summaries[1].reasons.ctr, 'Non mesuré : la fenêtre commence le 24/09/2026, avant la période sélectionnée ; élargir la période pour la lire.');
  // Le contrat refuse un récapitulatif dont la somme contredit les jours ou dont un taux n'est pas le ratio des sommes.
  const forged = structuredClone(snapshot); forged.summaries[1].ratios.cost_per_registrant = mean;
  assert.equal(kpiFunnelSnapshotSchema.safeParse(forged).success, false, 'taux moyenné refusé');
  const wrongSum = structuredClone(snapshot); wrongSum.summaries[1].spend_eur = 279;
  assert.equal(kpiFunnelSnapshotSchema.safeParse(wrongSum).success, false);
});

test('U8b export : ordre et intitulés de l’Excel, récapitulatifs datés, taux en pourcentage décimal à virgule, null jamais zéro, détail après', async () => {
  const memory = await build({ from: '2026-09-20', to: '2026-09-22', now: '2026-09-23T10:00:00Z', readAt: '2026-09-23T09:00:00Z', spend: { '2026-09-20': 100, '2026-09-21': 200, '2026-09-22': 300 }, ...bookingFixture() });
  const snapshot = await snapshotOf(memory, filtersFor('2026-09-20', '2026-09-22'), '2026-09-23T10:00:00Z');
  const lines = kpiFunnelCsv(snapshot).replace('﻿', '').split('\r\n');
  const header = lines.findIndex(line => line.startsWith('"Jour";'));
  const columns = lines[header].split(';').map(cell => cell.slice(1, -1));
  assert.deepEqual(columns.slice(0, 35), ['Jour','Dépense (EUR)','Impressions','CPM (EUR)','Clics lien','CTR (%)','CPC (EUR)','CTRU (%)','Inscrits','Inscrits / clics (%)','Coût par inscrit (EUR)','Vues du CTA','Vues CTA / inscrits (%)','Coût par vue du CTA (EUR)','Formulaires','Formulaires / vues CTA','Coût par formulaire','Appels réservés','Réservés / vues du CTA (%)','Coût par réservation (EUR)','Inscrits → réservés (%)','','Appels planifiés','Appels réalisés','Présence (%)','Offres faites','Offres / appels réalisés (%)','Coût par offre (EUR)','Ventes','Ventes / offres (%)','Coût par client (EUR)','Cash encaissé (EUR)','CA contracté (EUR)','ROAS cash','ROAS'], 'A→AI, V vide');
  assert.equal(columns[35], 'Inscriptions (soumissions)', 'colonnes du détail après');
  const rows = lines.slice(header + 1, header + 7).map(line => line.split(';').map(cell => cell.slice(1, -1)));
  assert.deepEqual(rows.map(row => row[0]), ['Global · du 20/09/2026 au 22/09/2026', '3 derniers jours · du 20/09/2026 au 22/09/2026', '7 derniers jours · du 16/09/2026 au 22/09/2026', '20/09/2026', '21/09/2026', '22/09/2026']);
  const day20 = rows[3];
  assert.equal(day20[5], '1,25', 'CTR 50 / 4 000 = 1,25 %');
  assert.equal(day20[19], '100', 'coût par réservation');
  assert.equal(day20[14], 'Sans objet');
  assert.equal(day20[11], 'Non mesuré', 'vues du CTA jamais à zéro');
  assert.equal(rows[2][1], 'Non mesuré', 'fenêtre hors période');
  assert.ok(lines.some(line => line.startsWith('"Lecture des récapitulatifs";"Sommes des jours puis taux des sommes, jamais une moyenne de taux. Inscrits : contacts distincts de la fenêtre')));
});
