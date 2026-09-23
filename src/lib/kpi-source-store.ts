import { Temporal } from '@js-temporal/polyfill';
import { createHash } from 'node:crypto';
import type { Database, Row } from './db';
import { startOfParisDay } from '../domain/dates';
import { ConnectorError, safeConnectorError } from '../connectors/http';

export const KPI_PROFILE = 'kpi-funnel-sources-v1';
export type KpiSource = 'meta' | 'posthog' | 'wix';
export const kpiStream = (source: KpiSource) => `kpi_${source}_daily`;
export interface KpiSourceRow { day: string; key: string; data: Row }
export interface KpiSourceBatch { rows: KpiSourceRow[]; observedAt: string; from: string; to: string }
export interface KpiStoredSource { days: Map<string, { rows: KpiSourceRow[]; observedAt: string; runId: string }>; latestAttempt: Row | null }
export const nextDay = (day: string) => Temporal.PlainDate.from(day).add({ days: 1 }).toString();
export function kpiDays(from: string, to: string) {
 const dates: string[] = [];
 for (let day = Temporal.PlainDate.from(from); day.toString() < to; day = day.add({ days: 1 })) {
  if (dates.length >= 367) throw new ConnectorError('KPI_PERIOD_TOO_LONG');
  dates.push(day.toString());
 }
 return dates;
}
export async function pagedRows(db: Database, table: Parameters<Database['select']>[0], options: Parameters<Database['select']>[1], max = 50000) {
 const rows: Row[] = [];
 for (let from = 0; from < max; from += 1000) {
  const page = await db.select(table, { ...options, from, limit: 1000 }); rows.push(...page);
  if (page.length < 1000) return rows;
 }
 throw new ConnectorError('KPI_READ_LIMIT');
}
// PostgreSQL JSONB may reorder object keys. Integrity must depend on values, not serialization order.
function canonical(value: unknown): unknown {
 if (Array.isArray(value)) return value.map(canonical);
 if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
 return value;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
/** Métriques d'une publication KPI (lignes quotidiennes et manifeste par jour), au format tableau PostgreSQL :
 * db.ts transmet un tableau JS en JSON, que PostgreSQL ne convertit pas en text[] ; la forme littérale est lue
 * à l'identique par PostgreSQL et par PostgREST. */
const KPI_STATE_METRICS = '{kpi_daily_row,kpi_daily_manifest}';
/** Only complete source responses become a publication. Earlier publications and failed attempts stay intact.
 * Les lignes sont préparées (sync_run_id = tentative, is_current = false) puis publiées en une transaction par
 * cockpit_publish_aggregate_state (migration 018) : un objet inchangé n'ajoute aucune ligne, un objet modifié met à
 * jour la même ligne, un objet absent est retiré de l'état courant sans être effacé. */
export async function syncKpiSource(db: Database, source: KpiSource, namespace: string, from: string, to: string, read: () => Promise<KpiSourceBatch>) {
 const run = await db.rpc<string>('begin_sync_stream', { p_source: source, p_namespace: namespace, p_from: startOfParisDay(from), p_to: startOfParisDay(to), p_profile: KPI_PROFILE, p_stream: kpiStream(source), p_coverage_kind: 'aggregate_period', p_date_from: from, p_date_to: to });
 try {
  const batch = await read(), dates = kpiDays(from, to);
  if (batch.from !== from || batch.to !== to || !Number.isFinite(Date.parse(batch.observedAt))) throw new ConnectorError('KPI_SOURCE_SCOPE_MISMATCH');
  const keys = new Set<string>();
  for (const row of batch.rows) {
   const key = row.day + ':' + row.key;
   if (!dates.includes(row.day) || keys.has(key)) throw new ConnectorError('KPI_SOURCE_DUPLICATE_OR_SCOPE');
   keys.add(key);
  }
  const base = { source, source_namespace: namespace, report_profile_key: KPI_PROFILE, sync_run_id: run, timezone: 'Europe/Paris', coverage_state: 'partial', unit: 'count', currency: null, currency_exponent: null, tax_basis: 'unknown', definition_version: KPI_PROFILE, source_locator: `${source}:kpi-daily` };
  const rows: Row[] = [];
  for (const day of dates) {
   // Future days are never declared covered by an empty response.
   if (Date.parse(startOfParisDay(day)) >= Date.parse(batch.observedAt)) continue;
   const daily = batch.rows.filter(r => r.day === day).sort((a, b) => a.key.localeCompare(b.key));
   for (const row of daily) rows.push({ ...base, metric_key: 'kpi_daily_row', period_from: startOfParisDay(day), period_to: startOfParisDay(nextDay(day)), dimensions_key: row.key, value: 1, dimensions: row });
   rows.push({ ...base, metric_key: 'kpi_daily_manifest', period_from: startOfParisDay(day), period_to: startOfParisDay(nextDay(day)), dimensions_key: day, value: daily.length, dimensions: { day, count: daily.length, hash: digest(daily), observedAt: batch.observedAt } });
  }
  if (rows.some(row => Buffer.byteLength(JSON.stringify(row.dimensions), 'utf8') > 3800)) throw new ConnectorError('KPI_ROW_TOO_LARGE');
  for (let i = 0; i < rows.length; i += 100) await db.upsert('source_aggregates', rows.slice(i, i + 100), 'source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id');
  const published = await db.rpc<{ status: string }>('cockpit_publish_aggregate_state', { p_run: run, p_metric_keys: KPI_STATE_METRICS, p_read: batch.rows.length });
  return { status: published?.status === 'empty' ? 'empty' : 'complete', runId: run, counts: { read: batch.rows.length }, observedAt: batch.observedAt };
 } catch (error) {
  const code = safeConnectorError(error).replace(/[()]/g, '');
  await db.rpc('finish_sync', { p_run: run, p_status: 'failed', p_read: 0, p_rejected: 0, p_complete: false, p_error: code }).catch(() => undefined);
  throw error;
 }
}
/** Reads only selected periods, validates a whole day against its manifest, and never mixes run versions.
 * État courant (migration 018) : une ligne par objet, publiée atomiquement ; toutes les lignes courantes d'un jour
 * portent la tentative de son manifeste. Un jour dont les lignes ne correspondent pas au manifeste reste non mesuré. */
export async function readKpiSource(db: Database, source: KpiSource, namespace: string | undefined, from: string, to: string): Promise<KpiStoredSource> {
 const result: KpiStoredSource = { days: new Map(), latestAttempt: null };
 if (!namespace) return result;
 const eq = { source, source_namespace: namespace, stream_key: kpiStream(source), query_profile_key: KPI_PROFILE };
 const dates = kpiDays(from,to);
 const attempts = await db.select('sync_runs', { eq, order:'started_at,id',descending:true,limit:1 });result.latestAttempt=attempts[0]??null;
 const current = await pagedRows(db, 'source_aggregates', { eq: { source, source_namespace: namespace, report_profile_key: KPI_PROFILE, is_current: 'true' }, in: { metric_key: ['kpi_daily_row', 'kpi_daily_manifest'] }, gte: { period_from: startOfParisDay(from) }, lt: { period_from: startOfParisDay(to) }, order: 'period_from,metric_key,dimensions_key,id' });
 const manifests = new Map<string, Row>(), data = new Map<string, Row[]>();
 for (const row of current) {
  const dimensions = row.dimensions as Row;
  if (row.metric_key === 'kpi_daily_manifest') manifests.set(String(dimensions.day), row);
  else { const day = String((dimensions as unknown as KpiSourceRow).day); data.set(day, [...(data.get(day) ?? []), row]); }
 }
 for (const day of dates) {
  const manifest = manifests.get(day);if (!manifest) continue;
  const info = manifest.dimensions as Row;
  const rows = (data.get(day) ?? []).filter(r => String(r.sync_run_id) === String(manifest.sync_run_id)).map(r => r.dimensions as unknown as KpiSourceRow).sort((a, b) => a.key.localeCompare(b.key));
  if (rows.length !== info.count || digest(rows) !== info.hash) continue;
  result.days.set(day, { rows, observedAt: String(info.observedAt), runId: String(manifest.sync_run_id) });
 }
 return result;
}
