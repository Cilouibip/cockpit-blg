import { Temporal } from '@js-temporal/polyfill';
import { createHash } from 'node:crypto';
import { ConnectorError, object, readJson } from './http';
import { entryIdentity } from './wix-lead-entries';
import { startOfParisDay } from '../domain/dates';
import type { KpiSourceBatch } from '../lib/kpi-source-store';
/** Nine message IDs reconciled against the existing masterclass sequence on 22 September 2026. No recipient value is persisted. */
export const MASTERCLASS_EMAIL_MESSAGES = ['6be70691-40c3-4978-8499-877d3a757e09','8da58fe8-82fe-4164-872f-cf7c0a2a33b8','6f9880c6-ec39-41e7-9662-67a2c2f65463','a9f7872d-e905-450d-81c4-8c86149b1870','3f6281db-1792-4f71-ba93-0a08cfd96a24','60d81e4c-14cb-4107-acd9-7dd16254d329','f3e97d49-b397-4c87-9693-1a5537b3c980','05d3d1a8-c51e-4410-acd1-be228810c93e','f8747a71-b9f2-4567-93ed-a9e38adea5cd'];
const modelId = 'e660016a-e2be-4eee-9cd2-8cad8a4fd8f3';
const fields = { day: 'em_automation.automation_action_timeframe', message: 'em_automation.message_id', recipient: 'em_automation.recipient_email', sent: 'em_automation.automations_count', delivered: 'em_automation.automation_emails_delivered_count', opens: 'em_automation.automation_emails_opens_count', clicks: 'em_automation.automation_emails_clicks_count' };
export async function readKpiWixEmail(from: string, to: string, env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): Promise<KpiSourceBatch> {
 if (!env.WIX_API_KEY || !env.WIX_SITE_ID || (env.IDENTITY_HMAC_SECRET?.length ?? 0) < 32) throw new ConnectorError('KPI_EMAIL_CONFIGURATION');
 const headers = { Authorization: env.WIX_API_KEY, 'wix-site-id': env.WIX_SITE_ID, 'Content-Type': 'application/json' };
 const base = 'https://www.wixapis.com/analytics/semantic-model/v3/semantic-models';
 const model = object(object(await readJson(new URL(`${base}/${modelId}`), { headers }, { fetcher, attempts: 1 })).semanticModel);
 if (model.id !== modelId || model.slug !== 'email-marketing-automations-actions') throw new ConnectorError('WIX_MODEL_IDENTITY_MISMATCH');
 const available = [...(Array.isArray(model.dimensions) ? model.dimensions : []), ...(Array.isArray(model.measures) ? model.measures : [])].map(object);
 if (Object.values(fields).some(field => !available.some(f => f.name === field))) throw new ConnectorError('WIX_SCHEMA_CHANGED');
 const observedAt = new Date().toISOString(), end = [startOfParisDay(to), observedAt].sort()[0];
 const limit = 1000, maxQueries = 20;
 const measures = ['sent','delivered','opens','clicks'] as const;
 type Totals = Record<typeof measures[number], number | null>;
 type Partition = { from: string; to: string; messages: string[] };
 let queries = 0;
 const recipient = available.find(field => field.name === fields.recipient)!;
 const message = available.find(field => field.name === fields.message)!;
 const dayField = available.find(field => field.name === fields.day)!;
 const messageFilters = object(message.filters);
 if (dayField.type !== 'DATE_TIME' || dayField.sortable !== true || recipient.type !== 'STRING' || recipient.sortable !== true || message.type !== 'STRING' || !Array.isArray(messageFilters.conditions) || !messageFilters.conditions.includes('EQUAL') || !Array.isArray(messageFilters.prefixes) || !messageFilters.prefixes.includes('IS')) throw new ConnectorError('WIX_EMAIL_PAGINATION_UNSUPPORTED');
 function parse(payload: Record<string, unknown>, partition: Partition): KpiSourceBatch['rows'] {
  const rows: KpiSourceBatch['rows'] = [];
  for (const raw of payload.results as unknown[]) {
   const cells = object(object(raw).fields), at = object(cells[fields.day]).timestampValue, message = object(cells[fields.message]).stringValue;
   if (typeof at !== 'string' || typeof message !== 'string' || !partition.messages.includes(message)) throw new ConnectorError('KPI_EMAIL_SCOPE');
   const day = Temporal.Instant.from(at).toZonedDateTimeISO('Europe/Paris').toPlainDate().toString();
   if (day < partition.from || day >= partition.to) throw new ConnectorError('KPI_EMAIL_SCOPE');
   const identity = entryIdentity(object(cells[fields.recipient]).stringValue, env.IDENTITY_HMAC_SECRET!).key;
   const data: Record<string, unknown> = { identity, message };
   for (const key of measures) { const n = object(cells[fields[key]]).numericValue; if (n != null && (!Number.isSafeInteger(n) || Number(n) < 0)) throw new ConnectorError('INVALID_WIX_COUNT'); data[key] = n ?? null; }
   const key = createHash('sha256').update(JSON.stringify([day, message, identity])).digest('hex');
   rows.push({ day, key, data });
  }
  return rows;
 }
 function totals(payload: Record<string, unknown>): Totals {
  if (!payload.totals) throw new ConnectorError('KPI_EMAIL_TOTALS_MISSING');
  const cells = object(object(payload.totals).fields), result = {} as Totals;
  for (const key of measures) {
   if (!cells[fields[key]]) throw new ConnectorError('KPI_EMAIL_TOTALS_MISSING');
   const value = object(cells[fields[key]]).numericValue;
   if (value != null && (!Number.isSafeInteger(value) || Number(value) < 0)) throw new ConnectorError('INVALID_WIX_COUNT');
   result[key] = value == null ? null : Number(value);
  }
  return result;
 }
 function verify(rows: KpiSourceBatch['rows']): void {
  const keys = new Set<string>();
  for (const row of rows) { if (keys.has(row.key)) throw new ConnectorError('KPI_EMAIL_DUPLICATE'); keys.add(row.key); }
 }
 async function query(partition: Partition, offset = 0, sort = fields.day) {
  if (++queries > maxQueries) throw new ConnectorError('PAGE_LIMIT_REACHED');
  const payload = object(await readJson(new URL(`${base}/query-data`), { method: 'POST', headers, body: JSON.stringify({ semanticModelId: modelId, interval: { start: startOfParisDay(partition.from), end: [startOfParisDay(partition.to), end].sort()[0], timezone: 'Europe/Paris' }, fields: Object.values(fields), filters: [{ field: fields.message, prefix: 'IS', condition: 'EQUAL', values: partition.messages }], sort: { fieldName: sort, order: 'ASC' }, paging: { limit, offset }, formattingEnabled: false, totalsIncluded: true }) }, { fetcher, attempts: 1 }));
  if (!Array.isArray(payload.results)) throw new ConnectorError('INVALID_RESPONSE');
  const metadata = object(payload.pagingMetadata);
  if (metadata.offset !== offset || metadata.count !== payload.results.length || payload.results.length > limit) throw new ConnectorError('INVALID_PAGINATION');
  return payload;
 }
 async function read(partition: Partition): Promise<KpiSourceBatch['rows']> {
  if (startOfParisDay(partition.from) >= end) return [];
  const days = Temporal.PlainDate.from(partition.from).until(Temporal.PlainDate.from(partition.to)).days;
  const uniqueKey = days === 1 && partition.messages.length === 1;
  // Wix supports one sort field. Only a day/message leaf has a unique recipient
  // dimension; all wider saturated queries are discarded and split disjointly.
  const first = await query(partition, 0, uniqueKey ? fields.recipient : fields.day);
  if (!(first.results as unknown[]).length) return [];
  let rows: KpiSourceBatch['rows'];
  if ((first.results as unknown[]).length < limit) rows = parse(first, partition);
  else if (days > 1) {
   const middle = Temporal.PlainDate.from(partition.from).add({ days: Math.floor(days / 2) }).toString();
   rows = [...await read({ ...partition, to: middle }), ...await read({ ...partition, from: middle })];
  } else if (partition.messages.length > 1) {
   const middle = Math.floor(partition.messages.length / 2);
   rows = [...await read({ ...partition, messages: partition.messages.slice(0, middle) }), ...await read({ ...partition, messages: partition.messages.slice(middle) })];
  } else {
   const expected = totals(first);
   rows = parse(first, partition); let offset = rows.length;
   for (;;) {
    const page = await query(partition, offset, fields.recipient);
    if (JSON.stringify(totals(page)) !== JSON.stringify(expected)) throw new ConnectorError('KPI_EMAIL_SOURCE_CHANGED');
    rows.push(...parse(page, partition)); offset += (page.results as unknown[]).length;
    if ((page.results as unknown[]).length < limit) break;
   }
  }
  // Completeness comes from every disjoint leaf being below the API limit (or
  // unique-recipient ordered pagination), never from sums of another grain's
  // totals. Real Wix opens totals differ from the complete row sum (70 vs 76).
  verify(rows);
  return rows;
 }
 // Start with small disjoint windows: known source reads spent most of their
 // budget on saturated broad parents whose rows had to be discarded anyway.
 const rows: KpiSourceBatch['rows'] = [];
 const partitions: Partition[] = [];
 for (let start = from; start < to;) {
  const next = Temporal.PlainDate.from(start).add({ days: 7 }).toString();
  const stop = next < to ? next : to;
  partitions.push({ from: start, to: stop, messages: MASTERCLASS_EMAIL_MESSAGES });
  start = stop;
 }
 // Two independent windows at most. Internal splits stay sequential; joining
 // both outcomes on failure prevents an orphan source task or partial batch.
 for (let index = 0; index < partitions.length; index += 2) {
  const results = await Promise.allSettled(partitions.slice(index, index + 2).map(read));
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  for (const result of results) if (result.status === 'fulfilled') rows.push(...result.value);
 }
 verify(rows);
 return { from, to, observedAt, rows };
}
