import test from 'node:test';
import assert from 'node:assert/strict';
import { KPI_BLOCKS, KPI_RATIO_KEYS, kpiFunnelSnapshotSchema, kpiRatios, type KpiMeasures } from '../src/lib/kpi-funnel-contract';

type NullableMeasure = number | null;
type DayMeasures = {
  spend_eur: NullableMeasure; impressions: NullableMeasure; link_clicks: NullableMeasure; unique_link_clicks_campaign_sum: NullableMeasure;
  landing_page_views: NullableMeasure; wix_form_submission_occurrences: NullableMeasure; reached_cta_oral: NullableMeasure;
  booking_clicks: NullableMeasure; booking_confirmed_browser: NullableMeasure; booking_meta_attributed: NullableMeasure;
  calls_scheduled: NullableMeasure; calls_held: NullableMeasure; offers_made: NullableMeasure; sales: NullableMeasure;
  cash_collected_eur: NullableMeasure; contracted_revenue_eur: NullableMeasure;
  registrants: NullableMeasure; calls_booked: NullableMeasure; outbound_clicks: NullableMeasure; meta_reach: NullableMeasure; meta_unique_link_clicks: NullableMeasure;
};
const fields: DayMeasures = {
  spend_eur: null, impressions: null, link_clicks: null, unique_link_clicks_campaign_sum: null,
  landing_page_views: null, wix_form_submission_occurrences: null, reached_cta_oral: null,
  booking_clicks: null, booking_confirmed_browser: null, booking_meta_attributed: null,
  calls_scheduled: null, calls_held: null, offers_made: null, sales: null,
  cash_collected_eur: null, contracted_revenue_eur: null,
  registrants: null, calls_booked: null, outbound_clicks: null, meta_reach: null, meta_unique_link_clicks: null,
};
const covered = Object.fromEntries(KPI_BLOCKS.map(block => [block, true])) as Record<(typeof KPI_BLOCKS)[number], boolean>;
const ratiosOf = (values: DayMeasures) => { const { ratios, reasons } = kpiRatios(values as KpiMeasures, covered, { grain: 'day' }); return { ratios, blocks: covered, reasons: reasons as Record<string, string> }; };
const day = (date: string, values: Partial<DayMeasures>) => ({ date, partial_day: null, ...fields, ...values, ...ratiosOf({ ...fields, ...values }) });
const outside = (key: 'last_3_days' | 'last_7_days', from: string) => ({ key, label: key, from, to: '2026-09-02', within_period: false, partial_day: null, ...fields, ratios: Object.fromEntries(KPI_RATIO_KEYS.map(k => [k, null])), blocks: Object.fromEntries(KPI_BLOCKS.map(b => [b, false])), reasons: Object.fromEntries(KPI_RATIO_KEYS.map(k => [k, 'Fenêtre hors période.'])) });
const snapshot = () => ({
  metadata: {
    dataset_id: 'synthetic-kpi-commercial-pending', schema_version: '3.0.0', mode: 'automatic', include_tests: false,
    generated_at: '2026-09-22T20:55:00Z', timezone: 'Europe/Paris',
    window_start: '2026-09-01T00:00:00+02:00', window_end_meta: '2026-09-02T23:59:59+02:00',
    window_end_email: '2026-09-02T23:59:59+02:00', window_end_commercial: '2026-09-02T23:59:59+02:00',
    scope: 'synthetic', scope_note: 'Synthetic pending commercial day.', campaign_ids: [], exclusions: [],
  },
  definitions: {},
  daily: [day('2026-09-01', { sales: 1, cash_collected_eur: 100 }), day('2026-09-02', {})],
  totals: { ...fields, wix_distinct_contacts: null, wix_repeat_occurrences: null },
  summaries: [{ key: 'global', label: 'Global', from: '2026-09-01', to: '2026-09-02', within_period: true, partial_day: null, ...fields, ...ratiosOf(fields) }, outside('last_3_days', '2026-08-31'), outside('last_7_days', '2026-08-27')],
  attribution_breakdown: { freshness: '2026-09-22T20:55:00Z', metric: 'Synthetic', rows: [], wix_submission_context: { arrival: {}, selected_first_origin_else_arrival: {}, rule: 'Synthetic', interpretation: 'Synthetic', freshness: '2026-09-22T20:55:00Z' } },
  email_summary: { scope: 'Synthetic', all_three_forms: { sent: null, delivered: null, opens_sum_by_message: null, clicks_sum_by_message: null }, facebook_form_recipient_filter: { submissions: null, distinct_emails: null, sent: null, delivered: null, opens: null, clicks: null } },
  coverage: [{ field_group: 'Ventes et cash', status: 'available', reason: 'Synthetic covered commercial source.' }],
  source_locators: [],
});

test('keeps an incomplete commercial total null while retaining a covered daily amount with its sale', () => {
  const data = snapshot();
  assert.equal(data.totals.sales, null);
  assert.equal(kpiFunnelSnapshotSchema.safeParse(data).success, true);
});

test('still rejects a commercial amount without a sale on its own day', () => {
  const data = snapshot();
  data.daily[1].cash_collected_eur = 5;
  const result = kpiFunnelSnapshotSchema.safeParse(data);
  assert.equal(result.success, false);
  if (!result.success) assert.ok(result.error.issues.some(issue => issue.path.join('.') === 'totals'));
});

test('still rejects a commercial total when the sales total is unavailable', () => {
  const data = snapshot();
  data.daily[0].sales = null;
  data.daily[0].cash_collected_eur = null;
  data.totals.cash_collected_eur = 100;
  const result = kpiFunnelSnapshotSchema.safeParse(data);
  assert.equal(result.success, false);
  if (!result.success) assert.ok(result.error.issues.some(issue => issue.path.join('.') === 'totals'));
});

test('still rejects commercial money without available coverage', () => {
  const data = snapshot();
  data.coverage[0].status = 'missing';
  const result = kpiFunnelSnapshotSchema.safeParse(data);
  assert.equal(result.success, false);
  if (!result.success) assert.ok(result.error.issues.some(issue => issue.path.join('.') === 'totals'));
});
