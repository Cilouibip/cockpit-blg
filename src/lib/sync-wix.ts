import { Temporal } from '@js-temporal/polyfill';
import { syncWixPaymentsAnalytics, WIX_PAYMENTS_ANALYTICS_MAPPING } from '../connectors/wix-payments-analytics';
import { startOfParisDay } from '../domain/dates';
import { database, type Database } from './db';
import { getConfig } from './config';
import { AppError } from './errors';
import type { Metric } from './ui-contract';

type Options = { db?: Database; reader?: typeof syncWixPaymentsAnalytics; env?: NodeJS.ProcessEnv };
/** Publish a complete, reconciled source aggregate only after all pages were read.
 * Exact periods remain separate: a monthly total is never spread over days. */
export async function synchronizeWix(from: string, to: string, options: Options = {}) {
  const env = options.env ?? process.env;
  if (getConfig(env).mode === 'demo') throw new AppError('La synchronisation réelle est désactivée en démonstration.', 409, 'demo_mode');
  const days = Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to)).days;
  if (days < 1 || days > 367) throw new AppError('Choisis une période de 1 à 367 jours.', 400, 'invalid_period');
  const namespace = env.WIX_SITE_ID;
  if (!namespace || !env.WIX_API_KEY) throw new AppError('La connexion Wix doit être renseignée.', 503, 'source_missing');
  const db = options.db ?? database(), start = startOfParisDay(from), end = startOfParisDay(to);
  const runId = await db.rpc<string>('begin_sync', { p_source: 'wix', p_namespace: namespace, p_from: start, p_to: end,
    p_profile: WIX_PAYMENTS_ANALYTICS_MAPPING.version, p_coverage_kind: 'aggregate_period', p_date_from: from, p_date_to: to });
  let finished = false;
  try {
    const result = await (options.reader ?? syncWixPaymentsAnalytics)({ apiKey: env.WIX_API_KEY, siteId: namespace,
      from: start, to: end, timezone: 'Europe/Paris' });
    if (result.status === 'complete' && result.coverage.complete) {
      const daily = new Map<string, number>();
      for (const row of result.breakdown) {
        if (!row.dimensions.day || row.values.revenue === null) continue;
        const day = Temporal.Instant.from(row.dimensions.day).toZonedDateTimeISO('Europe/Paris').toPlainDate().toString();
        daily.set(day, (daily.get(day) ?? 0) + row.values.revenue);
      }
      const rows = result.records.map(record => ({
        source: 'wix', source_namespace: namespace, metric_key: record.metric, period_from: start, period_to: end,
        dimensions_key: 'all', report_profile_key: WIX_PAYMENTS_ANALYTICS_MAPPING.version, sync_run_id: runId,
        timezone: 'Europe/Paris', coverage_state: 'complete', value: record.amount?.minor ?? record.count,
        unit: record.amount ? 'minor' : 'count', currency: record.amount?.currency ?? null, currency_exponent: record.amount ? 2 : null,
        tax_basis: record.taxBasis === 'gross' ? 'tax_inclusive' : 'unknown', dimensions: {},
        definition_version: record.metric === 'net_cash' ? 'net-ttc-v1' : WIX_PAYMENTS_ANALYTICS_MAPPING.version,
        source_locator: `wix:analytics:${WIX_PAYMENTS_ANALYTICS_MAPPING.modelSlug}:${record.externalId}`,
      }));
      for (const [day, minor] of daily) {
        if (!Number.isSafeInteger(minor)) throw new AppError('Montant Wix hors limite.', 422, 'invalid_record');
        rows.push({ source:'wix',source_namespace:namespace,metric_key:'wix_daily_revenue',period_from:start,period_to:end,
          dimensions_key:`day:${day}`,report_profile_key:WIX_PAYMENTS_ANALYTICS_MAPPING.version,sync_run_id:runId,
          timezone:'Europe/Paris',coverage_state:'complete',value:minor,unit:'minor',currency:'EUR',currency_exponent:2,
          tax_basis:'tax_inclusive',dimensions:{date:day},definition_version:WIX_PAYMENTS_ANALYTICS_MAPPING.version,
          source_locator:`wix:analytics:${WIX_PAYMENTS_ANALYTICS_MAPPING.modelSlug}:day:${day}` });
      }
      await db.upsert('source_aggregates', rows, 'source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id');
    }
    const status = result.status === 'not_configured' ? 'failed' : result.status;
    await db.rpc('finish_sync', { p_run: runId, p_status: status, p_read: result.counts.read, p_rejected: result.counts.rejected,
      // An empty query completed its pagination, but carries no measured zero.
      p_complete: result.coverage.complete || result.status === 'empty',
      p_error: result.safeError?.replace(/[^A-Za-z0-9_ -]/g, '').slice(0,100) ?? null });
    finished = true;
    return { status, counts: result.counts, coverage: result.coverage, runId, netAvailable: result.normalizedNetEligible };
  } finally {
    if (!finished) await db.rpc('finish_sync', { p_run: runId, p_status: 'failed', p_read: 0, p_rejected: 0, p_complete: false, p_error: 'WIX_IMPORT_FAILED' }).catch(() => undefined);
  }
}

const inFlight = new Map<string, Promise<void>>();
const attempted = new Map<string, number>();
/** Refresh the exact requested period, at most every 15 minutes per process.
 * An unavailable source does not prevent reading the other dashboard metrics. */
export async function ensureWixPeriod(from: string, to: string) {
  if (getConfig().mode === 'demo' || !process.env.WIX_API_KEY || !process.env.WIX_SITE_ID) return;
  const key = `${process.env.WIX_SITE_ID}:${from}:${to}`;
  if (inFlight.has(key)) return inFlight.get(key);
  if (Date.now() - (attempted.get(key) ?? 0) < 15 * 60_000) return;
  const work = (async () => {
    attempted.set(key, Date.now());
    if (attempted.size > 100) attempted.delete(attempted.keys().next().value!);
    try {
      const db = database();
      const rows = await db.select('source_aggregates', { eq: { source: 'wix', source_namespace: process.env.WIX_SITE_ID!,
        metric_key: 'net_cash', period_from: startOfParisDay(from), period_to: startOfParisDay(to), report_profile_key: WIX_PAYMENTS_ANALYTICS_MAPPING.version } });
      for (const row of rows) {
        const [run] = await db.select('sync_runs', { eq: { id: String(row.sync_run_id) }, limit: 1 });
        if (run?.status === 'complete' && run.pagination_complete && Date.now() - Date.parse(String(run.finished_at)) < 15 * 60_000) return;
      }
      await synchronizeWix(from, to);
    } catch { /* The stored source timestamp remains visible in the metric detail. */ }
  })();
  inFlight.set(key, work);
  try { await work; } finally { inFlight.delete(key); }
}

/** A Wix-reported total is usable under its own definition even when its
 * optional refund/gift-card cells are null. Never replace those nulls with zero. */
export async function readWixReportedPeriod(db: Database, from: string, to: string): Promise<{cash:Metric;dailyRevenue:{date:string;value:number}[]} | null> {
  const namespace = process.env.WIX_SITE_ID;
  if (!namespace) return null;
  const rows = await db.select('source_aggregates', { eq: { source: 'wix', source_namespace: namespace,
    metric_key: 'wix_total_revenue', period_from: startOfParisDay(from), period_to: startOfParisDay(to), dimensions_key: 'all',
    report_profile_key: WIX_PAYMENTS_ANALYTICS_MAPPING.version, coverage_state: 'complete' } });
  const valid = [];
  for (const row of rows) {
    if (row.currency !== 'EUR' || row.currency_exponent !== 2 || row.unit !== 'minor' || row.tax_basis !== 'tax_inclusive' ||
      row.timezone !== 'Europe/Paris' || row.value === null || !Number.isSafeInteger(Number(row.value))) continue;
    const [run] = await db.select('sync_runs', { eq: { id: String(row.sync_run_id) }, limit: 1 });
    if (run?.status === 'complete' && run.pagination_complete && run.source === 'wix' && run.source_namespace === namespace) valid.push({ row, run });
  }
  const latest = valid.sort((a, b) => String(b.run.finished_at).localeCompare(String(a.run.finished_at)))[0];
  if (!latest) return null;
  const daily = await db.select('source_aggregates',{eq:{source:'wix',source_namespace:namespace,metric_key:'wix_daily_revenue',sync_run_id:String(latest.row.sync_run_id)},limit:1000});
  const dailyRevenue = daily.filter(row=>row.currency==='EUR' && row.unit==='minor' && Number.isSafeInteger(Number(row.value)) &&
    typeof (row.dimensions as {date?:unknown})?.date==='string').map(row=>({date:(row.dimensions as {date:string}).date,value:Number(row.value)/100}));
  return { dailyRevenue, cash: { id: 'cash', label: 'CA encaissé', value: Number(latest.row.value) / 100, unit: 'eur', source: 'Wix · synthèse des paiements',
    definition: 'Total TTC des paiements selon Wix, après remboursements, cartes cadeaux utilisées et rétrofacturations, avant frais de paiement. Inclut les paiements confirmés manuellement dans Wix.',
    coverage: 'Total calculé par Wix pour la période sélectionnée. Les cellules de détail absentes restent inconnues.',
    updatedAt: String(latest.run.finished_at) } };
}
