import { ConnectorError, integer, object, readJson } from './http';
import { moneyFromDecimal } from '../domain/metrics';
import { previousCalendarDay } from '../domain/dates';
import type { KpiSourceBatch } from '../lib/kpi-source-store';
/** Same documented source measures as the reviewed table; campaign-day unique clicks are never deduplicated across days. */
export async function readKpiMeta(from: string, to: string, env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): Promise<KpiSourceBatch> {
 const accountId = env.META_AD_ACCOUNT_ID?.replace(/^act_/, ''), version = env.META_API_VERSION || 'v23.0';
 if (!accountId || !/^\d+$/.test(accountId) || !env.META_ACCESS_TOKEN || !/^v\d+\.0$/.test(version)) throw new ConnectorError('KPI_META_CONFIGURATION');
 const headers = { Authorization: `Bearer ${env.META_ACCESS_TOKEN}` };
 const accountUrl = new URL(`https://graph.facebook.com/${version}/act_${accountId}`);accountUrl.searchParams.set('fields', 'account_id,currency,timezone_name');
 const account = object(await readJson(accountUrl, { headers }, { fetcher, attempts: 1 }));
 if (account.account_id !== accountId || account.currency !== 'EUR' || account.timezone_name !== 'Europe/Paris') throw new ConnectorError('ACCOUNT_IDENTITY_MISMATCH');
 const rows: KpiSourceBatch['rows'] = [], cursors = new Set<string>(); let cursor: string | null = null;
 const observedAt = new Date().toISOString();
 for (let page = 0; page < 20; page++) {
  const url = new URL(`https://graph.facebook.com/${version}/act_${accountId}/insights`);
  url.searchParams.set('fields', 'account_id,campaign_id,campaign_name,date_start,date_stop,spend,impressions,inline_link_clicks,unique_inline_link_clicks,actions');
  url.searchParams.set('level', 'campaign');url.searchParams.set('time_increment', '1');url.searchParams.set('limit', '500');
  url.searchParams.set('time_range', JSON.stringify({ since: from, until: previousCalendarDay(to) }));
  url.searchParams.set('action_attribution_windows', JSON.stringify(['7d_click', '1d_view']));url.searchParams.set('action_report_time', 'impression');
  if (cursor) url.searchParams.set('after', cursor);
  const payload = object(await readJson(url, { headers }, { fetcher, attempts: 1 }));
  if (!Array.isArray(payload.data)) throw new ConnectorError('INVALID_RESPONSE');
  for (const raw of payload.data) {
   const row = object(raw), day = row.date_start, id = row.campaign_id;
   if (row.account_id !== accountId || typeof day !== 'string' || day < from || day >= to || row.date_stop !== day || typeof id !== 'string' || !/^\d+$/.test(id)) throw new ConnectorError('KPI_META_SCOPE');
   const actions = Array.isArray(row.actions) ? row.actions.map(object) : null;
   // The exact custom conversion must be configured, never replaced by the generic Schedule action.
   const action = (name: string | undefined): number | null => { if (!name || !actions) return null; const found = actions.filter(a => a.action_type === name); if (found.length > 1) throw new ConnectorError('KPI_META_DUPLICATE_ACTION'); return found.length ? integer(found[0].value) : 0; };
   rows.push({ day, key: id, data: { campaignId: id, spend_eur: row.spend == null ? null : moneyFromDecimal(String(row.spend), 'EUR', 2).minor / 100, impressions: integer(row.impressions), link_clicks: integer(row.inline_link_clicks), unique_link_clicks_campaign_sum: integer(row.unique_inline_link_clicks), landing_page_views: action('landing_page_view'), booking_meta_attributed: action(env.BLG_KPI_META_BOOKING_ACTION || 'offsite_conversion.custom.2154825181913636') } });
  }
  const paging = payload.paging ? object(payload.paging) : {};
  if (!paging.next) return { from, to, observedAt, rows };
  const next = paging.cursors ? object(paging.cursors).after : null;
  if (typeof next !== 'string' || !next || cursors.has(next)) throw new ConnectorError('INVALID_PAGINATION');cursors.add(next);cursor = next;
 }
 throw new ConnectorError('PAGE_LIMIT_REACHED');
}
