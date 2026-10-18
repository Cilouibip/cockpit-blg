import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Temporal } from '@js-temporal/polyfill';
import { synchronizeWix } from '../src/lib/sync-wix';
import type { Database, Row } from '../src/lib/db';
import { syncWixPaymentsAnalytics, WIX_PAYMENTS_ANALYTICS_MAPPING as mapping, type WixPaymentsAnalyticsConfig } from '../src/connectors/wix-payments-analytics';

const json = (value: unknown) => new Response(JSON.stringify(value));
const cells = (paid: number | null, refunds: number | null, revenue: number, count = 1) => Object.fromEntries(Object.entries(mapping.measures).map(([key, field]) => [field, { numericValue: ({ paid, refunds, revenue, successfulPayments: count, giftCards: 0, tax: 0, platformFees: 0 } as Record<string, number | null>)[key] }]));
const row = (day: string, paid = 10, refunds: number | null = 0) => ({ fields: { ...cells(paid, refunds, paid + (refunds ?? 0)),
  [mapping.dimensions.provider]: { stringValue: 'synthetic-provider' }, [mapping.dimensions.method]: { stringValue: 'payment_method_inPerson' },
  [mapping.dimensions.status]: { stringValue: refunds ? 'payment_status_partially_refunded' : 'payment_status_approved' },
  [mapping.dimensions.type]: { stringValue: 'transaction_type_regular_payment' }, [mapping.dimensions.day]: { timestampValue: day } } });
type Query = { interval: { start: string; end: string; timezone: string }; filters: { values: string[] }[]; paging: { offset: number } };
function source(answer: (query: Query, index: number) => unknown) {
  const queries: Query[] = []; let prerequisites = 0;
  const fetcher = (async (url: URL, init: RequestInit) => {
    if (url.pathname.endsWith('/query-data')) { const query = JSON.parse(String(init.body)) as Query; queries.push(query); return json(answer(query, queries.length - 1)); }
    prerequisites++;
    if (url.pathname.endsWith('/properties')) return json({ properties: { paymentCurrency: 'EUR', timeZone: 'Europe/Paris' } });
    const schema = { id: mapping.modelId, slug: mapping.modelSlug,
      measures: Object.values(mapping.measures).map(name => ({ name, type: 'NUMBER', dependencies: [] })),
      dimensions: Object.values(mapping.dimensions).map(name => ({ name, type: name === mapping.dimensions.day ? 'DATE_TIME' : 'STRING', dependencies: [], sortable: true, filters: { prefixes: ['IS'], conditions: ['RANGE_IE'] } })) };
    return json(url.pathname.endsWith(mapping.modelId) ? { semanticModel: schema } : { semanticModels: [schema] });
  }) as typeof fetch;
  return { fetcher, queries, prerequisites: () => prerequisites };
}
const cfg = (fetcher: typeof fetch, extra: Partial<WixPaymentsAnalyticsConfig> = {}): WixPaymentsAnalyticsConfig => ({ apiKey: 'synthetic-key', siteId: '44444444-4444-4444-8444-444444444444', timezone: 'Europe/Paris',
  from: '2026-08-31T22:00:00Z', to: '2026-10-18T22:00:00Z', fetcher, sleep: async () => {}, ...extra });
const page = (rows: ReturnType<typeof row>[], totals = cells(10, 0, 10), offset = 0) => ({ results: rows, pagingMetadata: { count: rows.length, offset }, totals: { fields: totals } });

test('Wix combines disjoint monthly source totals, keeps refunds signed and commits only the full period', async () => {
  const upstream = source((q, i) => page([row(q.interval.start, i ? 20 : 10, i ? -3 : 0)], cells(i ? 20 : 10, i ? -3 : 0, i ? 17 : 10)));
  let commits = 0;
  const result = await syncWixPaymentsAnalytics(cfg(upstream.fetcher, { commitPage: async p => { commits++; assert.equal(p.terminal, true); assert.equal(p.records.find(r => r.metric === 'net_cash')?.amount?.minor, 2700); } }));
  assert.equal(result.status, 'complete'); assert.equal(commits, 1); assert.equal(upstream.prerequisites(), 3);
  assert.deepEqual(upstream.queries.map(q => [q.interval.start, q.interval.end]), [['2026-08-31T22:00:00Z', '2026-09-30T22:00:00Z'], ['2026-09-30T22:00:00Z', '2026-10-18T22:00:00Z']]);
  assert.equal(result.sourceTotals?.revenue, 2700); assert.equal(result.sourceTotals?.refunds, -300); assert.equal(result.sourceTotals?.successfulPayments, 2);
  assert.equal(result.breakdown.length, 2); assert.equal(new Set(result.breakdown.map(r => r.dimensions.day)).size, 2);
  assert.equal(result.records.find(r => r.metric === 'wix_total_revenue')?.from, '2026-08-31T22:00:00Z');
  for (const q of upstream.queries) assert.deepEqual(q.filters[0].values, [q.interval.start, q.interval.end]);
});

test('Wix monthly bounds follow Paris civil months through DST and partial endpoint months for 367 days', async () => {
  const upstream = source(q => page([row(q.interval.start)]));
  const result = await syncWixPaymentsAnalytics(cfg(upstream.fetcher, { from: '2026-02-27T23:00:00Z', to: '2027-03-01T23:00:00Z' }));
  assert.equal(result.status, 'complete'); assert.equal(upstream.queries.length, 14);
  assert.deepEqual(upstream.queries[0].interval, { start: '2026-02-27T23:00:00Z', end: '2026-02-28T23:00:00Z', timezone: 'Europe/Paris' });
  assert.equal(upstream.queries[1].interval.end, '2026-03-31T22:00:00Z');
  assert.equal(upstream.queries[8].interval.end, '2026-10-31T23:00:00Z');
  assert.equal(upstream.queries.at(-1)!.interval.end, '2027-03-01T23:00:00Z');
  for (let i = 0; i < upstream.queries.length; i++) {
    const q = upstream.queries[i];
    assert.equal(Temporal.Instant.from(q.interval.start).toZonedDateTimeISO('Europe/Paris').hour, 0);
    assert.equal(Temporal.Instant.from(q.interval.end).toZonedDateTimeISO('Europe/Paris').hour, 0);
    if (i) assert.equal(upstream.queries[i - 1].interval.end, q.interval.start);
  }
});

test('Wix rejects invalid durations and cursor before any source request', async () => {
  for (const extra of [{ to: '2027-09-03T22:00:00Z' }, { to: '2026-08-31T22:00:00Z' }, { cursor: 'synthetic-cursor' }]) {
    const upstream = source(() => { throw new Error('No request expected'); });
    const result = await syncWixPaymentsAnalytics(cfg(upstream.fetcher, extra));
    assert.equal(result.status, 'failed'); assert.equal(result.safeError, 'INVALID_CONFIGURATION'); assert.equal(upstream.prerequisites(), 0);
  }
});

test('Wix reconciles each month before summing, even when mismatches could cancel globally', async () => {
  const upstream = source((q, i) => page([row(q.interval.start)], cells(10, 0, i ? 9 : 11)));
  const result = await syncWixPaymentsAnalytics(cfg(upstream.fetcher));
  assert.equal(result.safeError, 'WIX_TOTALS_MISMATCH'); assert.equal(upstream.queries.length, 1); assert.deepEqual(result.records, []);
});

test('Wix does not turn an empty subwindow or null monthly measure into a measured zero', async () => {
  for (const emptyIndex of [0, 1]) {
    let committed = false;
    const upstream = source((q, i) => i === emptyIndex ? { results: [], pagingMetadata: { count: 0, offset: 0 } } : page([row(q.interval.start)]));
    const result = await syncWixPaymentsAnalytics(cfg(upstream.fetcher, { commitPage: async () => { committed = true; } }));
    assert.equal(result.status, 'empty'); assert.equal(result.coverage.complete, false); assert.deepEqual(result.records, []); assert.deepEqual(result.checkpoint, {}); assert.equal(committed, false);
  }
  const upstream = source((q, i) => page([row(q.interval.start, 10, i ? null : 0)], cells(10, i ? null : 0, 10)));
  const result = await syncWixPaymentsAnalytics(cfg(upstream.fetcher));
  assert.equal(result.status, 'complete'); assert.equal(result.sourceTotals?.refunds, null); assert.equal(result.normalizedNetEligible, false);
  assert.equal(result.records.some(r => r.metric === 'wix_refunds_signed' || r.metric === 'net_cash'), false);
});

test('Wix resets pagination and totals per month while retaining a total page budget', async () => {
  const upstream = source((q, i) => {
    const totals = cells(i < 2 ? 10 : 20, 0, i < 2 ? 10 : 20);
    return q.paging.offset ? { results: [], pagingMetadata: { count: 0, offset: 1 } } : page([row(q.interval.start, i < 2 ? 10 : 20)], totals);
  });
  const result = await syncWixPaymentsAnalytics(cfg(upstream.fetcher, { pageSize: 1, maxPages: 4 }));
  assert.equal(result.status, 'complete'); assert.deepEqual(upstream.queries.map(q => q.paging.offset), [0, 1, 0, 1]); assert.equal(result.sourceTotals?.revenue, 3000);
  const limited = source(q => page([row(q.interval.start)]));
  const failed = await syncWixPaymentsAnalytics(cfg(limited.fetcher, { maxPages: 1 }));
  assert.equal(failed.safeError, 'PAGE_LIMIT_REACHED'); assert.equal(failed.status, 'partial'); assert.deepEqual(failed.records, []); assert.equal(limited.queries.length, 1);
});

test('Wix rejects a row outside its month even if it lies inside the overall requested period', async () => {
  const upstream = source(() => page([row('2026-10-01T22:00:00Z')]));
  const result = await syncWixPaymentsAnalytics(cfg(upstream.fetcher));
  assert.equal(result.safeError, 'WIX_FILTER_MISMATCH'); assert.deepEqual(result.records, []);
});


test('Wix preserves leap days and accepts the minimum one-day window', async () => {
  for (const [from, to, count] of [['2024-02-28T23:00:00Z', '2024-03-01T23:00:00Z', 2], ['2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z', 1]] as const) {
    const upstream = source(q => page([row(q.interval.start)]));
    const result = await syncWixPaymentsAnalytics(cfg(upstream.fetcher, { from, to }));
    assert.equal(result.status, 'complete'); assert.equal(upstream.queries.length, count);
    assert.equal(upstream.queries.at(-1)!.interval.end, to);
  }
});

test('Wix monthly collection persists one reconciled full-period report with distinct daily rows', async () => {
  const upstream = source((q, i) => page([row(q.interval.start, i ? 20 : 10)], cells(i ? 20 : 10, 0, i ? 20 : 10)));
  const stored: Row[] = [], events: { name: string; args: Row }[] = [];
  const db: Database = { probe: async () => {}, select: async () => [], upsert: async (_table, rows) => { stored.push(...rows); },
    rpc: async <T>(name: string, args: Row) => { events.push({ name, args }); return (name === 'begin_sync_stream' ? 'synthetic-run' : true) as T; } };
  const result = await synchronizeWix('2026-09-01', '2026-10-19', { db, fetcher: upstream.fetcher,
    env: { NODE_ENV: 'test', COCKPIT_MODE: 'live', WIX_API_KEY: 'synthetic-key', WIX_SITE_ID: '44444444-4444-4444-8444-444444444444' } });
  assert.equal(result.status, 'complete'); assert.equal(events.at(-1)!.args.p_complete, true);
  assert.equal(stored.find(r => r.metric_key === 'wix_total_revenue')!.value, 3000);
  const daily = stored.filter(r => r.metric_key === 'wix_daily_revenue');
  assert.deepEqual(daily.map(r => [r.dimensions_key, r.value]), [['day:2026-09-01', 1000], ['day:2026-10-01', 2000]]);
  assert.ok(stored.every(r => r.report_profile_key === mapping.version && r.sync_run_id === 'synthetic-run'));
  assert.equal(new Set(stored.map(r => String(r.period_from) + '/' + String(r.period_to))).size, 1);
});
