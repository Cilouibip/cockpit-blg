import { readMetaAdCatalog, META_CATALOG_PROFILE, META_CATALOG_STREAM, type MetaCatalogConfig } from '../connectors/meta-catalog';
import { database, type Database, type Row } from './db';
import { invalidateSourceSnapshots } from './source-snapshots';

const CATALOG_COLUMNS = ['campaign_id', 'campaign_name', 'adset_id', 'creative_id', 'ad_name'] as const;
const existingValue = (row: Row | undefined, key: typeof CATALOG_COLUMNS[number]) => typeof row?.[key] === 'string' ? row[key] as string : null;

async function existingAds(db: Database, namespace: string, ids: string[]) {
  const found = new Map<string, Row>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100);
    const rows = await db.select('ads', {
      eq: { source: 'meta', source_namespace: namespace },
      in: { external_id: chunk },
      columns: ['external_id', ...CATALOG_COLUMNS],
      limit: 100,
    });
    for (const row of rows) if (typeof row.external_id === 'string') found.set(row.external_id, row);
  }
  return found;
}

export async function syncMetaCatalog(options: { db?: Database; env?: NodeJS.ProcessEnv; reader?: typeof readMetaAdCatalog; fetcher?: typeof fetch } = {}) {
  const env = options.env ?? process.env;
  const db = options.db ?? database();
  const namespace = (env.META_AD_ACCOUNT_ID ?? '').replace(/^act_/, '');
  const empty = { read: 0, accepted: 0, rejected: 0, pages: 0 };
  if (env.COCKPIT_MODE === 'demo' || !namespace || !env.META_ACCESS_TOKEN) return { status: 'not_configured', runId: null, counts: empty };
  const now = new Date().toISOString();
  const runId = await db.rpc<string>('begin_sync_stream', { p_source: 'meta', p_namespace: namespace, p_from: '1970-01-01T00:00:00Z', p_to: now, p_profile: META_CATALOG_PROFILE, p_coverage_kind: 'source_snapshot', p_stream: META_CATALOG_STREAM });
  try {
    const config: MetaCatalogConfig = { accessToken: env.META_ACCESS_TOKEN, accountId: namespace, apiVersion: env.META_API_VERSION ?? 'v23.0', maxPages: 20, fetcher: options.fetcher };
    const report = await (options.reader ?? readMetaAdCatalog)(config);
    if (report.status === 'failed' || report.counts.rejected > 0) {
      await db.rpc('finish_sync', { p_run: runId, p_status: 'failed', p_read: report.counts.read, p_rejected: report.counts.rejected, p_complete: false, p_error: report.safeError ?? 'META_CATALOG_INVALID' });
      return { status: 'failed', runId, counts: report.counts };
    }
    const prior = await existingAds(db, namespace, report.ads.map(ad => ad.externalId));
    // Supabase REST accepts a bulk upsert only when every object has identical
    // keys.  Each optional source field therefore falls back to the stored
    // value; a newly discovered ad has null until Meta supplies that metadata.
    const rows: Row[] = report.ads.map(ad => ({
      source: ad.source,
      source_namespace: ad.sourceNamespace,
      external_id: ad.externalId,
      campaign_id: ad.campaignId ?? existingValue(prior.get(ad.externalId), 'campaign_id'),
      campaign_name: ad.campaignName ?? existingValue(prior.get(ad.externalId), 'campaign_name'),
      adset_id: ad.adsetId ?? existingValue(prior.get(ad.externalId), 'adset_id'),
      creative_id: ad.creativeId ?? existingValue(prior.get(ad.externalId), 'creative_id'),
      ad_name: ad.adName ?? existingValue(prior.get(ad.externalId), 'ad_name'),
      connector_version: ad.connectorVersion,
      last_seen_at: ad.observedAt,
    }));
    if (rows.length) await db.upsert('ads', rows, 'source,source_namespace,external_id');
    await db.rpc('finish_sync', { p_run: runId, p_status: report.status, p_read: report.counts.read, p_rejected: 0, p_complete: true, p_error: null });
    invalidateSourceSnapshots(db);
    return { status: report.status, runId, counts: report.counts };
  } catch {
    await db.rpc('finish_sync', { p_run: runId, p_status: 'failed', p_read: 0, p_rejected: 0, p_complete: false, p_error: 'META_CATALOG_IMPORT_FAILED' }).catch(() => undefined);
    return { status: 'failed', runId, counts: empty };
  }
}
