import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpointParts, refreshNotionCommerce } from '../src/lib/sync-notion-commerce';
import type { Database, Row } from '../src/lib/db';
import { AppError } from '../src/lib/errors';

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

test('une erreur après une page garde un checkpoint vérifié et clôt le worker sans publication', async () => {
  const memory = memoryDb();
  const fetcher = async (input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname.includes('/clients')) return url.pathname.endsWith('/query') ? Response.json({ results: [], has_more: false }) : schema(config.clients.fields);
    throw new Error('provider unavailable');
  };
  const result = await refreshNotionCommerce({ db: memory.db, config, token: 'synthetic', identitySecret: 'x'.repeat(32), fetcher: fetcher as typeof fetch });
  assert.equal(result.status, 'failed');
  assert.equal(result.coverage, 'checkpoint');
  assert.equal(result.counts.pages, 1);
  assert.ok(memory.rows.length > 0);
  assert.deepEqual(memory.finishes, [{ p_run: 'run-test', p_status: 'complete', p_read: 0, p_rejected: 0, p_complete: true, p_error: null }]);
});

test('un worker déjà verrouillé répond partiel sans staging parasite', async () => {
  const memory = memoryDb(true);
  const result = await refreshNotionCommerce({ db: memory.db, config, token: 'synthetic', identitySecret: 'x'.repeat(32) });
  assert.deepEqual(result, { status: 'partial', counts: { pages: 0, read: 0 }, coverage: 'unavailable', reason: 'actualisation_en_cours' });
  assert.equal(memory.rows.length, 0);
  assert.equal(memory.finishes.length, 0);
});
