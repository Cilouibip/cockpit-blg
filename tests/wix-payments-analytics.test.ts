import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncWixPaymentsAnalytics, WIX_PAYMENTS_ANALYTICS_MAPPING as mapping, type WixPaymentsAnalyticsConfig } from '../src/connectors/wix-payments-analytics';

const measureNames = Object.keys(mapping.measures) as (keyof typeof mapping.measures)[];
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const schema = () => ({ semanticModel: { id: mapping.modelId, slug: mapping.modelSlug,
  measures: Object.values(mapping.measures).map(name => ({ name, type: 'NUMBER', dependencies: [] })),
  dimensions: Object.values(mapping.dimensions).map(name => ({ name, type: name === mapping.dimensions.day ? 'DATE_TIME' : 'STRING', dependencies: [], sortable: true, filters: { prefixes: ['IS'], conditions: ['RANGE_IE'] } })) } });
const prerequisites = () => [response({ properties: { paymentCurrency: 'EUR', timeZone: 'Europe/Paris', email: 'FORBIDDEN_EMAIL' } }), response({ semanticModels: [{ id: mapping.modelId, slug: mapping.modelSlug }] }), response(schema())];
const moneyCells = (paid: number | null, refunds: number | null, revenue: number, giftCards = 0, successfulPayments = 1) => Object.fromEntries(measureNames.map(key => [mapping.measures[key],
  { numericValue: ({ paid, refunds, revenue, giftCards, tax: 0, platformFees: 0, successfulPayments })[key] }]));
const payment = (extra: Record<string, unknown> = {}) => ({ fields: { ...moneyCells(200, null, 200),
  [mapping.dimensions.provider]: { stringValue: 'synthetic-provider' }, [mapping.dimensions.method]: { stringValue: 'payment_method_inPerson' },
  [mapping.dimensions.status]: { stringValue: 'payment_status_approved' }, [mapping.dimensions.type]: { stringValue: 'transaction_type_regular_payment' },
  [mapping.dimensions.day]: { timestampValue: '2026-01-01T23:00:00Z' }, ...extra } });
const refund = (extra: Record<string, unknown> = {}) => payment({ ...moneyCells(null, -50, -50, 0, 0),
  [mapping.dimensions.status]: { stringValue: 'payment_status_refunded' }, [mapping.dimensions.type]: { stringValue: 'transaction_type_refund' },
  [mapping.dimensions.provider]: {}, [mapping.dimensions.method]: {}, [mapping.dimensions.day]: { timestampValue: '2026-01-04T23:00:00Z' }, ...extra });
const page = (rows = [payment(), refund()], offset = 0, totalFields = moneyCells(200, -50, 150)) => response({ results: rows, pagingMetadata: { count: rows.length, offset }, totals: { fields: totalFields } });
function queue(responses: Response[], inspect?: (url: URL, init: RequestInit) => void): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => { inspect?.(new URL(String(input)), init ?? {}); const value = responses.shift(); assert.ok(value, 'Unexpected request'); return value; }) as typeof fetch;
}
const config = (fetcher: typeof fetch): WixPaymentsAnalyticsConfig => ({ siteId: '44444444-4444-4444-8444-444444444444', apiKey: 'synthetic-key', timezone: 'Europe/Paris',
  from: '2025-12-31T23:00:00Z', to: '2026-01-31T23:00:00Z', now: () => '2026-02-02T12:00:00Z', fetcher, sleep: async () => {} });

test('Wix Analytics produces reconciled TTC cash, retains manual methods, and adds signed refunds once', async () => {
  let committed = 0;
  const cfg = config(queue([...prerequisites(), page()], (url, init) => {
    assert.equal(url.origin, 'https://www.wixapis.com'); assert.equal(init.redirect, 'error'); assert.ok(!String(url).includes('synthetic-key'));
    if (url.pathname.endsWith('/properties')) assert.deepEqual(url.searchParams.getAll('fields.paths'), ['paymentCurrency', 'timeZone']);
    if (init.method === 'POST') {
      const body = JSON.parse(String(init.body)); assert.equal(url.pathname.endsWith('/query-data'), true);
      assert.equal(body.interval.timezone, 'Europe/Paris'); assert.equal(body.filters[0].condition, 'RANGE_IE');
      assert.deepEqual(body.filters[0].values, [cfg.from, cfg.to]); assert.equal(body.formattingEnabled, false); assert.equal(body.totalsIncluded, true);
      assert.ok(body.fields.every((f: string) => f.startsWith('transactions.') && !/customer|order_number|transaction_id/.test(f)));
    }
  }));
  cfg.commitPage = async page => { committed++; assert.equal(page.terminal, true); assert.equal(page.records.find(row => row.metric === 'net_cash')?.amount?.minor, 15000); };
  const result = await syncWixPaymentsAnalytics(cfg);
  assert.equal(committed, 1); assert.equal(result.status, 'complete'); assert.equal(result.normalizedNetEligible, true); assert.equal(result.definitionVersion, 'net-ttc-v1');
  const net = result.records.find(row => row.metric === 'net_cash')!;
  assert.equal(net.amount?.minor, 15000); assert.equal(net.taxBasis, 'gross'); assert.equal(net.transactionGrain, false); assert.deepEqual(net.dimensions, {});
  assert.equal(result.records.find(row => row.metric === 'wix_refunds_signed')?.amount?.minor, -5000);
  assert.equal(result.breakdown[0].dimensions.method, 'payment_method_inPerson'); assert.equal(result.breakdown[1].dimensions.provider, null);
  assert.equal(result.breakdown[0].values.refunds, null); assert.equal(result.coverage.complete, true); assert.ok(!JSON.stringify(result).includes('FORBIDDEN'));
});

test('Wix Analytics keeps a negative net when refunds exceed payments in a period', async () => {
  const totals = moneyCells(0, -50, -50, 0, 0);
  const result = await syncWixPaymentsAnalytics(config(queue([...prerequisites(), page([refund()], 0, totals)])));
  assert.equal(result.status, 'complete'); assert.equal(result.records.find(row => row.metric === 'net_cash')?.amount?.minor, -5000);
});

test('Wix Analytics source revenue stays usable when a narrower cash definition cannot be reconciled', async () => {
  const cases = [
    { row: payment({ ...moneyCells(200, null, 180, 20) }), totals: moneyCells(200, 0, 180, 20) },
    { row: payment(), totals: moneyCells(200, null, 200) },
    { row: payment({ [mapping.dimensions.status]: { stringValue: 'payment_status_new' } }), totals: moneyCells(200, 0, 200) },
  ];
  for (const value of cases) {
    const result = await syncWixPaymentsAnalytics(config(queue([...prerequisites(), page([value.row], 0, value.totals)])));
    assert.equal(result.status, 'complete'); assert.equal(result.normalizedNetEligible, false); assert.equal(result.definitionVersion, null);
    assert.ok(result.records.some(row => row.metric === 'wix_total_revenue')); assert.ok(!result.records.some(row => row.metric === 'net_cash'));
  }
});

test('Wix Analytics validates signed precision, missing fields, source-date bounds and totals', async () => {
  const missingField = payment(); delete (missingField.fields as Record<string, unknown>)[mapping.measures.revenue];
  for (const resultPage of [
    page([payment(), refund()], 0, moneyCells(200, -50, 999)),
    page([payment({ [mapping.measures.paid]: { numericValue: '200.001' } })]),
    page([missingField]), page([payment({ [mapping.dimensions.day]: { timestampValue: '2026-01-31T23:00:00Z' } })]),
  ]) {
    const result = await syncWixPaymentsAnalytics(config(queue([...prerequisites(), resultPage])));
    assert.notEqual(result.status, 'complete'); assert.equal(result.records.length, 0); assert.equal(result.coverage.complete, false); assert.deepEqual(result.checkpoint, {});
  }
});

test('Wix Analytics checks currency, reviewed schema dependencies and explicit date filters before reading data', async () => {
  const wrongCurrency = prerequisites(); wrongCurrency[0] = response({ properties: { paymentCurrency: 'USD', timeZone: 'Europe/Paris' } });
  const altered = schema(); altered.semanticModel.measures[0].dependencies = ['private.unqueried'] as never[];
  const alteredPrerequisites = prerequisites(); alteredPrerequisites[2] = response(altered);
  const filter = schema(); filter.semanticModel.dimensions.find(row => row.name === mapping.dimensions.day)!.filters.conditions = ['RANGE_II'];
  const filterPrerequisites = prerequisites(); filterPrerequisites[2] = response(filter);
  for (const [inputs, expected] of [[wrongCurrency, /CURRENCY_OR_TIMEZONE/], [alteredPrerequisites, /SCHEMA_CHANGED/], [filterPrerequisites, /DATE_FILTER_UNSUPPORTED/]] as const) {
    const result = await syncWixPaymentsAnalytics(config(queue(inputs))); assert.match(result.safeError!, expected); assert.equal(result.records.length, 0);
  }
});

test('Wix Analytics paginates and publishes one complete aggregate batch; drifting totals and duplicates fail closed', async () => {
  let commits = 0;
  const cfg = { ...config(queue([...prerequisites(), page([payment()], 0), page([refund()], 1), page([], 2)])), pageSize: 1 };
  cfg.commitPage = async () => { commits++; };
  const result = await syncWixPaymentsAnalytics(cfg); assert.equal(result.status, 'complete'); assert.equal(commits, 1); assert.equal(result.counts.pages, 3);
  for (const second of [page([refund()], 1, moneyCells(200, -60, 140)), page([payment()], 1), response({ secret: 'FORBIDDEN_PRIVATE_ERROR' }, 403)]) {
    const failed = await syncWixPaymentsAnalytics({ ...config(queue([...prerequisites(), page([payment()], 0), second])), pageSize: 1 });
    assert.equal(failed.status, 'partial'); assert.deepEqual(failed.records, []); assert.deepEqual(failed.checkpoint, {}); assert.ok(!JSON.stringify(failed).includes('FORBIDDEN'));
  }
});

test('Wix Analytics does not fabricate zero from an empty report or publish on persistence failure', async () => {
  const empty = await syncWixPaymentsAnalytics(config(queue([...prerequisites(), response({ results: [], pagingMetadata: { count: 0, offset: 0 } })])));
  assert.equal(empty.status, 'empty'); assert.equal(empty.coverage.complete, false); assert.equal(empty.records.length, 0);
  const cfg = config(queue([...prerequisites(), page()])); cfg.commitPage = async () => { throw new Error('FORBIDDEN_TRANSACTION_ERROR'); };
  const failed = await syncWixPaymentsAnalytics(cfg); assert.equal(failed.records.length, 0); assert.equal(failed.normalizedNetEligible, false); assert.deepEqual(failed.checkpoint, {});
});


test('Wix handles acknowledged overflow rows and totals supplied only on the first page',async()=>{
 const third=payment({[mapping.dimensions.day]:{timestampValue:'2026-01-05T23:00:00Z'}});
 const second=response({results:[refund(),third],pagingMetadata:{count:2,offset:1}});
 const last=response({results:[],pagingMetadata:{count:0,offset:3}});
 const offsets:number[]=[];
 const result=await syncWixPaymentsAnalytics({...config(queue([...prerequisites(),page([payment()],0,moneyCells(400,-50,350,0,2)),second,last],(url,init)=>{if(url.pathname.endsWith('/query-data'))offsets.push(JSON.parse(String(init.body)).paging.offset);})),pageSize:1});
 assert.equal(result.status,'complete');assert.equal(result.records.find(r=>r.metric==='wix_total_revenue')?.amount?.minor,35000);
 assert.equal(result.counts.read,3);assert.deepEqual(offsets,[0,1,3]);
});
