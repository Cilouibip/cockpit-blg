import { previousCalendarDay } from '../domain/dates';
import { moneyFromDecimal } from '../domain/metrics';
import type { Evidence } from '../domain/models';
import { ConnectorError, integer, object, readJson, safeConnectorError, text } from './http';
import { newBatch, type SyncOptions } from './types';

export interface MetaAdDay extends Evidence {
  source: 'meta'; adId: string; adName: string | null; adsetId: string | null; campaignId: string | null; campaignName: string | null;
  date: string; currency: string; timezone: string; spendMinor: number | null; impressions: number | null; outboundClicks: number | null;
  reportedConversions: { action: string; count: number; window: string; reportingTime: 'impression'; method: 'meta_reported' }[];
}
export interface MetaConfig extends SyncOptions<MetaAdDay> {
  accessToken?: string; accountId?: string; apiVersion?: string; currencyExponent?: number;
  /** Explicit Meta reporting windows; without this choice, conversion actions are not requested. */
  reportingWindows?: ('1d_click' | '7d_click' | '1d_view')[];
}

export async function syncMeta(config: MetaConfig) {
  const accountId = (config.accountId ?? '').replace(/^act_/, '');
  const batch = newBatch<MetaAdDay>('meta', accountId, 'meta-read-v1', config.from, config.to);
  if (!config.accessToken || !accountId) return batch;
  const seen = new Map<string, MetaAdDay>();
  const cursors = new Set<string>();
  let cursor = config.cursor;
  if (cursor) batch.checkpoint = { cursor };
  try {
    if (!/^\d{1,30}$/.test(accountId) || !/^\d{4}-\d{2}-\d{2}$/.test(config.from) || !/^\d{4}-\d{2}-\d{2}$/.test(config.to) || config.from >= config.to) throw new ConnectorError('INVALID_CONFIGURATION');
    previousCalendarDay(config.from); const until = previousCalendarDay(config.to);
    const version = config.apiVersion ?? 'v23.0';
    if (!/^v\d+\.0$/.test(version) || Number(version.slice(1).split('.')[0]) < 23) throw new ConnectorError('INVALID_API_VERSION');
    const headers = { Authorization: `Bearer ${config.accessToken}` };
    const accountUrl = new URL(`https://graph.facebook.com/${version}/act_${accountId}`);
    accountUrl.searchParams.set('fields', 'account_id,currency,timezone_name');
    const account = object(await readJson(accountUrl, { method: 'GET', headers }, config));
    if (account.account_id !== accountId || typeof account.currency !== 'string' || !/^[A-Z]{3}$/.test(account.currency) || typeof account.timezone_name !== 'string') throw new ConnectorError('ACCOUNT_IDENTITY_MISMATCH');
    const currency = account.currency, timezone = account.timezone_name;
    const exponent = config.currencyExponent ?? (currency === 'EUR' ? 2 : undefined);
    if (exponent === undefined) throw new ConnectorError('CURRENCY_EXPONENT_REQUIRED');
    const windows = config.reportingWindows ?? [];
    const fields = 'account_id,ad_id,ad_name,adset_id,campaign_id,campaign_name,date_start,date_stop,spend,impressions,outbound_clicks' + (windows.length ? ',actions' : '');
    for (let page = 0; page < Math.min(config.maxPages ?? 20, 100); page++) {
      const url = new URL(`https://graph.facebook.com/${version}/act_${accountId}/insights`);
      url.searchParams.set('fields', fields); url.searchParams.set('level', 'ad'); url.searchParams.set('time_increment', '1');
      url.searchParams.set('time_range', JSON.stringify({ since: config.from, until })); url.searchParams.set('limit', '100');
      if (windows.length) { url.searchParams.set('action_attribution_windows', JSON.stringify(windows)); url.searchParams.set('action_report_time', 'impression'); }
      if (cursor) { if (cursors.has(cursor)) throw new ConnectorError('PAGINATION_LOOP'); cursors.add(cursor); url.searchParams.set('after', cursor); }
      const payload = object(await readJson(url, { method: 'GET', headers }, { ...config, timeoutMs: 60_000 }));
      if (!Array.isArray(payload.data)) throw new ConnectorError('INVALID_RESPONSE');
      const records: MetaAdDay[] = [];
      for (const raw of payload.data) {
        batch.counts.read++;
        try {
          const row = object(raw), adId = text(row.ad_id), date = text(row.date_start);
          if (row.account_id !== accountId || !adId || !/^\d{1,30}$/.test(adId) || !date || date < config.from || date >= config.to || row.date_stop !== date) throw new ConnectorError('INVALID_ROW');
          const outbound = Array.isArray(row.outbound_clicks) ? row.outbound_clicks.map(object).find(action => action.action_type === 'outbound_click') : undefined;
          const reportedConversions: MetaAdDay['reportedConversions'] = [];
          if (windows.length && Array.isArray(row.actions)) for (const rawAction of row.actions) {
            const action = object(rawAction);
            if (typeof action.action_type !== 'string') continue;
            for (const window of windows) {
              const count = typeof action[window] === 'string' && /^\d+(\.\d+)?$/.test(action[window] as string) ? Number(action[window]) : null;
              if (count !== null && Number.isFinite(count)) reportedConversions.push({ action: action.action_type, count, window, reportingTime: 'impression', method: 'meta_reported' });
            }
          }
          const record: MetaAdDay = { source: 'meta', accountId, externalId: `${adId}:${date}`, connectorVersion: batch.version, observedAt: config.now?.() ?? new Date().toISOString(),
            adId, adName: text(row.ad_name), adsetId: text(row.adset_id), campaignId: text(row.campaign_id), campaignName: text(row.campaign_name), date, currency, timezone,
            spendMinor: row.spend === undefined || row.spend === null ? null : moneyFromDecimal(String(row.spend), currency, exponent).minor,
            impressions: integer(row.impressions), outboundClicks: outbound ? integer(outbound.value) : null, reportedConversions };
          records.push(record);
        } catch { batch.counts.rejected++; }
      }
      const paging = payload.paging ? object(payload.paging) : {};
      const hasMore = typeof paging.next === 'string' && paging.next.length > 0;
      // The next URL can contain a token. Only the cursor is retained; the URL is never followed/logged.
      const next = hasMore && paging.cursors ? text(object(paging.cursors).after) : null;
      if (hasMore && (!next || next.length > 4096)) throw new ConnectorError('INVALID_PAGINATION');
      const checkpoint = next ? { cursor: next } : batch.counts.rejected === 0 ? { completedThrough: config.to } : {};
      await config.commitPage?.({ records, checkpoint, terminal: !hasMore });
      records.forEach(record => seen.set(record.externalId, record));
      batch.checkpoint = checkpoint; batch.counts.pages++; batch.counts.accepted = seen.size;
      if (!hasMore) {
        batch.records = [...seen.values()]; batch.status = batch.counts.rejected ? 'partial' : seen.size ? 'complete' : 'empty';
        batch.coverage = { from: config.from, to: config.to, complete: batch.counts.rejected === 0, reason: batch.counts.rejected ? 'Lignes rejetées' : seen.size ? undefined : 'Aucune mesure renvoyée ; ne signifie pas zéro', observedAt: config.now?.() ?? new Date().toISOString() };
        return batch;
      }
      cursor = next!;
    }
    throw new ConnectorError('PAGE_LIMIT_REACHED');
  } catch (error) {
    batch.records = [...seen.values()]; batch.status = seen.size ? 'partial' : 'failed'; batch.safeError = safeConnectorError(error);
    batch.coverage.reason = 'Import interrompu ; couverture non acquise'; return batch;
  }
}
