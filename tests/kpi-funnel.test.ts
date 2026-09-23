import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readKpiFunnelSnapshot } from '../src/lib/kpi-funnel';
import { KPI_BLOCKS, KPI_RATIO_KEYS, kpiRatios, type KpiMeasures } from '../src/lib/kpi-funnel-contract';

const day = {
  spend_eur: 10,
  impressions: 1000,
  link_clicks: 50,
  unique_link_clicks_campaign_sum: 45,
  landing_page_views: 40,
  wix_form_submission_occurrences: 3,
  reached_cta_oral: null,
  booking_clicks: 1,
  booking_confirmed_browser: 0,
  booking_meta_attributed: 0,
  calls_scheduled: null,
  calls_held: null,
  offers_made: null,
  sales: null,
  cash_collected_eur: null,
  contracted_revenue_eur: null,
  registrants: 2,
  calls_booked: null,
  outbound_clicks: null,
  meta_reach: null,
  meta_unique_link_clicks: null,
};
// Schéma 3 : taux, couverture par bloc et motifs calculés par la règle du contrat ; fenêtres de 3 et 7 jours hors période.
const covered = Object.fromEntries(KPI_BLOCKS.map(block => [block, true])) as Record<(typeof KPI_BLOCKS)[number], boolean>;
const withRatios = (values: KpiMeasures) => { const { ratios, reasons } = kpiRatios(values, covered, { grain: 'day' }); return { ratios, blocks: covered, reasons: reasons as Record<string, string> }; };
const outside = (key: 'last_3_days' | 'last_7_days', from: string) => ({ key, label: `${key} · du ${from}`, from, to: '2026-09-22', within_period: false, partial_day: null, ...Object.fromEntries(Object.keys(day).map(k => [k, null])), ratios: Object.fromEntries(KPI_RATIO_KEYS.map(k => [k, null])), blocks: Object.fromEntries(KPI_BLOCKS.map(b => [b, false])), reasons: Object.fromEntries(KPI_RATIO_KEYS.map(k => [k, 'Fenêtre hors période.'])) });

const fixture = {
  metadata: {
    dataset_id: 'synthetic-kpi-funnel', schema_version: '3.0.0', generated_at: '2026-09-22T17:00:00Z', timezone: 'Europe/Paris',
    window_start: '2026-09-22T00:00:00+02:00', window_end_meta: '2026-09-22T16:58:00+02:00', window_end_email: '2026-09-22T16:52:00+02:00', window_end_commercial: '2026-09-22T14:55:27+02:00',
    scope: 'mixed_source_masterclass_monitoring', scope_note: 'Synthetic source boundaries.', campaign_ids: ['synthetic-campaign'], exclusions: ['PII'],
  },
  definitions: { wix_form_submission_occurrences: 'Synthetic Wix occurrences.' },
  daily: [{ date: '2026-09-22', partial_day: 'through_16_58_paris', ...day, ...withRatios(day) }],
  totals: { ...day, wix_distinct_contacts: 2, wix_repeat_occurrences: 1 },
  summaries: [{ key: 'global', label: 'Global · du 22/09/2026 au 22/09/2026', from: '2026-09-22', to: '2026-09-22', within_period: true, partial_day: 'Inclut la journée en cours', ...day, ...withRatios(day) }, outside('last_3_days', '2026-09-20'), outside('last_7_days', '2026-09-16')],
  attribution_breakdown: {
    freshness: '2026-09-22T09:32:46Z', metric: 'Synthetic booking click sessions.',
    rows: [{ label: 'B1', ad_id: 'synthetic-ad', booking_click_sessions: 1, booking_confirmed_browser: 0 }],
    wix_submission_context: { arrival: { B1: 3 }, selected_first_origin_else_arrival: { B1: 3 }, rule: 'Synthetic selection rule.', interpretation: 'Synthetic context only.', freshness: '2026-09-22T09:32:46Z' },
  },
  email_summary: {
    scope: 'Synthetic email activity.',
    all_three_forms: { sent: 4, delivered: 4, opens_sum_by_message: 2, clicks_sum_by_message: 1 },
    facebook_form_recipient_filter: { submissions: 3, distinct_emails: 2, sent: 3, delivered: 3, opens: 2, clicks: 1 },
  },
  coverage: [{ field_group: 'Commercial', status: 'missing', reason: 'Synthetic missing coverage.' }],
  source_locators: [{ source: 'Synthetic source', locator: 'synthetic/fixture.json' }],
};

test('le relevé exige un chemin serveur absolu explicitement configuré', async () => {
  assert.deepEqual(await readKpiFunnelSnapshot({}), { status: 'missing', message: 'Aucun relevé chargé.' });
  assert.equal((await readKpiFunnelSnapshot({ BLG_KPI_FUNNEL_PATH: 'relative.json' })).status, 'unavailable');
});

test('le JSON serveur est prioritaire, borné et refuse les champs personnels', async () => {
  const withPii = structuredClone(fixture) as Record<string, any>;
  withPii.daily[0].email = 'personne@example.test';
  assert.equal((await readKpiFunnelSnapshot({ BLG_KPI_FUNNEL_JSON: JSON.stringify(withPii) })).status, 'unavailable');
  assert.equal((await readKpiFunnelSnapshot({ BLG_KPI_FUNNEL_JSON: `{"oversized":"${'a'.repeat(2_000_001)}"}` })).status, 'unavailable');
  const response = await readKpiFunnelSnapshot({ BLG_KPI_FUNNEL_JSON: JSON.stringify(fixture), BLG_KPI_FUNNEL_PATH: '/does/not/exist.json' });
  assert.equal(response.status, 'ready');
});

test('le lecteur conserve null, zéro, occurrences et contacts distincts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blg-kpi-'));
  try {
    const file = join(directory, 'snapshot.json');
    await writeFile(file, JSON.stringify(fixture));
    const response = await readKpiFunnelSnapshot({ BLG_KPI_FUNNEL_PATH: file });
    assert.equal(response.status, 'ready');
    if (response.status !== 'ready') return;
    assert.equal(response.snapshot.daily[0].booking_confirmed_browser, 0);
    assert.equal(response.snapshot.daily[0].sales, null);
    assert.equal(response.snapshot.totals.wix_form_submission_occurrences, 3);
    assert.equal(response.snapshot.totals.wix_distinct_contacts, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('l’ancien champ ambigu de soumissions est refusé', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blg-kpi-'));
  try {
    const file = join(directory, 'snapshot.json');
    const invalid = structuredClone(fixture) as Record<string, any>;
    invalid.daily[0].wix_form_submissions = invalid.daily[0].wix_form_submission_occurrences;
    delete invalid.daily[0].wix_form_submission_occurrences;
    await writeFile(file, JSON.stringify(invalid));
    const response = await readKpiFunnelSnapshot({ BLG_KPI_FUNNEL_PATH: file });
    assert.deepEqual(response, { status: 'unavailable', message: 'Le relevé configuré ne peut pas être lu.' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('les dates dupliquées et les totaux incohérents sont refusés', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blg-kpi-'));
  try {
    const file = join(directory, 'snapshot.json');
    const duplicate = structuredClone(fixture) as Record<string, any>;
    duplicate.metadata.window_end_meta = '2026-09-23T16:58:00+02:00';
    duplicate.daily.push(structuredClone(duplicate.daily[0]));
    await writeFile(file, JSON.stringify(duplicate));
    assert.equal((await readKpiFunnelSnapshot({ BLG_KPI_FUNNEL_PATH: file })).status, 'unavailable');

    const wrongTotal = structuredClone(fixture) as Record<string, any>;
    wrongTotal.totals.spend_eur = 10.01;
    await writeFile(file, JSON.stringify(wrongTotal));
    assert.equal((await readKpiFunnelSnapshot({ BLG_KPI_FUNNEL_PATH: file })).status, 'unavailable');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('une journée non mesurée interdit un faux total additif', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blg-kpi-'));
  try {
    const file = join(directory, 'snapshot.json');
    const missing = structuredClone(fixture) as Record<string, any>;
    missing.daily[0].landing_page_views = null;
    await writeFile(file, JSON.stringify(missing));
    assert.equal((await readKpiFunnelSnapshot({ BLG_KPI_FUNNEL_PATH: file })).status, 'unavailable');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
