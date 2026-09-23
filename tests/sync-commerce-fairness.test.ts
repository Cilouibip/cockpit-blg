import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseSyncJob, jobScope, syncStreamStates, tickSyncJobs, type SyncJob } from '../src/lib/sync-jobs';
import type { Database, Row } from '../src/lib/db';

const time = Date.parse('2026-09-18T16:42:00Z');
const iso = (at: number) => new Date(at).toISOString();
const env = {
  // Lecteur des ventes explicitement actif : la pause par défaut est couverte par commerce-reader-pause.test.ts.
  NODE_ENV: 'test', COCKPIT_MODE: 'live', META_AD_ACCOUNT_ID: '123', NOTION_TOKEN: 'synthetic', BLG_COMMERCE_READER: 'active',
  NOTION_COMMERCE_CONFIG: JSON.stringify({ clients: { dataSourceId: 'clients' }, payments: { dataSourceId: 'payments' }, schedule: { dataSourceId: 'schedule' }, parcours: { dataSourceId: 'parcours' } }),
} as NodeJS.ProcessEnv;
const commerceScope = jobScope('commerce', env)!;
const row = (job: 'commerce' | 'meta_ads' | 'meta', at: number, status = 'complete'): Row => ({
  id: `${job}-${at}`, source: job === 'commerce' ? 'notion' : 'meta',
  source_namespace: jobScope(job, env)!.namespace, query_profile_key: jobScope(job, env)!.profile,
  stream_key: job === 'commerce' ? 'commerce_declared_snapshot' : job === 'meta_ads' ? 'ad_daily' : 'meta_account_daily',
  started_at: iso(at), finished_at: status === 'running' ? null : iso(at), status, pagination_complete: status === 'complete',
});
const checkpoint = (at: number, status = 'complete'): Row => ({ ...row('commerce', at, status), id: `checkpoint-${at}`, stream_key: 'commerce_reader_checkpoint' });
const base = () => [row('commerce', time - 7_279_000), row('meta_ads', time - 7_219_000, 'failed'), row('meta', time)];
function database(rows: Row[], observed: Parameters<Database['select']>[1][] = []): Database {
  return {
    async select(_table, options) {
      observed.push(options);
      return rows.filter(r => Object.entries(options?.eq ?? {}).every(([key, value]) => String(r[key]) === value) &&
        Object.entries(options?.in ?? {}).every(([key, values]) => values.includes(String(r[key]))))
        .sort((a, b) => (String(a.started_at).localeCompare(String(b.started_at))) * (options?.descending ? -1 : 1))
        .slice(0, options?.limit ?? 1000);
    },
    upsert: async () => assert.fail('scheduler does not write source rows'),
    rpc: async () => assert.fail('scheduler does not start source RPCs through this fixture'),
    probe: async () => {},
  };
}

test('a fresh Commerce checkpoint yields to overdue Meta without making Commerce fresh', () => {
  const rows = base();
  assert.equal(chooseSyncJob(rows, time, ['commerce', 'meta_ads']), 'commerce');
  rows.push(checkpoint(time - 10_000));
  assert.equal(chooseSyncJob(rows, time, ['commerce', 'meta_ads']), 'meta_ads');
  const commerce = syncStreamStates(rows, time, ['commerce'])[0];
  assert.equal(commerce.state, 'due'); assert.equal(commerce.stale, true);
  assert.equal(commerce.lastSuccessAt, rows[0].finished_at); assert.equal(commerce.dataAsOf, rows[0].started_at);
  const missing = syncStreamStates([checkpoint(time - 10_000)], time, ['commerce'])[0];
  assert.equal(missing.state, 'due'); assert.equal(missing.lastSuccessAt, null); assert.equal(missing.dataAsOf, null);
});

test('two budgeted ticks serve Commerce then Meta even while Commerce has not published', async () => {
  const rows = base(), db = database(rows), jobs: SyncJob[] = [];
  async function tick(at: number) {
    let room = true;
    return tickSyncJobs(db, env, {
      now: () => at, budget: { sourceFetch: async () => assert.fail('no source network'), canStart: () => room, dispose: () => {} },
      execute: async job => {
        jobs.push(job); room = false;
        if (job === 'commerce') { rows.push(checkpoint(at)); return { status: 'partial' }; }
        assert.equal(job, 'meta_ads'); rows.push(row('meta_ads', at)); return { status: 'complete' };
      },
    });
  }
  const first = await tick(time), second = await tick(time + 60_000);
  assert.deepEqual(jobs, ['commerce', 'meta_ads']);
  assert.equal(first.status, 'partial'); assert.equal(second.status, 'partial');
  assert.equal(second.streams?.find(s => s.job === 'meta_ads')?.state, 'complete');
  assert.equal(second.streams?.find(s => s.job === 'commerce')?.state, 'due');
  assert.equal(second.streams?.find(s => s.job === 'commerce')?.lastSuccessAt, rows[0].finished_at);
});

test('an active Commerce reader defers Commerce alone and an expired lease allows resumption', () => {
  for (const explicitLease of [false, true]) {
    const active = checkpoint(time - 30_000, 'running');
    if (explicitLease) active.lease_until = iso(time + 60_000);
    let rows = [...base(), active];
    let state = syncStreamStates(rows, time, ['commerce'])[0];
    assert.equal(state.state, 'waiting'); assert.equal(state.stale, true);
    assert.equal(chooseSyncJob(rows, time, ['commerce', 'meta_ads']), 'meta_ads');
    rows = [...base(), explicitLease ? { ...active, lease_until: iso(time - 1) } : checkpoint(time - 601_000, 'running')];
    state = syncStreamStates(rows, time, ['commerce'])[0];
    assert.equal(state.state, 'due'); assert.equal(chooseSyncJob(rows, time, ['commerce']), 'commerce');
  }
});

test('failed and partial checkpoints preserve backoff, incomplete state and the last publication', () => {
  const failed = { ...checkpoint(time - 30_000, 'failed'), error_code: 'COMMERCE_READER_FAILED' };
  let state = syncStreamStates([...base(), failed], time, ['commerce'])[0];
  assert.equal(state.state, 'failed'); assert.equal(state.errorCode, 'COMMERCE_READER_FAILED');
  assert.equal(state.lastSuccessAt, base()[0].finished_at); assert.equal(state.stale, true);
  assert.equal(chooseSyncJob([...base(), failed], time, ['commerce', 'meta_ads']), 'meta_ads');
  state = syncStreamStates([...base(), failed], time + 300_000, ['commerce'])[0];
  assert.equal(state.state, 'due');
  state = syncStreamStates([...base(), checkpoint(time - 30_000, 'partial')], time, ['commerce'])[0];
  assert.equal(state.state, 'due'); assert.equal(state.lastSuccessAt, base()[0].finished_at); assert.equal(state.stale, true);
});

test('checkpoint loading uses the exact Commerce namespace and profile, and only metadata', async () => {
  const observed: Parameters<Database['select']>[1][] = [];
  const rows = [...base(),
    { ...checkpoint(time - 1_000, 'running'), source_namespace: 'other-project' },
    { ...checkpoint(time - 500, 'running'), query_profile_key: 'other-profile' },
  ];
  const result = await tickSyncJobs(database(rows, observed), env, {
    now: () => time, budget: { sourceFetch: async () => assert.fail('no network'), canStart: () => false, dispose: () => {} },
  });
  assert.equal(result.streams?.find(s => s.job === 'commerce')?.state, 'due');
  const lookup = observed.find(o => o?.eq?.stream_key === 'commerce_reader_checkpoint')!;
  assert.equal(lookup.eq?.source_namespace, commerceScope.namespace);
  assert.equal(lookup.eq?.query_profile_key, commerceScope.profile); assert.equal(lookup.limit, 1);
  assert.ok(lookup.columns?.includes('started_at'));
  assert.ok(!lookup.columns?.some(c => ['checkpoint', 'cursor_before', 'cursor_after', 'lease_token'].includes(c)));
});
