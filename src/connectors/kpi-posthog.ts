import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { ConnectorError, object } from './http';
import { kpiBookingQuery } from './journey-analytics';
import { readPostHogQuery } from './posthog-query';
import type { KpiSourceBatch } from '../lib/kpi-source-store';
export async function readKpiPostHog(from: string, to: string, env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): Promise<KpiSourceBatch> {
 const endpoint = new URL(env.POSTHOG_HOST || 'https://invalid.invalid');
 if (!['https://eu.posthog.com','https://us.posthog.com','https://app.posthog.com'].includes(endpoint.origin) || !/^\d+$/.test(env.POSTHOG_PROJECT_ID || '') || !env.POSTHOG_PERSONAL_API_KEY) throw new ConnectorError('KPI_POSTHOG_CONFIGURATION');
 const observedAt = new Date().toISOString(), controller = new AbortController();
 const payload = object(await readPostHogQuery({ endpoint, projectId: env.POSTHOG_PROJECT_ID!, headers: { Authorization: `Bearer ${env.POSTHOG_PERSONAL_API_KEY}`, 'Content-Type': 'application/json' }, query: kpiBookingQuery(from, Temporal.PlainDate.from(to).subtract({ days: 1 }).toString()), name: 'BLG KPI booking sessions', deadline: Date.now() + 25000, signal: controller.signal, fetcher }));
 const expected = ['day','kind','ad','campaign','source','medium','link','is_test','sessions'];
 if (!Array.isArray(payload.results) || !Array.isArray(payload.columns) || payload.columns.join('|') !== expected.join('|') || payload.results.length >= 10001 || payload.hasMore === true || payload.has_more === true) throw new ConnectorError('KPI_POSTHOG_INCOMPLETE');
 const rows = payload.results.map(raw => {
  if (!Array.isArray(raw) || raw.length !== expected.length) throw new ConnectorError('INVALID_POSTHOG_ROW');
  const [day, kind, ad, campaign, source, medium, link, isTest, sessions] = raw;
  if (typeof day !== 'string' || day < from || day >= to || !['click','confirmed'].includes(kind) || [ad,campaign,source,medium,link].some(v=>typeof v !== 'string' || v.length > 200) || ![0,1].includes(isTest) || !Number.isSafeInteger(sessions) || sessions < 0) throw new ConnectorError('INVALID_POSTHOG_ROW');
  const data = { kind, ad, campaign, source, medium, link, isTest: isTest === 1, sessions };
  return { day, key: createHash('sha256').update(JSON.stringify([day,kind,ad,campaign,source,medium,link,isTest])).digest('hex'), data };
 });
 return { from, to, observedAt, rows };
}
