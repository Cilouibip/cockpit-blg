import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWixTransaction, syncWixTransactions, type WixTransactionsConfig } from '../src/connectors/wix-transactions';

const context = { siteId: '44444444-4444-4444-8444-444444444444', observedAt: '2026-09-07T12:00:00Z', currencyExponents: { EUR: 2, JPY: 0 } };
const transaction = (extra = {}) => ({ transactionId: 'synthetic-payment-1', status: 'APPROVED', type: 'SALE',
  createdAt: '2026-01-10T10:00:00Z', provider: 'synthetic-provider', paymentMethod: 'synthetic-card',
  amount: { amount: 120.29, currency: 'EUR' }, refunds: [], ...extra });
const refund = (extra = {}) => ({ refundId: 'synthetic-refund-1', amount: 20.29, type: 'PARTIAL', status: 'SUCCEEDED', createdAt: '2026-02-10T10:00:00Z', ...extra });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const page = (transactions: unknown[], offset = 0, total = transactions.length, limit = 2) => response({ transactions, pagination: { offset, total, limit } });
function queue(values: Response[], inspect?: (url: URL, init: RequestInit) => void): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    inspect?.(new URL(String(input)), init ?? {});
    const result = values.shift(); assert.ok(result, 'Unexpected request'); return result;
  }) as typeof fetch;
}
const config = (fetcher: typeof fetch): WixTransactionsConfig => ({ ...context, apiKey: 'synthetic-key',
  from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z', pageSize: 2, fetcher, sleep: async () => {}, now: () => context.observedAt });

test('Wix source facts never become settled cash, TTC, fees or a bank payout', () => {
  const rows = normalizeWixTransaction(transaction({ provider: 'synthetic-offline', platformFee: 1.5,
    paymentMethodData: { cardNumber: 'FORBIDDEN_CARD' }, order: { description: 'FORBIDDEN_CUSTOMER' },
    providerFields: { token: 'FORBIDDEN_TOKEN' } }), context);
  assert.equal(rows[0].amount.minor, 12029); assert.equal(rows[0].sourceStatus, 'APPROVED');
  assert.equal(rows[0].taxBasis, 'unknown'); assert.equal(rows[0].dateBasis, 'transaction_created');
  assert.equal(rows[0].platformFeeSourceAmount, '1.5'); assert.equal(rows[0].providerFees, null); assert.equal(rows[0].netAfterFees, null);
  assert.equal('effectiveAt' in rows[0], false); assert.equal('status' in rows[0], false);
  assert.ok(!JSON.stringify(rows).includes('FORBIDDEN'));
});

test('Wix preserves original receipts and separate refund request dates, statuses and stable IDs', () => {
  const rows = normalizeWixTransaction(transaction({ status: 'PARTIAL_REFUND', refunds: [refund(), refund(), refund({ refundId: 'pending', status: 'PENDING', amount: 50 }), refund({ refundId: 'failed', status: 'FAILED', amount: 100 })] }), context);
  assert.equal(rows.length, 4); assert.equal(rows[0].amount.minor, 12029);
  assert.deepEqual(rows.slice(1).map(r => r.sourceStatus), ['SUCCEEDED', 'PENDING', 'FAILED']);
  assert.equal(rows[1].originalPaymentId, rows[0].externalId); assert.equal(rows[1].dateBasis, 'refund_requested');
  assert.equal(rows[1].amount.minor, 2029); assert.equal(rows[1].createdAt, '2026-02-10T10:00:00Z');
  assert.equal(rows[1].externalId, normalizeWixTransaction(transaction({ refunds: [refund()] }), context)[1].externalId);
  assert.notEqual(rows[1].externalId, normalizeWixTransaction(transaction({ transactionId: 'other-parent', refunds: [refund()] }), context)[1].externalId);
});

test('Wix rejects conflicting, missing, excessive or chronologically impossible refunds', () => {
  for (const raw of [
    transaction({ refunds: undefined }), transaction({ status: 'REFUND' }),
    transaction({ refunds: [refund(), refund({ amount: 10 })] }),
    transaction({ refunds: [refund({ amount: 130 })] }),
    transaction({ refunds: [refund({ amount: 80 }), refund({ refundId: 'another', amount: 80 })] }),
    transaction({ refunds: [refund({ createdAt: '2025-01-01T00:00:00Z' })] }),
  ]) assert.throws(() => normalizeWixTransaction(raw, context));
});

test('Wix money is exact in configured minor units and never silently rounded or converted', () => {
  assert.equal(normalizeWixTransaction(transaction({ amount: { amount: '120.2900', currency: 'EUR' } }), context)[0].amount.minor, 12029);
  assert.equal(normalizeWixTransaction(transaction({ amount: { amount: 123, currency: 'JPY' } }), context)[0].amount.minor, 123);
  assert.equal(normalizeWixTransaction(transaction({ status: 'BUYER_CANCELED', amount: { amount: 0, currency: 'EUR' } }), context)[0].amount.minor, 0);
  for (const amount of [-1, '1.001', Number.NaN, Number.POSITIVE_INFINITY, '90071992547410', '1e2', '', ' 2 ']) {
    assert.throws(() => normalizeWixTransaction(transaction({ amount: { amount, currency: 'EUR' } }), context));
  }
  assert.throws(() => normalizeWixTransaction(transaction({ amount: { amount: 10, currency: 'USD' } }), context), /UNMAPPED_WIX_CURRENCY/);
  assert.throws(() => normalizeWixTransaction(transaction({ amount: { amount: 1.5, currency: 'JPY' } }), context));
});

test('Wix rejects impossible calendar dates, missing offsets and unknown statuses', () => {
  for (const createdAt of ['2026-02-30T00:00:00Z', '2026-01-01', '2026-01-01T10:00:00', 'not-a-date']) {
    assert.throws(() => normalizeWixTransaction(transaction({ createdAt }), context), /INVALID_WIX_DATE/);
  }
  assert.equal(normalizeWixTransaction(transaction({ createdAt: '2026-01-10T11:00:00+01:00' }), context)[0].createdAt, '2026-01-10T10:00:00Z');
  assert.throws(() => normalizeWixTransaction(transaction({ status: 'NEW_UNKNOWN_STATUS' }), context), /UNKNOWN_WIX_STATUS/);
  for (const status of ['AUTHORIZED', 'PENDING', 'APPROVED', 'OFFLINE', 'FAILED', 'CHARGE_BACK', 'DISPUTE', 'VOID', 'COMPLETED_FUNDS_HELD']) {
    assert.equal(normalizeWixTransaction(transaction({ status }), context)[0].sourceStatus, status);
  }
});

test('Wix paginates on fixed host, includes old-parent refunds, and selects half-open source-date interval', async () => {
  const urls: URL[] = [];
  const cfg = config(queue([
    page([transaction({ createdAt: '2025-01-01T00:00:00Z', refunds: [refund()] }), transaction({ transactionId: 'synthetic-start', createdAt: '2026-02-01T00:00:00Z' })], 0, 3),
    page([transaction({ transactionId: 'synthetic-end', refunds: [refund({ createdAt: '2026-03-01T00:00:00Z' })] })], 2, 3),
  ], (url, init) => {
    urls.push(url); assert.equal(url.origin, 'https://www.wixapis.com'); assert.equal(url.pathname, '/payments/v2/transactions');
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal((init.headers as Record<string, string>)['wix-site-id'], context.siteId);
    assert.equal(url.searchParams.get('includeRefunds'), 'true'); assert.equal(url.searchParams.get('order'), 'date:asc');
    assert.equal(url.searchParams.has('from'), false); assert.equal(url.searchParams.has('status'), false); assert.ok(!String(url).includes('synthetic-key'));
  }));
  cfg.from = '2026-02-01T00:00:00Z';
  const result = await syncWixTransactions(cfg);
  assert.equal(urls.length, 2); assert.equal(urls[1].searchParams.get('offset'), '2');
  assert.equal(result.status, 'complete'); assert.equal(result.snapshot.paginationComplete, true);
  assert.equal(result.records.length, 2); assert.equal(result.records[0].kind, 'refund');
  assert.equal(result.records[0].originalPaymentId, 'payment:synthetic-payment-1'); assert.equal(result.records[1].externalId, 'payment:synthetic-start');
  assert.equal(result.coverage.complete, false); assert.deepEqual(result.normalizedPayments, []); assert.deepEqual(result.checkpoint, {});
});

test('Wix rejects drifting totals, malformed metadata, repeated rows and API filter mismatch', async () => {
  const first = [transaction(), transaction({ transactionId: 'second' })];
  for (const next of [
    page([transaction({ transactionId: 'third' })], 2, 4),
    page([transaction({ transactionId: 'third' })], 1, 3),
    page([], 2, 3), page([transaction()], 2, 3), page([transaction({ amount: { amount: 10, currency: 'EUR' } })], 2, 3),
    page([transaction({ transactionId: 'third', createdAt: '2026-03-01T00:00:00Z' })], 2, 3),
  ]) {
    const result = await syncWixTransactions(config(queue([page(first, 0, 3), next])));
    assert.equal(result.status, 'partial'); assert.equal(result.records.length, 2); assert.equal(result.coverage.complete, false);
    assert.equal(result.snapshot.paginationComplete, false); assert.ok(result.checkpoint.cursor);
  }
});

test('Wix rejected rows pin the checkpoint and successful retries never duplicate observations', async () => {
  const cfg = config(queue([page([transaction({ transactionId: 'invalid', amount: { amount: '1.001', currency: 'EUR' } }), transaction()], 0, 3), page([transaction({ transactionId: 'third' })], 2, 3)]));
  const checkpoints: unknown[] = []; cfg.commitPage = async page => { checkpoints.push(page.checkpoint); assert.equal(page.terminal, false); };
  const result = await syncWixTransactions(cfg);
  assert.equal(result.status, 'partial'); assert.equal(result.counts.rejected, 1); assert.equal(result.records.length, 2);
  assert.deepEqual(checkpoints, [{}, {}]); assert.deepEqual(result.checkpoint, {});
});

test('Wix persistence failure does not expose rows or advance the prior committed checkpoint', async () => {
  const cfg = config(queue([page([transaction(), transaction({ transactionId: 'second' })], 0, 3), page([transaction({ transactionId: 'third' })], 2, 3)]));
  let commits = 0; cfg.commitPage = async () => { if (++commits === 2) throw new Error('FORBIDDEN_PRIVATE_ERROR'); };
  const result = await syncWixTransactions(cfg);
  assert.equal(result.status, 'partial'); assert.equal(result.records.length, 2); assert.ok(result.checkpoint.cursor);
  assert.equal(result.safeError, 'CONNECTOR_FAILED'); assert.ok(!JSON.stringify(result).includes('FORBIDDEN'));
});

test('Wix retries are bounded, errors expurgated, and resume cursor is bound to the site and interval', async () => {
  const initial = await syncWixTransactions({ ...config(queue([page([transaction(), transaction({ transactionId: 'second' })], 0, 3)])), maxPages: 1 });
  assert.equal(initial.status, 'partial'); assert.equal(initial.safeError, 'PAGE_LIMIT_REACHED'); assert.ok(initial.checkpoint.cursor);
  const cursor = initial.checkpoint.cursor;
  const resumed = await syncWixTransactions({ ...config(queue([page([transaction({ transactionId: 'third' })], 2, 3)])), cursor });
  assert.equal(resumed.status, 'partial'); assert.equal(resumed.snapshot.fromBeginning, false); assert.equal(resumed.snapshot.paginationComplete, true);
  const wrong = await syncWixTransactions({ ...config(queue([])), from: '2026-02-01T00:00:00Z', cursor });
  assert.equal(wrong.safeError, 'INVALID_CURSOR'); assert.deepEqual(wrong.checkpoint, {});
  let retries = 0;
  const failed = await syncWixTransactions({ ...config(queue([response({ secret: 'FORBIDDEN_ERROR' }, 503), response({}, 503), response({}, 503)])), sleep: async () => { retries++; } });
  assert.equal(retries, 2); assert.equal(failed.status, 'failed'); assert.ok(!JSON.stringify(failed).includes('FORBIDDEN'));
});

test('Wix empty or unconfigured source never proves zero normalized receipts', async () => {
  const empty = await syncWixTransactions(config(queue([page([])])));
  assert.equal(empty.status, 'empty'); assert.equal(empty.snapshot.paginationComplete, true); assert.equal(empty.coverage.complete, false); assert.deepEqual(empty.normalizedPayments, []);
  const absent = await syncWixTransactions({ ...config(queue([])), apiKey: undefined });
  assert.equal(absent.status, 'not_configured'); assert.equal(absent.snapshot.paginationComplete, false);
});
