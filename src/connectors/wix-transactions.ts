import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type { Evidence, Money, Payment } from '../domain/models';
import { moneyFromDecimal } from '../domain/metrics';
import { ConnectorError, object, readJson, safeConnectorError } from './http';
import { newBatch, type SyncBatch, type SyncOptions } from './types';
import type { WixConfig } from './wix';

/** Schema verified against the official Transactions List reference, 2026-09-07.
 * https://dev.wix.com/docs/api-reference/business-management/payments/cashier/payments/transaction/transactions-list
 * createdAt means transaction creation / refund REQUEST, never settlement.
 * APPROVED includes offline payments. platformFee is not all provider fees.
 */
export const WIX_TRANSACTIONS_VERSION = 'wix-transactions-observed-v1';
export interface WixTransactionObservation extends Evidence {
  kind: 'payment' | 'refund';
  transactionId: string;
  originalPaymentId?: string;
  sourceStatus: string;
  sourceType: string;
  createdAt: string;
  dateBasis: 'transaction_created' | 'refund_requested';
  amount: Money;
  currencyExponent: number;
  /** Allowlisted source identifiers only; no customer/order description/card fields. */
  provider: string;
  paymentMethod: string;
  taxBasis: 'unknown';
  platformFeeSourceAmount: string | null;
  providerFees: null;
  netAfterFees: null;
}
export interface WixTransactionsConfig extends WixConfig, SyncOptions<WixTransactionObservation> {
  /** Explicit currency precision; unlisted currencies are rejected, never converted. */
  currencyExponents: Readonly<Record<string, number>>;
  pageSize?: number;
}
export interface WixTransactionsBatch extends SyncBatch<WixTransactionObservation> {
  snapshot: { paginationComplete: boolean; fromBeginning: boolean; totalTransactions: number | null; observedAt: string | null };
  normalizedPayments: Payment[];
  normalization: { status: 'blocked'; missing: readonly string[] };
}

const transactionStatuses = new Set(['UNDEFINED', 'INITIALIZED', 'IN_PROCESS', 'APPROVED', 'PENDING', 'PENDING_MERCHANT', 'PENDING_BUYER', 'BUYER_CANCELED', 'TIMEOUT', 'REFUND', 'PARTIAL_REFUND', 'VOID', 'CHARGE_BACK', 'EXPIRED', 'DECLINED', 'FAILED', 'COMPLETED_FUNDS_HELD', 'TPA_CANCELED', 'OFFLINE', 'DISPUTE', 'AUTHORIZED']);
const refundStatuses = new Set(['PENDING', 'SUCCEEDED', 'FAILED']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function sourceText(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new ConnectorError('INVALID_WIX_FIELD');
  return value;
}
function instant(value: unknown): string {
  if (typeof value !== 'string') throw new ConnectorError('INVALID_WIX_DATE');
  try { return Temporal.Instant.from(value).toString(); }
  catch { throw new ConnectorError('INVALID_WIX_DATE'); }
}
function nonnegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ConnectorError('INVALID_PAGINATION');
  return value;
}
function money(value: unknown, currency: string, exponent: number, allowZero = false): Money {
  if (typeof value !== 'number' && typeof value !== 'string') throw new ConnectorError('INVALID_WIX_AMOUNT');
  try {
    const result = moneyFromDecimal(String(value), currency, exponent);
    if (result.minor < 0 || (!allowZero && result.minor === 0)) throw new Error();
    return result;
  } catch { throw new ConnectorError('INVALID_WIX_AMOUNT'); }
}

/** Pure minimization: retain source facts without promoting them to Payment. */
export function normalizeWixTransaction(raw: unknown, context: {
  siteId: string; observedAt: string; currencyExponents: Readonly<Record<string, number>>;
}): WixTransactionObservation[] {
  const row = object(raw), amount = object(row.amount);
  const transactionId = sourceText(row.transactionId), status = sourceText(row.status), type = sourceText(row.type);
  if (!transactionStatuses.has(status) || !['SALE', 'RECURRING', 'INITIALIZE_RECURRING'].includes(type)) throw new ConnectorError('UNKNOWN_WIX_STATUS_OR_TYPE');
  const currency = sourceText(amount.currency);
  const exponent = Object.hasOwn(context.currencyExponents, currency) ? context.currencyExponents[currency] : undefined;
  if (exponent === undefined) throw new ConnectorError('UNMAPPED_WIX_CURRENCY');
  const createdAt = instant(row.createdAt), observedAt = instant(context.observedAt);
  if (!uuid.test(context.siteId)) throw new ConnectorError('INVALID_CONFIGURATION');
  let platformFee: string | null = null;
  if (row.platformFee !== undefined) {
    if (typeof row.platformFee !== 'number' || !Number.isFinite(row.platformFee) || row.platformFee < 0) throw new ConnectorError('INVALID_WIX_AMOUNT');
    platformFee = String(row.platformFee);
  }
  const receipt: WixTransactionObservation = {
    source: 'wix', accountId: context.siteId, externalId: `payment:${transactionId}`, transactionId,
    connectorVersion: WIX_TRANSACTIONS_VERSION, observedAt, kind: 'payment', sourceStatus: status, sourceType: type,
    createdAt, dateBasis: 'transaction_created', amount: money(amount.amount, currency, exponent, true), currencyExponent: exponent,
    provider: sourceText(row.provider), paymentMethod: sourceText(row.paymentMethod), taxBasis: 'unknown',
    platformFeeSourceAmount: platformFee, providerFees: null, netAfterFees: null,
  };
  if (!Array.isArray(row.refunds)) throw new ConnectorError('WIX_REFUNDS_MISSING');
  const refunds = new Map<string, WixTransactionObservation>();
  for (const rawRefund of row.refunds) {
    const refund = object(rawRefund), refundId = sourceText(refund.refundId);
    const refundStatus = sourceText(refund.status), refundType = sourceText(refund.type);
    if (!refundStatuses.has(refundStatus) || !['PARTIAL', 'FULL'].includes(refundType)) throw new ConnectorError('UNKNOWN_WIX_STATUS_OR_TYPE');
    const requestedAt = instant(refund.createdAt);
    if (Temporal.Instant.compare(requestedAt, createdAt) < 0) throw new ConnectorError('INVALID_WIX_DATE');
    const value: WixTransactionObservation = { ...receipt, externalId: `refund:${hash([transactionId, refundId])}`,
      kind: 'refund', originalPaymentId: receipt.externalId, createdAt: requestedAt, dateBasis: 'refund_requested',
      sourceStatus: refundStatus, sourceType: refundType, amount: money(refund.amount, currency, exponent), platformFeeSourceAmount: null };
    if (value.amount.minor > receipt.amount.minor) throw new ConnectorError('INVALID_WIX_REFUND_AMOUNT');
    const prior = refunds.get(value.externalId);
    if (prior && hash(prior) !== hash(value)) throw new ConnectorError('CONFLICTING_WIX_REFUND');
    refunds.set(value.externalId, value);
  }
  const succeeded = [...refunds.values()].filter(r => r.sourceStatus === 'SUCCEEDED');
  if (succeeded.reduce((sum, r) => sum + BigInt(r.amount.minor), 0n) > BigInt(receipt.amount.minor)) throw new ConnectorError('INVALID_WIX_REFUND_AMOUNT');
  if (['REFUND', 'PARTIAL_REFUND'].includes(status) && !succeeded.length) throw new ConnectorError('WIX_REFUNDS_MISSING');
  return [receipt, ...refunds.values()];
}

/** Read-only source traversal. This is NOT an effective-cash event interval.
 * Scans all parents created before `to`, including old receipts whose refunds
 * were requested in the selected period. No `from` or APPROVED-only API filter.
 * Offset pagination has no snapshot isolation: any drift/duplicate is partial.
 * A resumed traversal cannot independently prove coverage of earlier pages.
 * No normalized Payment can be emitted until capture/refund effective dates,
 * settlement evidence and tax/amount basis are supplied by a reviewed source.
 */
export async function syncWixTransactions(config: WixTransactionsConfig): Promise<WixTransactionsBatch> {
  const batch: WixTransactionsBatch = {
    ...newBatch<WixTransactionObservation>('wix', config.siteId ?? '', WIX_TRANSACTIONS_VERSION, config.from, config.to),
    snapshot: { paginationComplete: false, fromBeginning: !config.cursor, totalTransactions: null, observedAt: null },
    normalizedPayments: [], normalization: { status: 'blocked', missing: ['effective_payment_and_refund_dates', 'settlement_evidence_including_offline_payments', 'tax_and_amount_basis', 'complete_provider_fees_if_net_after_fees_requested'] },
  };
  if (!config.apiKey || !config.siteId) return batch;
  const seen = new Map<string, WixTransactionObservation>(), transactions = new Map<string, string>();
  let offset = 0;
  try {
    const from = instant(config.from), to = instant(config.to), observedAt = instant(config.now?.() ?? new Date().toISOString());
    const pageSize = config.pageSize ?? 100, maxPages = config.maxPages ?? 100;
    if (!uuid.test(config.siteId) || Temporal.Instant.compare(from, to) >= 0 ||
      !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000 ||
      !Object.keys(config.currencyExponents).length || Object.entries(config.currencyExponents).some(([currency, exponent]) => !/^[A-Z]{3}$/.test(currency) || !Number.isInteger(exponent) || exponent < 0 || exponent > 4)) throw new ConnectorError('INVALID_CONFIGURATION');
    const scope = hash([WIX_TRANSACTIONS_VERSION, config.siteId, from, to, pageSize, Object.entries(config.currencyExponents).sort()]);
    if (config.cursor) {
      const match = /^([a-f0-9]{64}):(\d+):(\d+)$/.exec(config.cursor);
      if (!match || match[1] !== scope) throw new ConnectorError('INVALID_CURSOR');
      offset = nonnegativeInteger(Number(match[2]));
      batch.snapshot.totalTransactions = nonnegativeInteger(Number(match[3]));
      if (!offset || offset >= batch.snapshot.totalTransactions) throw new ConnectorError('INVALID_CURSOR');
      batch.checkpoint = { cursor: config.cursor };
    }
    batch.snapshot.observedAt = observedAt;
    const headers = { Authorization: config.apiKey, 'wix-site-id': config.siteId, 'Content-Type': 'application/json' };
    for (let page = 0; page < maxPages; page++) {
      const url = new URL('https://www.wixapis.com/payments/v2/transactions');
      url.search = new URLSearchParams({ to, order: 'date:asc', includeRefunds: 'true', ignoreTotals: 'false', limit: String(pageSize), offset: String(offset) }).toString();
      const payload = object(await readJson(url, { method: 'GET', headers }, config));
      if (!Array.isArray(payload.transactions)) throw new ConnectorError('INVALID_RESPONSE');
      const pagination = object(payload.pagination), total = nonnegativeInteger(pagination.total);
      if (nonnegativeInteger(pagination.offset) !== offset || nonnegativeInteger(pagination.limit) !== pageSize ||
        payload.transactions.length > pageSize || offset + payload.transactions.length > total || (!payload.transactions.length && offset < total)) throw new ConnectorError('INVALID_PAGINATION');
      if (batch.snapshot.totalTransactions !== null && batch.snapshot.totalTransactions !== total) throw new ConnectorError('WIX_PAGINATION_CHANGED');
      batch.snapshot.totalTransactions = total;
      const pageRecords = new Map<string, WixTransactionObservation>(), pageTransactions = new Map<string, string>();
      for (const raw of payload.transactions) {
        batch.counts.read++;
        try {
          const normalized = normalizeWixTransaction(raw, { siteId: config.siteId, observedAt, currencyExponents: config.currencyExponents });
          const parent = normalized[0], fingerprint = hash(normalized);
          if (Temporal.Instant.compare(parent.createdAt, to) >= 0) throw new ConnectorError('WIX_FILTER_MISMATCH');
          const previous = pageTransactions.get(parent.transactionId) ?? transactions.get(parent.transactionId);
          if (previous) throw new ConnectorError(previous === fingerprint ? 'DUPLICATE_WIX_TRANSACTION' : 'CONFLICTING_WIX_TRANSACTION');
          pageTransactions.set(parent.transactionId, fingerprint);
          for (const row of normalized) if (Temporal.Instant.compare(row.createdAt, from) >= 0 && Temporal.Instant.compare(row.createdAt, to) < 0) pageRecords.set(row.externalId, row);
        } catch (error) { batch.counts.rejected++; batch.safeError ??= safeConnectorError(error); }
      }
      const nextOffset = offset + payload.transactions.length, terminal = nextOffset === total;
      // A rejected row pins the previous checkpoint; a retry must revisit it.
      const checkpoint = batch.counts.rejected ? batch.checkpoint : terminal ? {} : { cursor: `${scope}:${nextOffset}:${total}` };
      await config.commitPage?.({ records: [...pageRecords.values()], checkpoint, terminal: terminal && batch.counts.rejected === 0 });
      pageRecords.forEach((row, id) => seen.set(id, row)); pageTransactions.forEach((value, id) => transactions.set(id, value));
      batch.checkpoint = checkpoint; batch.counts.pages++; batch.counts.accepted = seen.size;
      if (terminal) {
        batch.snapshot.paginationComplete = batch.counts.rejected === 0;
        batch.status = batch.counts.rejected || config.cursor ? 'partial' : total ? 'complete' : 'empty';
        break;
      }
      offset = nextOffset;
      if (page + 1 === maxPages) throw new ConnectorError('PAGE_LIMIT_REACHED');
    }
  } catch (error) {
    batch.status = batch.counts.pages ? 'partial' : 'failed'; batch.safeError = safeConnectorError(error);
  }
  batch.records = [...seen.values()];
  // Even a fully traversed source snapshot does not prove cash/date/TTC coverage.
  batch.coverage = { from: config.from, to: config.to, complete: false, observedAt: batch.snapshot.observedAt ?? undefined,
    reason: 'Observations Wix par date de création ou demande ; dates effectives et base TTC non établies. Aucun encaissement normalisé ni virement bancaire déduit.' };
  return batch;
}
