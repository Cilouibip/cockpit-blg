import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncMeta, type MetaConfig } from '../src/connectors/meta';
import { BLG_NOTION_FIELDS, syncNotion, type NotionConfig } from '../src/connectors/notion';
import { syncWixAggregates, wixConnectionState, type WixAggregateConfig } from '../src/connectors/wix';
import { probePostHog } from '../src/connectors/posthog';
import { readJson } from '../src/connectors/http';

const response = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
function queued(values: Response[], inspect?: (url: URL, init: RequestInit) => void): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => { inspect?.(new URL(String(input)), init ?? {}); const value = values.shift(); assert.ok(value, 'Unexpected request'); return value; }) as typeof fetch;
}
const account = () => response({ account_id: '12345', currency: 'EUR', timezone_name: 'Europe/Paris' });
const ad = (extra = {}) => ({ account_id: '12345', ad_id: '6789', date_start: '2026-01-01', date_stop: '2026-01-01', spend: '10.29', impressions: '150', outbound_clicks: [{ action_type: 'outbound_click', value: '4' }], ...extra });
const meta = (fetcher: typeof fetch): MetaConfig => ({ accessToken: 'synthetic-token', accountId: '12345', from: '2026-01-01', to: '2026-01-03', fetcher, sleep: async () => {} });

test('Meta consumes opaque cursors on fixed host, never token-bearing next URL, and preserves missing metrics', async () => {
  const urls: URL[] = [];
  const fetcher = queued([account(), response({ data: [ad()], paging: { next: 'https://hostile.test/?access_token=DO_NOT_FOLLOW', cursors: { after: 'opaque-cursor' } } }), response({ data: [ad({ ad_id: '9999', spend: undefined, outbound_clicks: undefined })] })], (url, init) => {
    urls.push(url); assert.equal(url.hostname, 'graph.facebook.com'); assert.equal(url.searchParams.has('access_token'), false); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
  });
  const result = await syncMeta(meta(fetcher));
  assert.equal(result.status, 'complete'); assert.equal(result.records.length, 2); assert.equal(result.records[0].spendMinor, 1029);
  assert.equal(result.records[1].spendMinor, null); assert.equal(result.records[1].outboundClicks, null);
  assert.equal(urls[2].searchParams.get('after'), 'opaque-cursor'); assert.equal(result.checkpoint.completedThrough, '2026-01-03');
  assert.ok(!JSON.stringify(result).includes('DO_NOT_FOLLOW'));
});

test('Meta empty success is not a zero-spend record; wrong account is rejected', async () => {
  const empty = await syncMeta(meta(queued([account(), response({ data: [] })])));
  assert.equal(empty.status, 'empty'); assert.equal(empty.records.length, 0); assert.match(empty.coverage.reason!, /zéro/);
  const wrong = await syncMeta(meta(queued([response({ account_id: '999', currency: 'EUR', timezone_name: 'Europe/Paris' })])));
  assert.equal(wrong.status, 'failed'); assert.match(wrong.safeError!, /IDENTITY/);
});

test('Meta retry errors are bounded and expurgated, partial import keeps last committed cursor', async () => {
  let sleeps = 0;
  const config = meta(queued([account(), response({ data: [ad()], paging: { next: 'unused', cursors: { after: 'next' } } }), response({ error: 'private-secret' }, 503), response({ error: 'private-secret' }, 503), response({ error: 'private-secret' }, 503)]));
  config.sleep = async () => { sleeps++; };
  const result = await syncMeta(config);
  assert.equal(sleeps, 2); assert.equal(result.status, 'partial'); assert.equal(result.coverage.complete, false); assert.equal(result.checkpoint.cursor, 'next');
  assert.ok(!JSON.stringify(result).includes('private-secret'));
});

test('A failing persistence transaction never advances the connector checkpoint', async () => {
  const config = meta(queued([account(), response({ data: [ad()], paging: { next: 'unused', cursors: { after: 'uncommitted' } } })]));
  config.commitPage = async () => { throw new Error('private-row'); };
  const result = await syncMeta(config);
  assert.deepEqual(result.checkpoint, {}); assert.equal(result.records.length, 0); assert.equal(result.safeError, 'CONNECTOR_FAILED');
});

test('Meta repeated cursor stops pagination and actions remain separate by window', async () => {
  const payload = { data: [ad({ actions: [{ action_type: 'purchase', '1d_click': '1.5', '7d_click': '2' }] })], paging: { next: 'unused', cursors: { after: 'same' } } };
  const config = meta(queued([account(), response(payload), response(payload)])); config.reportingWindows = ['1d_click', '7d_click'];
  const result = await syncMeta(config);
  assert.equal(result.status, 'partial'); assert.match(result.safeError!, /PAGINATION_LOOP/); assert.equal(result.records.length, 1);
  assert.deepEqual(result.records[0].reportedConversions.map(row => row.count), [1.5, 2]);
});

const notionPage = (id: string) => ({ id, last_edited_time: '2026-01-02T10:00:00Z', properties: {
  'Nom complet': { id: 'title', type: 'title', title: [{ plain_text: 'Prospect synthétique' }] }, Etat: { type: 'select', select: { name: 'Closé' } },
  'Animateur RDV': { type: 'select', select: { name: 'Responsable test' } }, Closer: { type: 'relation', relation: [{ id: 'test-closer' }] },
  'Date du RDV': { type: 'date', date: { start: '2026-01-12' } }, 'À relancer le': { type: 'date', date: { start: '2026-01-15' } },
  'Private forbidden field': { rich_text: [{ plain_text: 'NEVER_PERSIST_THIS' }] },
} });
const notionConfig = (fetcher: typeof fetch): NotionConfig => ({ token: 'test-token', dataSourceId: '11111111-1111-4111-8111-111111111111', fields: BLG_NOTION_FIELDS, mappingVersion: 'schema-test', from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z', fetcher, sleep: async () => {}, statusMapping: { Closé: 'attended' } });

test('Notion queries only allowlisted commercial fields, paginates and never promotes closed to attended', async () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const config = notionConfig(queued([response({ results: [notionPage(id)], has_more: true, next_cursor: 'next-page' }), response({ results: [notionPage(id)], has_more: false, next_cursor: null })], (url, init) => {
    assert.equal(url.origin, 'https://api.notion.com'); assert.ok(url.pathname.endsWith('/query')); assert.equal(init.method, 'POST');
    assert.deepEqual(url.searchParams.getAll('filter_properties[]'), Object.values(BLG_NOTION_FIELDS));
  }));
  const result = await syncNotion(config);
  assert.equal(result.status, 'complete'); assert.equal(result.records.length, 1); assert.equal(result.records[0].appointmentStatus, 'unknown');
  assert.equal(result.records[0].appointmentAt, '2026-01-12'); assert.deepEqual(result.records[0].responsible, ['Responsable test']);
  assert.deepEqual(result.records[0].closer, ['test-closer']); assert.ok(!JSON.stringify(result).includes('NEVER_PERSIST_THIS'));
});

test('Notion partial pages and unknown field mappings cannot claim full coverage', async () => {
  const config = notionConfig(queued([response({ results: [notionPage('invalid-id')], has_more: false })]));
  const result = await syncNotion(config);
  assert.equal(result.status, 'partial'); assert.equal(result.counts.rejected, 1); assert.equal(result.coverage.complete, false);
  assert.deepEqual(result.checkpoint, {});
  config.fields = {};
  assert.match((await syncNotion(config)).safeError!, /MAPPING_REQUIRED/);
});

test('PostHog probe verifies one project, never exports Query or claims automatic feed', async () => {
  let requests = 0;
  const result = await probePostHog({ host: 'https://eu.posthog.com', projectId: '987', personalApiKey: 'synthetic', fetcher: queued([response({ id: 987, name: 'PRIVATE_PROJECT_NAME' })], (url, init) => { requests++; assert.equal(url.pathname, '/api/projects/987/'); assert.equal(init.method, 'GET'); }) });
  assert.equal(requests, 1); assert.equal(result.status, 'connected'); assert.equal(result.automaticFeed, false); assert.ok(!JSON.stringify(result).includes('PRIVATE_PROJECT_NAME'));
  const unsafe = await probePostHog({ host: 'https://hostile.test', projectId: '987', personalApiKey: 'synthetic', fetcher: queued([]) });
  assert.equal(unsafe.status, 'failed');
});

const wixMapping = { modelId: '33333333-3333-4333-8333-333333333333', modelSlug: 'synthetic-payments', metric: 'synthetic-received', measure: 'test.received', currencyField: 'test.currency', dependencies: [], reviewedAt: '2026-09-07T12:00:00Z', currencyExponent: 2, taxBasis: 'gross' as const };
const wixConfig = (fetcher: typeof fetch): WixAggregateConfig => ({ apiKey: 'synthetic', siteId: '44444444-4444-4444-8444-444444444444', from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z', timezone: 'Europe/Paris', mapping: wixMapping, fetcher, sleep: async () => {} });
const wixModels = () => response({ semanticModels: [{ id: wixMapping.modelId, slug: wixMapping.modelSlug }] });
const wixSchema = () => response({ semanticModel: { id: wixMapping.modelId, measures: [{ name: 'test.received', dependencies: [] }], dimensions: [{ name: 'test.currency', dependencies: [] }] } });

test('Wix server key is independent and aggregate never becomes a transaction', async () => {
  assert.equal(wixConnectionState({}).status, 'not_configured');
  const result = await syncWixAggregates(wixConfig(queued([wixModels(), wixSchema(), response({ results: [{ fields: { 'test.received': { numericValue: 100.25 }, 'test.currency': { stringValue: 'EUR' } } }], pagingMetadata: { count: 1, offset: 0 } })], (url, init) => {
    assert.equal(url.origin, 'https://www.wixapis.com'); assert.equal((init.headers as Record<string, string>)['wix-site-id'], '44444444-4444-4444-8444-444444444444');
  })));
  assert.equal(result.status, 'complete'); assert.equal(result.records[0].transactionGrain, false); assert.equal(result.records[0].amount?.minor, 10025);
  assert.equal('personId' in result.records[0], false);
});

test('Wix silent field omission marks data partial instead of a fabricated zero', async () => {
  const result = await syncWixAggregates(wixConfig(queued([wixModels(), wixSchema(), response({ results: [{ fields: { 'test.currency': { stringValue: 'EUR' } } }], pagingMetadata: { count: 1 } })])));
  assert.equal(result.status, 'partial'); assert.equal(result.records.length, 0); assert.equal(result.coverage.complete, false);
});

test('HTTP reader bounds body size even when no content-length is supplied', async () => {
  await assert.rejects(readJson(new URL('https://example.test'), {}, { fetcher: queued([new Response('x'.repeat(2_000_001))]) }), /RESPONSE_TOO_LARGE/);
});
