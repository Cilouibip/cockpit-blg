import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CHECKPOINT_MARKER_BATCH_SIZE, checkpointParts, refreshNotionCommerce } from '../src/lib/sync-notion-commerce';
import type { Database, Row } from '../src/lib/db';
import { AppError } from '../src/lib/errors';
import { retainConfirmedArchivedClients, reportFromCheckpoint } from '../src/lib/notion-commerce-archive';
import { notionCommerceProfile, type CommerceReadCheckpoint } from '../src/connectors/notion-commerce';

const config = {
  clients: { dataSourceId: 'clients', fields: { email: 'Email', emailBis: 'Email 2', started: 'Début', prospect: 'Prospect', binome: 'Binôme' } },
  payments: { dataSourceId: 'payments', fields: { client: 'Client', email: 'Email', date: 'Date', amount: 'Montant', status: 'Statut', provider: 'Transaction', invoice: 'Facture' } },
  parcours: { dataSourceId: 'parcours', fields: { client: 'Client', order: 'Ordre', format: 'Format', start: 'Début', closing: 'Closing', status: 'Statut' } },
} as const;

function memoryDb(busy = false) {
  const rows: Row[] = [], finishes: Row[] = [];
  const db: Database = {
    select: async (table, options = {}) => {
      if (table === 'sync_runs') return [];
      const selected = rows.filter(row => Object.entries(options.eq ?? {}).every(([key, value]) => String(row[key]) === value));
      return selected.sort((a, b) => String(a.dimensions_key).localeCompare(String(b.dimensions_key))).slice(options.from ?? 0, (options.from ?? 0) + (options.limit ?? 1000));
    },
    upsert: async (_table, incoming) => { rows.push(...incoming); },
    rpc: async <T = unknown>(name: string, args: Row): Promise<T> => {
      if (name === 'begin_sync_stream') { if (busy) throw new AppError('occupée', 409); return 'run-test' as T; }
      if (name === 'finish_sync') { finishes.push(args); return true as T; }
      throw new Error('unexpected rpc');
    },
    probe: async () => undefined,
  };
  return { db, rows, finishes };
}

function schema(fields: Record<string, string>) { return Response.json({ properties: Object.fromEntries(Object.values(fields).map((name, index) => [name, { id: `p${index}` }])) }); }

const ARCHIVED_CLIENT = '11111111-1111-4111-8111-111111111111';

function statefulMemoryDb() {
  const rows: Row[] = [], runs: Row[] = [];
  const markerBatchSizes: number[] = [];
  let sequence = 0, checkpointReads = 0, aggregateReads = 0;
  const matches = (row: Row, eq: Record<string, string> = {}, within: Record<string, string[]> = {}) => Object.entries(eq).every(([key, value]) => String(row[key]) === value) && Object.entries(within).every(([key, values]) => values.includes(String(row[key])));
  const db: Database = {
    select: async (table, options = {}) => {
      if (table === 'source_aggregates') {
        aggregateReads++;
        if (options.eq?.metric_key === 'notion_commerce_checkpoint') checkpointReads++;
        if (options.eq?.metric_key === 'notion_commerce_checkpoint_publication') markerBatchSizes.push(options.in?.sync_run_id?.length ?? 0);
      }
      const source = table === 'sync_runs' ? runs : rows;
      const order = (options.order ?? 'id').split(',');
      return source.filter(row => matches(row, options.eq, options.in)).sort((left, right) => {
        for (const key of order) { const compared = String(left[key]).localeCompare(String(right[key])); if (compared) return options.descending ? -compared : compared; }
        return 0;
      }).slice(options.from ?? 0, (options.from ?? 0) + (options.limit ?? 1000));
    },
    upsert: async (_table, incoming) => { rows.push(...incoming); },
    rpc: async <T = unknown>(name: string, args: Row): Promise<T> => {
      if (name === 'begin_sync_stream') {
        const id = `run-${++sequence}`;
        runs.push({ id, source: args.p_source, source_namespace: args.p_namespace, stream_key: args.p_stream, query_profile_key: args.p_profile, status: 'running', pagination_complete: 'false', rows_rejected: '0', period_to: args.p_to, started_at: `2026-09-22T20:${String(sequence).padStart(2, '0')}:00.000Z`, finished_at: '' });
        return id as T;
      }
      if (name === 'finish_sync') {
        const run = runs.find(candidate => candidate.id === args.p_run); if (!run) throw new Error('unknown run');
        run.status = args.p_status; run.pagination_complete = String(args.p_complete); run.rows_rejected = String(args.p_rejected); run.error = args.p_error; run.finished_at = `2026-09-22T21:${String(sequence).padStart(2, '0')}:00.000Z`;
        return true as T;
      }
      throw new Error('unexpected rpc');
    },
    probe: async () => undefined,
  };
  const addReaderCheckpoint = (checkpoint: CommerceReadCheckpoint, publishedRunId?: string) => {
    const id = `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, serialized = JSON.stringify(checkpoint), parts = checkpointParts(serialized), hash = createHash('sha256').update(serialized).digest('hex');
    runs.push({ id, source: 'notion', source_namespace: config.parcours.dataSourceId, stream_key: 'commerce_reader_checkpoint', query_profile_key: notionCommerceProfile(config), status: 'complete', pagination_complete: 'true', rows_rejected: '0', finished_at: `2026-09-22T22:${String(sequence).padStart(2, '0')}:00.000Z` });
    rows.push(...parts.map((part, index) => ({ sync_run_id: id, metric_key: 'notion_commerce_checkpoint', dimensions_key: `checkpoint:${String(index).padStart(6, '0')}`, dimensions: { index, total: parts.length, hash, part } })));
    if (publishedRunId) rows.push({ sync_run_id: id, metric_key: 'notion_commerce_checkpoint_publication', dimensions_key: 'published', dimensions: { publishedRunId } });
    return id;
  };
  const addPublicationMarker = (checkpointRunId: string, publishedRunId: string, dimensionsKey = 'published') => rows.push({ sync_run_id: checkpointRunId, metric_key: 'notion_commerce_checkpoint_publication', dimensions_key: dimensionsKey, dimensions: { publishedRunId } });
  const readerCheckpoint = (id: string) => {
    const parts = rows.filter(row => row.sync_run_id === id && row.metric_key === 'notion_commerce_checkpoint').map(row => row.dimensions as { index: number; part: string }).sort((left, right) => left.index - right.index);
    return JSON.parse(parts.map(part => part.part).join('')) as CommerceReadCheckpoint;
  };
  return { db, rows, runs, addReaderCheckpoint, addPublicationMarker, readerCheckpoint, checkpointReads: () => checkpointReads, aggregateReads: () => aggregateReads, markerBatchSizes: () => [...markerBatchSizes] };
}

function clientPage(id = ARCHIVED_CLIENT) { return { id, properties: { Nom: { type: 'title', title: [{ plain_text: 'Client conservé' }] }, Email: { email: null }, 'Email 2': { email: null }, Début: { date: { start: '2024-01-01' } }, Prospect: { relation: [] }, Binôme: { relation: [] } } }; }
function parcoursPage() { return { id: 'parcours-archived', properties: { Client: { relation: [{ id: ARCHIVED_CLIENT }] }, Ordre: { number: 1 }, Format: { select: { name: 'Solo' } }, Début: { date: { start: '2024-01-01' } }, Closing: { date: null }, Statut: { select: { name: 'Actif' } } } }; }
function commerceFetcher(options: { mode: 'baseline' | 'missing'; calls: string[] }) {
  let clientQueries = 0;
  return async (input: unknown) => {
    const url = new URL(String(input)); options.calls.push(url.pathname + url.search);
    if (url.pathname === `/v1/pages/${ARCHIVED_CLIENT}`) return Response.json({ object: 'page', id: ARCHIVED_CLIENT, archived: true, in_trash: true, last_edited_time: '2026-09-22T15:52:00.000Z', parent: { type: 'data_source_id', data_source_id: config.clients.dataSourceId }, properties: {} });
    if (!url.pathname.endsWith('/query')) { if (url.pathname.includes('/clients')) return schema(config.clients.fields); if (url.pathname.includes('/payments')) return schema(config.payments.fields); return schema(config.parcours.fields); }
    if (url.pathname.includes('/clients')) { clientQueries++; if (options.mode === 'baseline') return Response.json({ results: [clientPage()], has_more: false, next_cursor: null }); return Response.json({ results: [], has_more: clientQueries < 4, next_cursor: clientQueries < 4 ? `cursor-${clientQueries}` : null }); }
    if (url.pathname.includes('/payments')) return Response.json({ results: [], has_more: false, next_cursor: null });
    return Response.json({ results: [parcoursPage()], has_more: false, next_cursor: null });
  };
}

test('le checkpoint commerce se fragmente sous la limite JSON sans couper une paire UTF-16', () => {
  const serialized = JSON.stringify({ snapshot: '🧑‍💼'.repeat(440_000), cursor: 'fin' });
  const parts = checkpointParts(serialized, 2800);
  assert.ok(Buffer.byteLength(serialized, 'utf8') >= 3_300_000);
  assert.ok(parts.length > 1_000 && parts.length < 10_000);
  assert.equal(parts.join(''), serialized);
  assert.ok(parts.every(part => Buffer.byteLength(JSON.stringify({ part }), 'utf8') <= 2800));
  assert.ok(parts.every(part => !/[\uD800-\uDBFF]$/.test(part) && !/^[\uDC00-\uDFFF]/.test(part)));
});

test('une limite de fragmentation invalide est refusée avant écriture', () => {
  assert.throws(() => checkpointParts('🧑', 63), /INVALID_CHECKPOINT_LIMIT/);
});

test('un HTTP 503 après une page garde un checkpoint vérifié et persiste l’échec réel sans publication', async () => {
  const memory = memoryDb();
  const fetcher = async (input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname.includes('/clients')) return url.pathname.endsWith('/query') ? Response.json({ results: [], has_more: false }) : schema(config.clients.fields);
    return new Response('', { status: 503 });
  };
  const result = await refreshNotionCommerce({ db: memory.db, config, token: 'synthetic', identitySecret: 'x'.repeat(32), fetcher: fetcher as typeof fetch });
  assert.equal(result.status, 'failed');
  assert.equal(result.coverage, 'checkpoint');
  assert.equal(result.counts.pages, 1);
  assert.ok(memory.rows.length > 0);
  assert.deepEqual(memory.finishes, [{ p_run: 'run-test', p_status: 'complete', p_read: 0, p_rejected: 0, p_complete: true, p_error: 'UPSTREAM_HTTP_ERROR HTTP 503' }]);
});

test('un worker déjà verrouillé répond partiel sans staging parasite', async () => {
  const memory = memoryDb(true);
  const result = await refreshNotionCommerce({ db: memory.db, config, token: 'synthetic', identitySecret: 'x'.repeat(32) });
  assert.deepEqual(result, { status: 'partial', counts: { pages: 0, read: 0 }, coverage: 'unavailable', reason: 'actualisation_en_cours' });
  assert.equal(memory.rows.length, 0);
  assert.equal(memory.finishes.length, 0);
});

test('un Client absent reste dans le seul historique cockpit lorsque la corbeille Notion le confirme', async () => {
  const client={id:'11111111-1111-4111-8111-111111111111',name:null,notionUrl:null,emailKey:null,emailBisKey:null,startedDay:'2026-01-01',prospectIds:[],binomeIds:[]};
  const snapshot={clients:[],payments:[],schedules:[],parcours:[],startedAt:'2026-01-01T00:00:00Z',sourceCounts:{clients:0,payments:0,parcours:0}};
  const previous={runId:'published-run',checkpoint:{version:1 as const,profile:'p',identityConfigKey:'i',startedAt:'2026-01-01T00:00:00Z',familyIndex:3,cursor:null,pages:3,completedAt:'2026-01-02T00:00:00Z',snapshot:{...snapshot,clients:[client],sourceCounts:{...snapshot.sourceCounts,clients:1}}}};
  const current={version:1 as const,profile:'p',identityConfigKey:'i',startedAt:'2026-01-03T00:00:00Z',familyIndex:3,cursor:null,pages:3,completedAt:'2026-01-03T00:00:00Z',snapshot};
  const archivedFetcher:typeof fetch=async()=>Response.json({object:'page',id:client.id,archived:true,in_trash:true,last_edited_time:'2026-01-03T00:00:00.000Z',parent:{type:'data_source_id',data_source_id:'clients'}});
  const retained=await retainConfirmedArchivedClients({current,previous,config:config as any,token:'synthetic',fetcher:archivedFetcher});
  assert.equal(retained.snapshot.clients.length,0);
  assert.equal(retained.retainedArchivedClients?.length,1);
  const report=reportFromCheckpoint(retained);assert.equal(report.totals.firstAccompanimentsStarted,1);assert.equal(report.paidSales.confirmedInitialSales,0);assert.equal(report.coverage.retainedArchivedClients,1);
});

test('une disparition non confirmée comme archive garde le garde-fou historique', async () => {
  const client={id:'11111111-1111-4111-8111-111111111111',name:null,notionUrl:null,emailKey:null,emailBisKey:null,startedDay:'2026-01-05',prospectIds:[],binomeIds:[]};
  const checkpoint={version:1 as const,profile:'p',identityConfigKey:'i',startedAt:'2026-01-03T00:00:00Z',familyIndex:3,cursor:null,pages:3,completedAt:'2026-01-03T00:00:00Z',snapshot:{clients:[],payments:[],schedules:[],parcours:[],startedAt:'2026-01-03T00:00:00Z',sourceCounts:{}}};
  const activeFetcher:typeof fetch=async()=>Response.json({object:'page',id:client.id,archived:false,in_trash:false,parent:{data_source_id:'clients'}});
  await assert.rejects(()=>retainConfirmedArchivedClients({current:checkpoint,previous:{runId:'published-run',checkpoint:{...checkpoint,snapshot:{...checkpoint.snapshot,clients:[client]}}},config:config as any,token:'synthetic',fetcher:activeFetcher}),error=>(error as {code?:string}).code==='COMMERCE_HISTORICAL_SOURCE_MEMBER_MISSING');
  for (const response of [
    { object: 'page', id: client.id, archived: true, in_trash: true, last_edited_time: '2026-01-03T00:00:00.000Z', parent: { type: 'data_source_id', data_source_id: 'other-clients' } },
    { object: 'page', id: client.id, archived: true, in_trash: false, last_edited_time: '2026-01-03T00:00:00.000Z', parent: { type: 'data_source_id', data_source_id: 'clients' } },
    null,
  ]) await assert.rejects(() => retainConfirmedArchivedClients({ current: checkpoint, previous: { runId: 'published-run', checkpoint: { ...checkpoint, snapshot: { ...checkpoint.snapshot, clients: [client] } } }, config: config as any, token: 'synthetic', fetcher: (async () => response ? Response.json(response) : new Response('', { status: 404 })) as typeof fetch }));
});

test('une collecte Client sur plusieurs passes retient le dernier miroir publié après validation stricte de la corbeille', async () => {
  const memory = statefulMemoryDb();
  await refreshNotionCommerce({ db: memory.db, config, token: 'synthetic', identitySecret: 'x'.repeat(32), fetcher: commerceFetcher({ mode: 'baseline', calls: [] }) as typeof fetch, maxPages: 3 });
  const calls: string[] = [], fetcher = commerceFetcher({ mode: 'missing', calls }) as typeof fetch;
  assert.equal((await refreshNotionCommerce({ db: memory.db, config, token: 'synthetic', identitySecret: 'x'.repeat(32), fetcher, maxPages: 3 })).status, 'partial');
  assert.equal((await refreshNotionCommerce({ db: memory.db, config, token: 'synthetic', identitySecret: 'x'.repeat(32), fetcher, maxPages: 3 })).status, 'complete');
  assert.equal(calls.filter(call => call === `/v1/pages/${ARCHIVED_CLIENT}`).length, 1);
  const reader = memory.runs.filter(run => run.stream_key === 'commerce_reader_checkpoint').sort((left, right) => String(right.finished_at).localeCompare(String(left.finished_at)))[0];
  const checkpoint = memory.readerCheckpoint(String(reader.id));
  assert.equal(checkpoint.snapshot.clients.length, 0);
  assert.equal(checkpoint.retainedArchivedClients?.[0]?.client.startedDay, '2024-01-01');
  assert.equal(checkpoint.retainedArchivedClients?.[0]?.inTrash, true);
  const overview = memory.rows.filter(row => row.metric_key === 'notion_commerce_overview').at(-1)!.dimensions as { totals: { firstAccompanimentsStarted: number } };
  assert.equal(overview.totals.firstAccompanimentsStarted, 1);
});

test('un checkpoint complet non publié est repris avec la même preuve archivée sans modifier le miroir précédent', async () => {
  const memory = statefulMemoryDb();
  await refreshNotionCommerce({ db: memory.db, config, token: 'synthetic', identitySecret: 'x'.repeat(32), fetcher: commerceFetcher({ mode: 'baseline', calls: [] }) as typeof fetch, maxPages: 3 });
  const now = new Date().toISOString();
  const legacyId = memory.addReaderCheckpoint({ version: 1, profile: notionCommerceProfile(config), identityConfigKey: memory.readerCheckpoint(String(memory.runs.find(run => run.stream_key === 'commerce_reader_checkpoint')!.id)).identityConfigKey, startedAt: now, familyIndex: 3, cursor: null, pages: 6, completedAt: now, snapshot: { clients: [], payments: [], schedules: [], parcours: [{ id: 'parcours-archived', clientIds: [ARCHIVED_CLIENT], order: 1, format: 'Solo', startDay: '2024-01-01', closingDay: null, rawStart: '2024-01-01', rawClosing: null, status: 'Actif' }], startedAt: now, sourceCounts: { clients: 0, payments: 0, parcours: 1 } } });
  const calls: string[] = [];
  assert.equal((await refreshNotionCommerce({ db: memory.db, config, token: 'synthetic', identitySecret: 'x'.repeat(32), fetcher: commerceFetcher({ mode: 'missing', calls }) as typeof fetch, maxPages: 3 })).status, 'complete');
  assert.deepEqual(calls, [`/v1/pages/${ARCHIVED_CLIENT}`]);
  assert.equal(memory.readerCheckpoint(legacyId).retainedArchivedClients, undefined);
  const retry = memory.runs.filter(run => run.stream_key === 'commerce_reader_checkpoint' && run.id !== legacyId).sort((left, right) => String(right.finished_at).localeCompare(String(left.finished_at)))[0];
  assert.equal(memory.readerCheckpoint(String(retry.id)).retainedArchivedClients?.[0]?.client.startedDay, '2024-01-01');
});

test('la recherche du dernier checkpoint publié ne décode pas chaque ancien checkpoint non publié', async () => {
  const memory = statefulMemoryDb();
  await refreshNotionCommerce({ db: memory.db, config, token: 'synthetic', identitySecret: 'x'.repeat(32), fetcher: commerceFetcher({ mode: 'baseline', calls: [] }) as typeof fetch, maxPages: 3 });
  const published = memory.readerCheckpoint(String(memory.runs.find(run => run.stream_key === 'commerce_reader_checkpoint')!.id));
  const partial: CommerceReadCheckpoint = { ...structuredClone(published), familyIndex: 0, cursor: null, completedAt: undefined, snapshot: { clients: [], payments: [], schedules: [], parcours: [], startedAt: published.startedAt, sourceCounts: {} } };
  for (let index = 0; index < 40; index++) memory.addReaderCheckpoint(partial);
  const before = memory.checkpointReads();
  const beforeAggregate = memory.aggregateReads();
  await assert.rejects(() => refreshNotionCommerce({ db: memory.db, config, token: 'synthetic', identitySecret: 'x'.repeat(32), fetcher: (async () => new Response('', { status: 503 })) as typeof fetch, maxPages: 3 }));
  assert.ok(memory.checkpointReads() - before <= 2);
  assert.ok(memory.aggregateReads() - beforeAggregate <= 3);
});

test('un millier de checkpoints est paginé et ses marqueurs restent dans des requêtes REST courtes', async () => {
  const memory = statefulMemoryDb();
  await refreshNotionCommerce({ db: memory.db, config, token: 'synthetic', identitySecret: 'x'.repeat(32), fetcher: commerceFetcher({ mode: 'baseline', calls: [] }) as typeof fetch, maxPages: 3 });
  const published = memory.readerCheckpoint(String(memory.runs.find(run => run.stream_key === 'commerce_reader_checkpoint')!.id));
  const partial: CommerceReadCheckpoint = { ...structuredClone(published), familyIndex: 0, cursor: null, completedAt: undefined, snapshot: { clients: [], payments: [], schedules: [], parcours: [], startedAt: published.startedAt, sourceCounts: {} } };
  for (let index = 0; index < 1_000; index++) memory.addReaderCheckpoint(partial);
  const beforeRows = structuredClone(memory.rows);
  await assert.rejects(() => refreshNotionCommerce({ db: memory.db, config, token: 'synthetic', identitySecret: 'x'.repeat(32), fetcher: (async () => new Response('', { status: 503 })) as typeof fetch, maxPages: 3 }));
  assert.deepEqual(memory.rows, beforeRows, 'un échec de lecture ne modifie aucun checkpoint historique');
  const batches = memory.markerBatchSizes();
  assert.ok(batches.length >= 11);
  assert.ok(batches.every(size => size > 0 && size <= CHECKPOINT_MARKER_BATCH_SIZE));
  assert.ok(batches.some(size => size === CHECKPOINT_MARKER_BATCH_SIZE));
});

test('un marqueur dupliqué est refusé sans choisir un miroir historique arbitraire', async () => {
  const memory = statefulMemoryDb();
  await refreshNotionCommerce({ db: memory.db, config, token: 'synthetic', identitySecret: 'x'.repeat(32), fetcher: commerceFetcher({ mode: 'baseline', calls: [] }) as typeof fetch, maxPages: 3 });
  const checkpointRunId = String(memory.runs.find(run => run.stream_key === 'commerce_reader_checkpoint')!.id);
  memory.addPublicationMarker(checkpointRunId, 'different-published-run');
  const beforeRows = structuredClone(memory.rows);
  await assert.rejects(() => refreshNotionCommerce({ db: memory.db, config, token: 'synthetic', identitySecret: 'x'.repeat(32), fetcher: (async () => new Response('', { status: 503 })) as typeof fetch, maxPages: 3 }), /CHECKPOINT_PUBLICATION_MARKER_CARDINALITY/);
  assert.deepEqual(memory.rows, beforeRows);
});

test('un checkpoint publié mais incomplet est refusé sans modifier l’historique', async () => {
  const memory = statefulMemoryDb();
  await refreshNotionCommerce({ db: memory.db, config, token: 'synthetic', identitySecret: 'x'.repeat(32), fetcher: commerceFetcher({ mode: 'baseline', calls: [] }) as typeof fetch, maxPages: 3 });
  const published = memory.readerCheckpoint(String(memory.runs.find(run => run.stream_key === 'commerce_reader_checkpoint')!.id));
  memory.addReaderCheckpoint({ ...structuredClone(published), familyIndex: 0, cursor: null, completedAt: undefined }, 'invalid-published-run');
  const beforeRows = structuredClone(memory.rows);
  await assert.rejects(() => refreshNotionCommerce({ db: memory.db, config, token: 'synthetic', identitySecret: 'x'.repeat(32), fetcher: (async () => new Response('', { status: 503 })) as typeof fetch, maxPages: 3 }), /CHECKPOINT_PUBLISHED_INVALID/);
  assert.deepEqual(memory.rows, beforeRows);
});
