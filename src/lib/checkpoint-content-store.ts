import { createHash } from 'node:crypto';
import type { Database, Row } from './db';
import { AppError } from './errors';

/** No automatic fallback for writes after a compact-storage RPC failure. */
export async function stageCheckpointContent(db: Database, input: {
 runId: string; profile: string; startedAt: string; serialized: string; parts: string[];
}) {
 const hash = createHash('sha256').update(input.serialized, 'utf8').digest('hex');
 if (!input.parts.length || input.parts.length > 10000 || input.parts.join('') !== input.serialized
  || input.parts.some(part => Buffer.byteLength(JSON.stringify({ part }), 'utf8') > 2800)) throw Error('CHECKPOINT_STAGE_INVALID');
 for (let offset = 0; offset < input.parts.length; offset += 100) {
  await db.rpc('cockpit_stage_checkpoint_parts', {
   p_run: input.runId, p_profile: input.profile, p_started_at: input.startedAt,
   p_hash: hash, p_total: input.parts.length,
   p_parts: input.parts.slice(offset, offset + 100).map((part, index) => ({ index: offset + index, part })),
  });
 }
}

/** Only a missing RPC permits pre-migration legacy reads. Other failures remain visible. */
export async function checkpointContentRows(db: Database, runId: string, offset: number): Promise<Row[]> {
 if (db.checkpointContentStorage) {
  try {
   const rows = await db.rpc<Row[]>('cockpit_checkpoint_rows', { p_run: runId, p_offset: offset, p_limit: 1000 });
   if (!Array.isArray(rows)) throw Error('CHECKPOINT_READ_INVALID');
   return rows;
  } catch (error) {
   if (!(error instanceof AppError) || error.code !== 'schema_missing') throw error;
  }
 }
 return db.select('source_aggregates', { eq: { sync_run_id: runId, metric_key: 'notion_commerce_checkpoint' }, order: 'dimensions_key', from: offset, limit: 1000 });
}

/** Prepared per-run procedure: dry run is the default and creates no content.
 * Fence all writers and receive equality/rollback tests before apply on a real DB. */
export function checkpointBackfillManifest(db: Database, runId: string, options: { apply?: boolean; restore?: boolean } = {}) {
 return db.rpc<Row>('cockpit_checkpoint_backfill', { p_run: runId, p_apply: options.apply === true, p_restore: options.restore === true });
}

export interface CheckpointRolloutPlan { runs: { runId: string; logicalRowsHash: string; serializedHash: string; parts: number }[] }
/** One reviewable batch, maximum eight finalized runs. The owner changes the
 * database write fence separately; this helper cannot activate or bypass it.
 * Persist each returned manifest before requesting the next batch. On failure,
 * already-completed runs remain recoverable and a fresh dry-run resumes safely. */
export async function checkpointRolloutBatch(db: Database, runIds: string[], options: {
 phase?: 'dry-run' | 'convert' | 'rollback'; expected?: CheckpointRolloutPlan;
 onManifest?: (manifest: Row) => Promise<void>;
} = {}): Promise<CheckpointRolloutPlan> {
 if (!runIds.length || runIds.length > 8 || new Set(runIds).size !== runIds.length
  || runIds.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) throw Error('CHECKPOINT_ROLLOUT_BATCH_INVALID');
 const phase = options.phase ?? 'dry-run', runs: CheckpointRolloutPlan['runs'] = [];
 if (phase !== 'dry-run' && (!options.expected || options.expected.runs.length !== runIds.length
  || options.expected.runs.some((run, index) => run.runId !== runIds[index]))) throw Error('CHECKPOINT_ROLLOUT_EXPECTED_MANIFEST_REQUIRED');
 for (const [index, runId] of runIds.entries()) {
  const dry = await checkpointBackfillManifest(db, runId);
  if (dry.equivalent !== true || typeof dry.logicalRowsHash !== 'string' || typeof dry.serializedHash !== 'string'
   || !Number.isInteger(dry.parts)) throw Error('CHECKPOINT_ROLLOUT_MANIFEST_INVALID');
  const manifest = { runId, logicalRowsHash: dry.logicalRowsHash, serializedHash: dry.serializedHash, parts: Number(dry.parts) };
  const expected = options.expected?.runs[index];
  if (phase !== 'dry-run' && (!expected || expected.logicalRowsHash !== manifest.logicalRowsHash
   || expected.serializedHash !== manifest.serializedHash || expected.parts !== manifest.parts)) throw Error('CHECKPOINT_ROLLOUT_SOURCE_CHANGED');
  const result = phase === 'dry-run' ? dry : await checkpointBackfillManifest(db, runId, { apply: true, restore: phase === 'rollback' });
  if (result.equivalent !== true || result.logicalRowsHash !== manifest.logicalRowsHash
   || result.afterLogicalRowsHash !== manifest.logicalRowsHash) throw Error('CHECKPOINT_ROLLOUT_EQUIVALENCE_FAILED');
  await options.onManifest?.({ ...result, phase }); runs.push(manifest);
 }
 return { runs };
}
