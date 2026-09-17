import { ConnectorError, object, readJson, safeConnectorError, text } from './http';

export const META_CATALOG_PROFILE = 'meta-ad-catalog-v1';
export const META_CATALOG_STREAM = 'ad_catalog';

export type MetaCatalogAd = {
  source: 'meta';
  sourceNamespace: string;
  externalId: string;
  campaignId?: string;
  campaignName?: string;
  adsetId?: string;
  creativeId?: string;
  adName?: string;
  connectorVersion: typeof META_CATALOG_PROFILE;
  observedAt: string;
};

export type MetaCatalogConfig = {
  accessToken?: string;
  accountId?: string;
  apiVersion?: string;
  maxPages?: number;
  fetcher?: typeof fetch;
  now?: () => string;
};

export type MetaCatalogReport = {
  status: 'complete' | 'empty' | 'failed';
  ads: MetaCatalogAd[];
  counts: { read: number; accepted: number; rejected: number; pages: number };
  safeError?: string;
};

const numericId = (value: unknown) => {
  const candidate = text(value);
  return candidate && /^\d{1,30}$/.test(candidate) ? candidate : undefined;
};

export async function readMetaAdCatalog(config: MetaCatalogConfig): Promise<MetaCatalogReport> {
  const accountId = (config.accountId ?? '').replace(/^act_/, '');
  const counts = { read: 0, accepted: 0, rejected: 0, pages: 0 };
  if (!config.accessToken || !accountId) return { status: 'failed', ads: [], counts, safeError: 'NOT_CONFIGURED' };
  const ads = new Map<string, MetaCatalogAd>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  try {
    if (!/^\d{1,30}$/.test(accountId)) throw new ConnectorError('INVALID_CONFIGURATION');
    const version = config.apiVersion ?? 'v23.0';
    if (!/^v\d+\.0$/.test(version) || Number(version.slice(1, -2)) < 23) throw new ConnectorError('INVALID_API_VERSION');
    const headers = { Authorization: `Bearer ${config.accessToken}` };
    const accountUrl = new URL(`https://graph.facebook.com/${version}/act_${accountId}`);
    accountUrl.searchParams.set('fields', 'account_id');
    const account = object(await readJson(accountUrl, { method: 'GET', headers }, config));
    if (account.account_id !== accountId) throw new ConnectorError('ACCOUNT_IDENTITY_MISMATCH');
    const observedAt = config.now?.() ?? new Date().toISOString();
    const maxPages = Math.min(config.maxPages ?? 20, 100);
    for (let page = 0; page < maxPages; page++) {
      const url = new URL(`https://graph.facebook.com/${version}/act_${accountId}/ads`);
      url.searchParams.set('fields', 'id,account_id,name,adset_id,campaign{id,name},creative{id}');
      url.searchParams.set('limit', '100');
      if (cursor) {
        if (cursors.has(cursor)) throw new ConnectorError('PAGINATION_LOOP');
        cursors.add(cursor);
        url.searchParams.set('after', cursor);
      }
      const payload = object(await readJson(url, { method: 'GET', headers }, { ...config, timeoutMs: 60_000 }));
      if (!Array.isArray(payload.data)) throw new ConnectorError('INVALID_RESPONSE');
      for (const raw of payload.data) {
        counts.read++;
        try {
          const row = object(raw);
          const id = numericId(row.id);
          if (!id || row.account_id !== accountId) throw new ConnectorError('INVALID_ROW');
          const campaign = row.campaign === undefined || row.campaign === null ? undefined : object(row.campaign);
          const creative = row.creative === undefined || row.creative === null ? undefined : object(row.creative);
          const record: MetaCatalogAd = { source: 'meta', sourceNamespace: accountId, externalId: id, connectorVersion: META_CATALOG_PROFILE, observedAt };
          const adName = text(row.name), adsetId = numericId(row.adset_id), campaignId = campaign && numericId(campaign.id), campaignName = campaign && text(campaign.name), creativeId = creative && numericId(creative.id);
          if (adName) record.adName = adName;
          if (adsetId) record.adsetId = adsetId;
          if (campaignId) record.campaignId = campaignId;
          if (campaignName) record.campaignName = campaignName;
          if (creativeId) record.creativeId = creativeId;
          ads.set(id, record);
          counts.accepted = ads.size;
        } catch { counts.rejected++; }
      }
      // A catalog is useful only as a complete, validated snapshot.  Returning
      // accepted rows alongside rejected ones could otherwise make a caller
      // mistake a partial catalog for a publishable result.
      if (counts.rejected > 0) throw new ConnectorError('INVALID_ROW');
      counts.pages++;
      const paging = payload.paging ? object(payload.paging) : {};
      const hasMore = typeof paging.next === 'string' && paging.next.length > 0;
      const next = hasMore && paging.cursors ? text(object(paging.cursors).after) : undefined;
      if (!hasMore) return { status: ads.size ? 'complete' : 'empty', ads: [...ads.values()], counts };
      if (!next || next.length > 4096) throw new ConnectorError('INVALID_PAGINATION');
      cursor = next;
    }
    throw new ConnectorError('PAGE_LIMIT_REACHED');
  } catch (error) {
    return { status: 'failed', ads: [], counts, safeError: safeConnectorError(error) };
  }
}
