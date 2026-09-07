import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type { Money, SourceAggregate } from '../domain/models';
import { moneyFromDecimal } from '../domain/metrics';
import { ConnectorError, object, readJson, safeConnectorError } from './http';
import { newBatch, type SyncBatch, type SyncOptions } from './types';
import type { WixConfig } from './wix';

/** Reviewed List -> Get mapping, 2026-09-07. No private site or payment data.
 * Payments Summary is on payment dates and includes manually confirmed payments.
 * Total revenue retains tax; refunds are negative in this model. It also deducts
 * gift-card redemptions and chargebacks, so those must be reconciled before using
 * the narrower net-ttc-v1 definition. Provider fees are NOT deducted here.
 * https://dev.wix.com/docs/api-reference/business-management/analytics/semantic-models/query-semantic-model-data
 * https://support.wix.com/en/article/wix-analytics-financial-glossary
 * https://support.wix.com/en/article/wix-analytics-faqs
 */
export const WIX_PAYMENTS_ANALYTICS_MAPPING = {
  version: 'wix-payments-analytics-v1', modelId: 'a91504fe-8b11-40b1-9783-2b6c2baaa36c', modelSlug: 'transactions-payments',
  reviewedAt: '2026-09-07', currencyBasis: 'wix_site_reporting_currency',
  measures: {
    paid: 'transactions.total_paid_amount', refunds: 'transactions.total_refunds_amount',
    revenue: 'transactions.total_revenue_amount', giftCards: 'transactions.gift_cards_redeemed_amount',
    tax: 'transactions.total_tax_amount', platformFees: 'transactions.total_platform_fees_amount',
    successfulPayments: 'transactions.successful_payments',
  },
  dimensions: {
    provider: 'transactions.payment_provider', method: 'transactions.payment_method',
    status: 'transactions.transaction_payment_status', type: 'transactions.transaction_payment_type',
    day: 'transactions.transaction_timeframe',
  },
} as const;
const mapping = WIX_PAYMENTS_ANALYTICS_MAPPING;
type Measure = keyof typeof mapping.measures;
type Dimension = keyof typeof mapping.dimensions;
export interface WixPaymentAnalyticsSlice {
  dimensions: Record<Dimension, string | null>;
  /** Money in EUR minor units; successfulPayments is a count. Source nulls
   * remain null; refunds remain signed, never subtracted twice. */
  values: Record<Measure, number | null>;
}
export interface WixPaymentsAnalyticsConfig extends WixConfig, SyncOptions<SourceAggregate> {
  timezone: 'Europe/Paris';
  pageSize?: number;
}
export interface WixPaymentsAnalyticsBatch extends SyncBatch<SourceAggregate> {
  breakdown: WixPaymentAnalyticsSlice[];
  sourceTotals: Record<Measure, number | null> | null;
  normalizedNetEligible: boolean;
  normalizationReason: string;
  currencyBasis: typeof mapping.currencyBasis;
  definitionVersion: 'net-ttc-v1' | null;
}
const base = 'https://www.wixapis.com/analytics/semantic-model/v3/semantic-models';
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keys = Object.keys(mapping.measures) as Measure[];
const fields = [...Object.values(mapping.measures), ...Object.values(mapping.dimensions)];

function signedMinor(raw: unknown): number | null {
  const value = object(raw).numericValue;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' && typeof value !== 'string') throw new ConnectorError('INVALID_WIX_AMOUNT');
  const decimal = String(value), negative = decimal.startsWith('-');
  try { return moneyFromDecimal(negative ? decimal.slice(1) : decimal, 'EUR', 2).minor * (negative ? -1 : 1); }
  catch { throw new ConnectorError('INVALID_WIX_AMOUNT'); }
}
function values(raw: unknown): Record<Measure, number | null> {
  const cells = object(raw);
  const result = {} as Record<Measure, number | null>;
  for (const key of keys) {
    const field = mapping.measures[key];
    if (!(field in cells)) throw new ConnectorError('WIX_FIELD_MISSING');
    if (key === 'successfulPayments') {
      const value = object(cells[field]).numericValue;
      if (value === null || value === undefined) result[key] = null;
      else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) result[key] = value;
      else throw new ConnectorError('INVALID_WIX_COUNT');
    } else result[key] = signedMinor(cells[field]);
  }
  if (result.revenue === null) throw new ConnectorError('WIX_REVENUE_MISSING');
  return result;
}
function parseSlice(raw: unknown, from: string, to: string): WixPaymentAnalyticsSlice {
  const cells = object(object(raw).fields), dimensions = {} as Record<Dimension, string | null>;
  for (const key of Object.keys(mapping.dimensions) as Dimension[]) {
    const field = mapping.dimensions[key];
    if (!(field in cells)) throw new ConnectorError('WIX_FIELD_MISSING');
    const cell = object(cells[field]), value = key === 'day' ? cell.timestampValue : cell.stringValue;
    if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > 256)) throw new ConnectorError('INVALID_WIX_DIMENSION');
    dimensions[key] = value as string | undefined ?? null;
  }
  if (!dimensions.day || Temporal.Instant.compare(dimensions.day, from) < 0 || Temporal.Instant.compare(dimensions.day, to) >= 0) throw new ConnectorError('WIX_FILTER_MISMATCH');
  return { dimensions, values: values(cells) };
}

/** This reconciliation gates only net-ttc-v1. Source totals remain usable under
 * their exact Wix definition when gift cards, chargebacks or nulls differ. */
export function reconcileWixPaymentsAnalytics(breakdown: readonly WixPaymentAnalyticsSlice[], totals: Record<Measure, number | null>) {
  for (const key of keys) {
    const supplied = breakdown.map(row => row.values[key]).filter((value): value is number => value !== null);
    const sum = supplied.reduce((sum, value) => sum + BigInt(value), 0n);
    if (totals[key] !== null && (sum !== BigInt(totals[key]!) || !Number.isSafeInteger(totals[key]))) throw new ConnectorError('WIX_TOTALS_MISMATCH');
  }
  const missing = totals.paid === null || totals.refunds === null || totals.giftCards === null;
  const unsupported = breakdown.some(row => {
    const { type, status } = row.dimensions;
    if (type === 'transaction_type_refund') return status !== 'payment_status_refunded' || row.values.refunds === null || row.values.refunds > 0;
    if (type === 'transaction_type_regular_payment') return !['payment_status_approved', 'payment_status_refunded', 'payment_status_partially_refunded'].includes(status ?? '') || row.values.paid === null || row.values.paid < 0;
    return true;
  });
  const exactNet = !missing && totals.giftCards === 0 && totals.paid! >= 0 && totals.refunds! <= 0 &&
    BigInt(totals.paid!) + BigInt(totals.refunds!) === BigInt(totals.revenue!);
  return { eligible: !unsupported && exactNet,
    reason: unsupported ? 'Type ou statut à rapprocher ; mesures Wix conservées.' : !exactNet ? 'Décomposition paiements/remboursements/cartes cadeaux non compatible avec net-ttc-v1 ; total Wix conservé.' : 'Paiements moins remboursements TTC selon Wix, avant frais ; moyens de paiement conservés séparément.' };
}

/** Full aggregate refresh; caller persists only the terminal, reconciled batch.
 * Restart from page zero after interruption because totals cover the full period.
 * EUR is verified via Site Properties, not inferred from an omitted currency field.
 * Amounts use Wix reporting currency (Wix may convert original currencies).
 */
export async function syncWixPaymentsAnalytics(config: WixPaymentsAnalyticsConfig): Promise<WixPaymentsAnalyticsBatch> {
  const batch: WixPaymentsAnalyticsBatch = { ...newBatch<SourceAggregate>('wix', config.siteId ?? '', mapping.version, config.from, config.to),
    breakdown: [], sourceTotals: null, normalizedNetEligible: false, normalizationReason: 'Lecture financière non terminée.', currencyBasis: mapping.currencyBasis, definitionVersion: null };
  if (!config.apiKey || !config.siteId) return batch;
  try {
    const from = Temporal.Instant.from(config.from), to = Temporal.Instant.from(config.to);
    const observedAt = Temporal.Instant.from(config.now?.() ?? new Date().toISOString()).toString();
    const pageSize = config.pageSize ?? 1000, maxPages = config.maxPages ?? 100;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(config.siteId) ||
      config.timezone !== 'Europe/Paris' || Temporal.Instant.compare(from, to) >= 0 || config.cursor ||
      !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000 ||
      [from, to].some(i => i.toZonedDateTimeISO(config.timezone).toPlainTime().toString() !== '00:00:00')) throw new ConnectorError('INVALID_CONFIGURATION');
    const headers = { Authorization: config.apiKey, 'wix-site-id': config.siteId, 'Content-Type': 'application/json' };
    const propertyUrl = new URL('https://www.wixapis.com/site-properties/v4/properties');
    propertyUrl.searchParams.append('fields.paths', 'paymentCurrency'); propertyUrl.searchParams.append('fields.paths', 'timeZone');
    const properties = object(object(await readJson(propertyUrl, { method: 'GET', headers }, config)).properties);
    if (properties.paymentCurrency !== 'EUR' || properties.timeZone !== config.timezone) throw new ConnectorError('WIX_CURRENCY_OR_TIMEZONE_CHANGED');
    const listed = object(await readJson(new URL(base), { method: 'GET', headers }, config));
    if (!Array.isArray(listed.semanticModels) || !listed.semanticModels.some(raw => { const row = object(raw); return row.id === mapping.modelId && row.slug === mapping.modelSlug; })) throw new ConnectorError('WIX_MODEL_IDENTITY_MISMATCH');
    const schema = object(object(await readJson(new URL(`${base}/${mapping.modelId}`), { method: 'GET', headers }, config)).semanticModel);
    if (schema.id !== mapping.modelId || schema.slug !== mapping.modelSlug || !Array.isArray(schema.measures) || !Array.isArray(schema.dimensions)) throw new ConnectorError('WIX_MODEL_IDENTITY_MISMATCH');
    const available = [...schema.measures, ...schema.dimensions].map(object);
    for (const field of fields) {
      const found = available.find(row => row.name === field);
      const type = field === mapping.dimensions.day ? 'DATE_TIME' : Object.values(mapping.measures).some(name => name === field) ? 'NUMBER' : 'STRING';
      if (!found || found.type !== type || !Array.isArray(found.dependencies) || (found.dependencies.length && !found.dependencies.some(dep => fields.includes(dep as typeof fields[number])))) throw new ConnectorError('WIX_SCHEMA_CHANGED');
    }
    const date = available.find(row => row.name === mapping.dimensions.day)!;
    const filters = object(date.filters);
    if (!date.sortable || !Array.isArray(filters.conditions) || !filters.conditions.includes('RANGE_IE') || !Array.isArray(filters.prefixes) || !filters.prefixes.includes('IS')) throw new ConnectorError('WIX_DATE_FILTER_UNSUPPORTED');
    const seen = new Set<string>(); let offset = 0, totalsFingerprint: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const payload = object(await readJson(new URL(`${base}/query-data`), { method: 'POST', headers,
        body: JSON.stringify({ semanticModelId: mapping.modelId, interval: { start: from.toString(), end: to.toString(), timezone: config.timezone }, fields,
          filters: [{ field: mapping.dimensions.day, prefix: 'IS', condition: 'RANGE_IE', values: [from.toString(), to.toString()] }],
          sort: { fieldName: mapping.dimensions.day, order: 'ASC' }, paging: { limit: pageSize, offset }, formattingEnabled: false, totalsIncluded: true }) }, config));
      if (!Array.isArray(payload.results)) throw new ConnectorError('INVALID_RESPONSE');
      const metadata = object(payload.pagingMetadata);
      // Wix may return more rows than requested. Consume every acknowledged row
      // within the API ceiling, retain duplicate/offset/totals reconciliation.
      if (metadata.count !== payload.results.length || metadata.offset !== offset || payload.results.length > 1000) throw new ConnectorError('INVALID_PAGINATION');
      // Empty response has no measured zero. Missing totals on an empty result is valid.
      if (!payload.results.length && !offset) {
        batch.status = 'empty'; batch.coverage = { from: config.from, to: config.to, complete: false, observedAt, reason: 'Aucune mesure Wix ; aucun zéro normalisé créé.' }; return batch;
      }
      // The source supplies whole-period totals on its first page only.
      // If repeated later, they must still match; final row sums must reconcile.
      const totals = payload.totals === undefined && offset > 0 && batch.sourceTotals ? batch.sourceTotals : values(object(payload.totals).fields);
      const currentFingerprint = fingerprint(totals);
      if (totalsFingerprint !== null && totalsFingerprint !== currentFingerprint) throw new ConnectorError('WIX_TOTALS_CHANGED');
      totalsFingerprint = currentFingerprint; batch.sourceTotals = totals;
      const rows: WixPaymentAnalyticsSlice[] = [];
      for (const raw of payload.results) {
        batch.counts.read++;
        const row = parseSlice(raw, from.toString(), to.toString()), key = fingerprint(row.dimensions);
        if (seen.has(key)) throw new ConnectorError('DUPLICATE_WIX_AGGREGATE');
        seen.add(key); rows.push(row);
      }
      batch.breakdown.push(...rows); batch.counts.pages++; batch.counts.accepted = batch.breakdown.length;
      if (payload.results.length < pageSize) {
        const reconciliation = reconcileWixPaymentsAnalytics(batch.breakdown, totals);
        const metricNames: Partial<Record<Measure, string>> = { paid: 'wix_amount_paid', refunds: 'wix_refunds_signed', revenue: 'wix_total_revenue', giftCards: 'wix_gift_cards_redeemed', successfulPayments: 'wix_successful_payments' };
        const aggregate = (metric: string, amount: Money | null, count: number | null): SourceAggregate => ({ source: 'wix', accountId: config.siteId!,
          externalId: fingerprint([mapping.version, config.siteId, metric, config.from, config.to, config.timezone, 'EUR']), observedAt, connectorVersion: mapping.version,
          metric, from: config.from, to: config.to, timezone: config.timezone, amount, count, taxBasis: 'gross', dimensions: {}, transactionGrain: false });
        const records = keys.filter(key => metricNames[key] && totals[key] !== null).map(key => aggregate(metricNames[key]!, key === 'successfulPayments' ? null : { minor: totals[key]!, currency: 'EUR' }, key === 'successfulPayments' ? totals[key] : null));
        if (reconciliation.eligible) records.push(aggregate('net_cash', { minor: totals.revenue!, currency: 'EUR' }, null));
        await config.commitPage?.({ records, checkpoint: { completedThrough: config.to }, terminal: true });
        batch.records = records; batch.normalizedNetEligible = reconciliation.eligible; batch.normalizationReason = reconciliation.reason;
        batch.definitionVersion = reconciliation.eligible ? 'net-ttc-v1' : null; batch.checkpoint = { completedThrough: config.to }; batch.status = 'complete';
        batch.coverage = { from: config.from, to: config.to, complete: true, observedAt, reason: `${reconciliation.reason} Devise de reporting du site ; données observées à la synchronisation.` };
        return batch;
      }
      offset += payload.results.length;
    }
    throw new ConnectorError('PAGE_LIMIT_REACHED');
  } catch (error) {
    batch.status = batch.counts.pages ? 'partial' : 'failed'; batch.safeError = safeConnectorError(error);
    batch.normalizationReason = 'Lecture ou réconciliation incomplète ; aucun agrégat publié.';
    batch.coverage.reason = batch.normalizationReason;
    return batch;
  }
}
