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
 const rows: KpiSourceBatch['rows'] = []; let offset = 0; const seen = new Set<string>();
 for (let page = 0; page < 20; page++) {
  const payload = object(await readJson(new URL(`${base}/query-data`), { method: 'POST', headers, body: JSON.stringify({ semanticModelId: modelId, interval: { start: startOfParisDay(from), end, timezone: 'Europe/Paris' }, fields: Object.values(fields), filters: [{ field: fields.message, prefix: 'IS', condition: 'EQUAL', values: MASTERCLASS_EMAIL_MESSAGES }], sort: { fieldName: fields.day, order: 'ASC' }, paging: { limit: 1000, offset }, formattingEnabled: false }) }, { fetcher, attempts: 1 }));
  if (!Array.isArray(payload.results)) throw new ConnectorError('INVALID_RESPONSE');
  const metadata = object(payload.pagingMetadata);
  if (metadata.offset !== offset || metadata.count !== payload.results.length || payload.results.length > 1000) throw new ConnectorError('INVALID_PAGINATION');
  for (const raw of payload.results) {
   const cells = object(object(raw).fields), at = object(cells[fields.day]).timestampValue, message = object(cells[fields.message]).stringValue;
   if (typeof at !== 'string' || typeof message !== 'string' || !MASTERCLASS_EMAIL_MESSAGES.includes(message)) throw new ConnectorError('KPI_EMAIL_SCOPE');
   const day = Temporal.Instant.from(at).toZonedDateTimeISO('Europe/Paris').toPlainDate().toString();
   if (day < from || day >= to) throw new ConnectorError('KPI_EMAIL_SCOPE');
   const identity = entryIdentity(object(cells[fields.recipient]).stringValue, env.IDENTITY_HMAC_SECRET!).key;
   const data: Record<string, unknown> = { identity, message };
   for (const key of ['sent','delivered','opens','clicks'] as const) { const n = object(cells[fields[key]]).numericValue; if (n != null && (!Number.isSafeInteger(n) || Number(n) < 0)) throw new ConnectorError('INVALID_WIX_COUNT'); data[key] = n ?? null; }
   const key = createHash('sha256').update(JSON.stringify([day, message, identity])).digest('hex');
   if (seen.has(key)) throw new ConnectorError('KPI_EMAIL_DUPLICATE');seen.add(key);rows.push({ day, key, data });
  }
  offset += payload.results.length;
  if (payload.results.length < 1000) return { from, to, observedAt, rows };
 }
 throw new ConnectorError('PAGE_LIMIT_REACHED');
}
