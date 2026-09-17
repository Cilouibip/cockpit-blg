import test from 'node:test';
import assert from 'node:assert/strict';
import { readMetaAdCatalog, META_CATALOG_PROFILE, META_CATALOG_STREAM } from '../src/connectors/meta-catalog';
import { syncMetaCatalog } from '../src/lib/sync-catalog';
import type { Database, Row } from '../src/lib/db';

const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const queued = (items: Response[], inspect: (url: URL) => void): typeof fetch => async input => { const url = new URL(String(input)); inspect(url); const next = items.shift(); if (!next) throw Error('unexpected request'); return next; };
const ad = (id = '100', extras: Record<string, unknown> = {}) => ({ id, account_id: '123', name: `Ad ${id}`, adset_id: '200', campaign: { id: '300', name: 'Campaign' }, creative: { id: '400' }, ...extras });

test('catalog reads bounded pages and keeps only the documented cursor', async () => {
  const urls: URL[] = [];
  const report = await readMetaAdCatalog({ accessToken: 'synthetic', accountId: '123', now: () => '2026-09-17T00:00:00Z', fetcher: queued([
    response({ account_id: '123' }),
    response({ data: [ad()], paging: { next: 'https://hostile.invalid/?access_token=never', cursors: { after: 'cursor-1' } } }),
    response({ data: [ad('101', { name: undefined, creative: undefined })] }),
  ], url => urls.push(url)) });
  assert.equal(report.status, 'complete'); assert.equal(report.counts.pages, 2); assert.equal(report.ads.length, 2);
  assert.equal(urls[1].pathname, '/v23.0/act_123/ads'); assert.equal(urls[2].searchParams.get('after'), 'cursor-1');
  assert.equal(report.ads[1].adName, undefined); assert.equal(report.ads[1].creativeId, undefined);
});

test('account mismatch or incomplete pagination never returns a partial catalog for persistence', async () => {
  const mismatch = await readMetaAdCatalog({ accessToken: 'synthetic', accountId: '123', fetcher: queued([response({ account_id: '999' })], () => undefined) });
  assert.equal(mismatch.status, 'failed'); assert.equal(mismatch.ads.length, 0);
  const capped = await readMetaAdCatalog({ accessToken: 'synthetic', accountId: '123', maxPages: 1, fetcher: queued([response({ account_id: '123' }), response({ data: [ad()], paging: { next: 'x', cursors: { after: 'cursor-1' } } })], () => undefined) });
  assert.equal(capped.status, 'failed'); assert.equal(capped.ads.length, 0);
});

test('a rejected catalog row makes the reader return a failed, non-persistable snapshot', async () => {
  const report = await readMetaAdCatalog({ accessToken: 'synthetic', accountId: '123', fetcher: queued([
    response({ account_id: '123' }),
    response({ data: [ad('100'), ad('broken', { account_id: 'wrong' })] }),
  ], () => undefined) });
  assert.equal(report.status, 'failed');
  assert.equal(report.counts.rejected, 1);
  assert.equal(report.ads.length, 0);
});

function memory() {
  const calls: { name: string; args: Row }[] = []; const writes: Row[][] = [];
  const db: Database = { probe: async () => undefined, select: async () => [], upsert: async (_table, rows) => { writes.push(rows); }, rpc: async <T>(name: string, args: Row) => { calls.push({ name, args }); return (name === 'begin_sync_stream' ? 'catalog-run' : true) as T; } };
  return { db, calls, writes };
}
const env = { COCKPIT_MODE: 'live', META_AD_ACCOUNT_ID: 'act_123', META_ACCESS_TOKEN: 'synthetic' } as unknown as NodeJS.ProcessEnv;

test('complete catalog uses homogeneous rows and preserves existing metadata omitted by Meta, then marks its own stream complete', async () => {
  const m = memory();
  m.db.select = async (_table, options) => options?.in?.external_id?.includes('100') ? [{ external_id: '100', creative_id: 'existing-creative', campaign_id: 'existing-campaign' }] : [];
  const result = await syncMetaCatalog({ db: m.db, env, reader: async () => ({ status: 'complete', counts: { read: 2, accepted: 2, rejected: 0, pages: 1 }, ads: [
    { source: 'meta', sourceNamespace: '123', externalId: '100', adsetId: '200', connectorVersion: META_CATALOG_PROFILE, observedAt: '2026-09-17T00:00:00Z' },
    { source: 'meta', sourceNamespace: '123', externalId: '101', adName: 'New ad', connectorVersion: META_CATALOG_PROFILE, observedAt: '2026-09-17T00:00:00Z' },
  ] }) });
  assert.equal(result.status, 'complete'); assert.equal(m.writes.length, 1);
  assert.deepEqual(m.writes[0], [
    { source: 'meta', source_namespace: '123', external_id: '100', campaign_id: 'existing-campaign', campaign_name: null, adset_id: '200', creative_id: 'existing-creative', ad_name: null, connector_version: META_CATALOG_PROFILE, last_seen_at: '2026-09-17T00:00:00Z' },
    { source: 'meta', source_namespace: '123', external_id: '101', campaign_id: null, campaign_name: null, adset_id: null, creative_id: null, ad_name: 'New ad', connector_version: META_CATALOG_PROFILE, last_seen_at: '2026-09-17T00:00:00Z' },
  ]);
  assert.deepEqual(Object.keys(m.writes[0][0]), Object.keys(m.writes[0][1]));
  assert.equal(m.calls[0].args.p_stream, META_CATALOG_STREAM); assert.equal(m.calls.at(-1)?.args.p_complete, true);
});

test('a failed catalog retains the previous ads by skipping upsert and recording a failed run', async () => {
  const m = memory();
  const result = await syncMetaCatalog({ db: m.db, env, reader: async () => ({ status: 'failed', counts: { read: 1, accepted: 1, rejected: 0, pages: 1 }, ads: [], safeError: 'PAGE_LIMIT_REACHED' }) });
  assert.equal(result.status, 'failed'); assert.equal(m.writes.length, 0); assert.equal(m.calls.at(-1)?.args.p_status, 'failed'); assert.equal(m.calls.at(-1)?.args.p_complete, false);
});
