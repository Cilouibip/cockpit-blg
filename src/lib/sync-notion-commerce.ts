import { createHash } from 'node:crypto';
import { ConnectorError, safeConnectorError } from '../connectors/http';
import { AppError } from './errors';
import type { Database, Row } from './db';
import { retainConfirmedArchivedClients, reportFromCheckpoint } from './notion-commerce-archive';
import { publishNotionCommerceReport } from './notion-commerce-storage';
import { notionCommerceProfile, readNotionCommerceSnapshot, type CommerceReadCheckpoint, type NotionCommerceConfig } from '../connectors/notion-commerce';

const STREAM = 'commerce_reader_checkpoint';
const CHECKPOINT = 'notion_commerce_checkpoint';
const PUBLICATION = 'notion_commerce_checkpoint_publication';
const MAX_PART_BYTES = 2800;
const MAX_PARTS = 10_000;

export interface CommerceRefreshResult {
  status: 'partial' | 'complete' | 'failed';
  counts: { pages: number; read: number };
  coverage: 'checkpoint' | 'published' | 'unavailable';
  reason?: string;
}

type StoredCheckpoint = { runId: string; checkpoint: CommerceReadCheckpoint; publishedRunId?: string };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const commerceError = (error: unknown) => error instanceof ConnectorError ? safeConnectorError(error).replace(/[()]/g, '') : error instanceof Error && /^(COMMERCE_[A-Z_]+|PAYMENT_PROVIDER_CONFLICT|INVALID_PAYMENT_AMOUNT|CHECKPOINT_[A-Z_]+)$/.test(error.message) ? error.message : 'COMMERCE_READER_FAILED';
const safeTime = () => new Date().toISOString();

/** Splits only on code-point boundaries, never between the UTF-16 halves of an emoji. */
export function checkpointParts(serialized: string, maxBytes = MAX_PART_BYTES): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 64) throw new Error('INVALID_CHECKPOINT_LIMIT');
  const result: string[] = [];
  let part = '';
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ part: '' }), 'utf8');
  let partBytes = envelopeBytes;
  for (const point of serialized) {
    // JSON escapes each code point independently. Counting only the addition keeps
    // the same persisted boundaries without serializing the growing prefix twice.
    const pointBytes = Buffer.byteLength(JSON.stringify(point), 'utf8') - 2;
    if (envelopeBytes + pointBytes > maxBytes) throw new Error('CHECKPOINT_PART_TOO_LARGE');
    if (part && partBytes + pointBytes > maxBytes) {
      result.push(part);
      if (result.length >= MAX_PARTS) throw new Error('CHECKPOINT_PART_LIMIT');
      part = '';
      partBytes = envelopeBytes;
    }
    part += point;
    partBytes += pointBytes;
  }
  if (part) result.push(part);
  if (!result.length || result.length > MAX_PARTS) throw new Error('CHECKPOINT_PART_LIMIT');
  return result;
}

async function rowsForRun(db: Database, runId: string, metric: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; from < MAX_PARTS; from += 1000) {
    const page = await db.select('source_aggregates', { eq: { sync_run_id: runId, metric_key: metric }, order: 'dimensions_key', from, limit: 1000 });
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
  throw new Error('CHECKPOINT_READ_LIMIT');
}

function decodeCheckpoint(rows: Row[]): CommerceReadCheckpoint | null {
  if (!rows.length || rows.length > MAX_PARTS) return null;
  const parts = rows.map(row => row.dimensions as Row).sort((a, b) => Number(a.index) - Number(b.index));
  const total = Number(parts[0]?.total), hash = parts[0]?.hash;
  if (!Number.isInteger(total) || total !== parts.length || typeof hash !== 'string' || parts.some((part, index) => part.index !== index || part.total !== total || part.hash !== hash || typeof part.part !== 'string' || Buffer.byteLength(JSON.stringify({ part: part.part }), 'utf8') > MAX_PART_BYTES)) return null;
  const serialized = parts.map(part => part.part as string).join('');
  if (sha256(serialized) !== hash) return null;
  try {
    const value = JSON.parse(serialized) as CommerceReadCheckpoint;
    return value.version === 1 && typeof value.profile === 'string' && typeof value.identityConfigKey === 'string' && value.snapshot && Number.isInteger(value.pages) ? value : null;
  } catch { return null; }
}

async function checkpointPair(db: Database, namespace: string, profile: string): Promise<{ latest: StoredCheckpoint | null; published: StoredCheckpoint | null }> {
  const runs = await db.select('sync_runs', { eq: { source: 'notion', source_namespace: namespace, stream_key: STREAM, query_profile_key: profile, status: 'complete', pagination_complete: 'true', rows_rejected: '0' }, order: 'finished_at,id', descending: true, limit: 1000 });
  let latest: StoredCheckpoint | null = null, published: StoredCheckpoint | null = null;
  for (const run of runs) {
    const runId = String(run.id);
    const publication = await rowsForRun(db, runId, PUBLICATION);
    const publishedRunId = publication.length === 1 && typeof (publication[0].dimensions as Row).publishedRunId === 'string' ? String((publication[0].dimensions as Row).publishedRunId) : undefined;
    // Once a current checkpoint is known, only a marked publication can supply
    // the historical mirror. This avoids decoding every old fragmented snapshot.
    if (latest && !publishedRunId) continue;
    const checkpoint = decodeCheckpoint(await rowsForRun(db, runId, CHECKPOINT));
    if (!checkpoint) continue;
    const entry = { runId, checkpoint, publishedRunId };
    if (!latest) latest = entry;
    if (publishedRunId && checkpoint.completedAt) { published = entry; break; }
  }
  return { latest, published };
}

function deadlineFetcher(fetcher: typeof fetch, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const relay = () => controller.abort(init?.signal?.reason);
    if (init?.signal?.aborted) relay(); else init?.signal?.addEventListener('abort', relay, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetcher(input, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timer); init?.signal?.removeEventListener('abort', relay); }
  };
}

async function stageCheckpoint(db: Database, runId: string, config: NotionCommerceConfig, checkpoint: CommerceReadCheckpoint) {
  const serialized = JSON.stringify(checkpoint), parts = checkpointParts(serialized), hash = sha256(serialized), profile = notionCommerceProfile(config);
  const base = { source: 'notion', source_namespace: config.parcours.dataSourceId, metric_key: CHECKPOINT, period_from: '1970-01-01T00:00:00Z', period_to: checkpoint.startedAt, report_profile_key: profile, sync_run_id: runId, timezone: 'Europe/Paris', coverage_state: 'partial', unit: 'count', currency: null, currency_exponent: null, tax_basis: 'unknown', definition_version: profile, source_locator: 'notion:commerce-reader-checkpoint' };
  const rows = parts.map((part, index) => ({ ...base, dimensions_key: `checkpoint:${String(index).padStart(6, '0')}`, value: 1, dimensions: { index, total: parts.length, hash, part } }));
  for (let index = 0; index < rows.length; index += 100) await db.upsert('source_aggregates', rows.slice(index, index + 100), 'source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id');
  const verified = decodeCheckpoint(await rowsForRun(db, runId, CHECKPOINT));
  if (!verified || sha256(JSON.stringify(verified)) !== hash) throw new Error('CHECKPOINT_STAGE_INVALID');
}

async function markPublished(db: Database, checkpointRunId: string, config: NotionCommerceConfig, publishedRunId: string) {
  const profile = notionCommerceProfile(config);
  await db.upsert('source_aggregates', [{ source: 'notion', source_namespace: config.parcours.dataSourceId, metric_key: PUBLICATION, period_from: '1970-01-01T00:00:00Z', period_to: '2100-01-01T00:00:00Z', dimensions_key: 'published', report_profile_key: profile, sync_run_id: checkpointRunId, timezone: 'Europe/Paris', coverage_state: 'complete', value: 1, unit: 'count', currency: null, currency_exponent: null, tax_basis: 'unknown', dimensions: { publishedRunId }, definition_version: profile, source_locator: 'notion:commerce-reader-publication' }], 'source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id');
}

export async function refreshNotionCommerce(options: { db: Database; config: NotionCommerceConfig; token: string; identitySecret: string; fetcher?: typeof fetch; maxPages?: number }): Promise<CommerceRefreshResult> {
  const { db, config } = options, profile = notionCommerceProfile(config), namespace = config.parcours.dataSourceId, now = safeTime();
  let runId: string | undefined, saved: CommerceReadCheckpoint | undefined;
  try {
    try { runId = await db.rpc<string>('begin_sync_stream', { p_source: 'notion', p_namespace: namespace, p_from: '1970-01-01T00:00:00Z', p_to: now, p_profile: profile, p_coverage_kind: 'source_snapshot', p_stream: STREAM }); }
    catch (error) { if (error instanceof AppError && error.status === 409) return { status: 'partial', counts: { pages: 0, read: 0 }, coverage: 'unavailable', reason: 'actualisation_en_cours' }; throw error; }
    const { latest: previous, published: baseline } = await checkpointPair(db, namespace, profile);
    const deadline = Date.now() + 30_000;
    const fetcher = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('COMMERCE_REFRESH_DEADLINE');
      return deadlineFetcher(options.fetcher ?? fetch, remaining)(input, init);
    };
    const reconcile = (checkpoint: CommerceReadCheckpoint) => retainConfirmedArchivedClients({ current: checkpoint, previous: baseline ?? undefined, config, token: options.token, fetcher });
    if (previous?.checkpoint.completedAt && !previous.publishedRunId && Date.now() - Date.parse(previous.checkpoint.completedAt) < 3_600_000) {
      saved = await reconcile(previous.checkpoint);
      await stageCheckpoint(db, runId, config, saved);
      const report = reportFromCheckpoint(saved);
      const published = await publishNotionCommerceReport(db, config, report);
      await markPublished(db, runId, config, published.runId);
      await db.rpc('finish_sync', { p_run: runId, p_status: 'complete', p_read: 0, p_rejected: 0, p_complete: true, p_error: null });
      return { status: 'complete', counts: { pages: previous.checkpoint.pages, read: Object.values(previous.checkpoint.snapshot.sourceCounts).reduce((a, b) => a + b, 0) }, coverage: 'published' };
    }
    const resumed = previous && !previous.checkpoint.completedAt ? previous.checkpoint : undefined;
    const read = await readNotionCommerceSnapshot({ config, token: options.token, identitySecret: options.identitySecret, checkpoint: resumed, maxPages: Math.min(Math.max(options.maxPages ?? 3, 3), 6), fetcher, onCheckpoint: async checkpoint => { saved = checkpoint; } });
    saved = read.complete ? await reconcile(read.checkpoint) : read.checkpoint;
    await stageCheckpoint(db, runId, config, saved);
    await db.rpc('finish_sync', { p_run: runId, p_status: 'complete', p_read: Object.values(saved.snapshot.sourceCounts).reduce((a, b) => a + b, 0), p_rejected: 0, p_complete: true, p_error: null });
    if (!read.complete) return { status: 'partial', counts: { pages: saved.pages, read: Object.values(saved.snapshot.sourceCounts).reduce((a, b) => a + b, 0) }, coverage: 'checkpoint' };
    const report = reportFromCheckpoint(saved);
    const published = await publishNotionCommerceReport(db, config, report);
    await markPublished(db, runId, config, published.runId);
    return { status: 'complete', counts: { pages: saved.pages, read: Object.values(saved.snapshot.sourceCounts).reduce((a, b) => a + b, 0) }, coverage: 'published' };
  } catch (error) {
    if (runId && saved) {
      try {
        await stageCheckpoint(db, runId, config, saved);
        await db.rpc('finish_sync', { p_run: runId, p_status: 'complete', p_read: Object.values(saved.snapshot.sourceCounts).reduce((a, b) => a + b, 0), p_rejected: 0, p_complete: true, p_error: commerceError(error) });
        return { status: 'failed', counts: { pages: saved.pages, read: Object.values(saved.snapshot.sourceCounts).reduce((a, b) => a + b, 0) }, coverage: 'checkpoint', reason: 'lecture_interrompue_checkpoint_sauvegarde' };
      } catch { /* original failure remains the useful result */ }
    }
    if (runId) await db.rpc('finish_sync', { p_run: runId, p_status: 'failed', p_read: 0, p_rejected: 0, p_complete: false, p_error: commerceError(error) }).catch(() => undefined);
    throw error;
  }
}
