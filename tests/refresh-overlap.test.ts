import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessTickLock, jobScope, tickSyncJobs, type SyncJob, type TickSummary } from '../src/lib/sync-jobs';
import { syncKpiSource, KPI_PROFILE, type KpiSourceBatch } from '../src/lib/kpi-source-store';
import { AppError } from '../src/lib/errors';
import type { Database, Row, SelectOptions, TableName } from '../src/lib/db';

// Données synthétiques. Le double reproduit uniquement ce que disent les migrations :
// - begin_sync_stream (007) : verrou consultatif par source/espace/flux/profil, tentative « running » de plus de 10 minutes
//   passée en échec « expired_worker », puis refus 55P03 si une tentative « running » existe, sinon insertion ;
// - db.ts traduit 55P03 en AppError 409 « source_busy » ;
// - finish_sync (001) : met à jour la seule tentative encore « running », sinon 55000 ;
// - source_aggregates (001) : clé unique (source, source_namespace, metric_key, period_from, period_to, dimensions_key, report_profile_key, sync_run_id).
const AGGREGATE_KEY = 'source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id';
function journalDatabase(clock: () => number) {
  const tables = new Map<TableName, Row[]>(), get = (table: TableName) => { if (!tables.has(table)) tables.set(table, []); return tables.get(table)!; };
  const calls: string[] = [];let sequence = 0;
  const matches = (row: Row, options: SelectOptions = {}) => Object.entries(options.eq ?? {}).every(([key, value]) => String(row[key]) === value) && Object.entries(options.in ?? {}).every(([key, values]) => values.includes(String(row[key])));
  const db: Database = {
    async select(table, options = {}) {
      calls.push(`select:${table}`);
      const order = (options.order ?? 'id').split(',')[0], sign = options.descending ? -1 : 1;
      return structuredClone(get(table).filter(row => matches(row, options)).sort((a, b) => String(a[order] ?? '').localeCompare(String(b[order] ?? '')) * sign).slice(0, options.limit ?? 1000));
    },
    async upsert(table, rows, conflict = 'id') {
      calls.push(`upsert:${table}`);
      const keys = conflict.split(',');
      for (const row of rows) {
        const prior = get(table).find(item => keys.every(key => item[key] === row[key]));
        if (prior) Object.assign(prior, structuredClone(row)); else get(table).push({ id: `row-${++sequence}`, ...structuredClone(row) });
      }
    },
    async rpc<T>(name: string, args: Row): Promise<T> {
      calls.push(`rpc:${name}`);
      const runs = get('sync_runs'), now = clock();
      if (name === 'begin_sync_stream') {
        const same = (row: Row) => row.source === args.p_source && row.source_namespace === args.p_namespace && row.stream_key === args.p_stream && row.query_profile_key === args.p_profile;
        for (const row of runs) if (same(row) && row.status === 'running' && Date.parse(String(row.started_at)) < now - 600_000) Object.assign(row, { status: 'failed', finished_at: new Date(now).toISOString(), error_code: 'expired_worker' });
        if (runs.some(row => same(row) && row.status === 'running')) throw new AppError('Une actualisation de cette source est déjà en cours.', 409, 'source_busy');
        const id = `run-${++sequence}`;
        runs.push({ id, source: args.p_source, source_namespace: args.p_namespace, stream_key: args.p_stream, query_profile_key: args.p_profile, period_from: args.p_from, period_to: args.p_to, started_at: new Date(now).toISOString(), status: 'running', pagination_complete: false, rows_rejected: 0 });
        return id as T;
      }
      if (name === 'finish_sync') {
        const row = runs.find(item => item.id === args.p_run && item.status === 'running');
        if (!row) throw new AppError('L’état de cette opération a changé. Recharge puis réessaie.', 409, 'state_changed');
        Object.assign(row, { status: args.p_status, finished_at: new Date(now).toISOString(), pagination_complete: args.p_complete, rows_rejected: args.p_rejected, error_code: args.p_error });
        return true as T;
      }
      throw new Error(`RPC inattendue ${name}`);
    },
    probe: async () => {},
  };
  return { db, get, calls };
}

const env = { COCKPIT_MODE: 'live', META_AD_ACCOUNT_ID: 'meta', META_ACCESS_TOKEN: 'synthetic' } as unknown as NodeJS.ProcessEnv;
const STREAM: Partial<Record<SyncJob, string>> = { meta: 'meta_account_daily', meta_ads: 'ad_daily', meta_catalog: 'ad_catalog', kpi_meta: 'kpi_meta_daily' };
const AT = Date.parse('2026-09-23T10:40:00Z'), FROM = '2026-09-20', TO = '2026-09-22';
const batch: KpiSourceBatch = { from: FROM, to: TO, observedAt: '2026-09-23T10:40:00.000Z', rows: [{ day: '2026-09-20', key: 'campaign-a', data: { spend: 1 } }, { day: '2026-09-21', key: 'campaign-a', data: { spend: 2 } }] };
const ROWS_PER_RUN = 4; // deux lignes quotidiennes et deux manifestes
/** Journal de départ : seules les dépenses KPI Meta sont dues, les trois autres flux Meta viennent d’être publiés. */
function seed(get: (table: TableName) => Row[]) {
  for (const job of ['meta', 'meta_ads', 'meta_catalog'] as SyncJob[]) {
    const scope = jobScope(job, env)!;
    get('sync_runs').push({ id: `seed-${job}`, source: 'meta', source_namespace: scope.namespace, query_profile_key: scope.profile, stream_key: STREAM[job], status: 'complete', pagination_complete: true, rows_rejected: 0, started_at: new Date(AT - 60_000).toISOString(), finished_at: new Date(AT - 55_000).toISOString() });
  }
}
const budget = () => ({ sourceFetch: async () => new Response('{}'), canStart: () => true, dispose: () => {} });
function gate() { let open!: () => void; const opened = new Promise<void>(resolve => { open = resolve; }); return { open, opened }; }

test('même instance : deux passages simultanés, un seul lance des unités, l’autre répond waiting sans rien lire', async () => {
  const { db, get, calls } = journalDatabase(() => AT);seed(get);
  const release = gate();let sourceReads = 0;
  const execute = (job: SyncJob, ctx: { db: Database }) => { assert.equal(job, 'kpi_meta', 'seules les dépenses KPI sont dues'); return syncKpiSource(ctx.db, 'meta', 'meta', FROM, TO, async () => { sourceReads++; await release.opened; return batch; }); };
  const lock = createProcessTickLock();
  const first = tickSyncJobs(db, env, { lock, now: () => AT, budget: budget(), execute });
  let secondCalls = 0;
  const counted: Database = { select: async (...args) => { secondCalls++; return db.select(...args); }, upsert: async (...args) => { secondCalls++; return db.upsert(...args); }, rpc: async (...args) => { secondCalls++; return db.rpc(...args); }, probe: db.probe };
  const second = await tickSyncJobs(counted, env, { lock, now: () => AT, budget: budget(), execute: async () => assert.fail('aucune unité dans le second passage') });
  release.open();const winner = await first;
  assert.equal(second.status, 'waiting'); assert.equal(second.units, 0); assert.deepEqual(second.unitResults, []);
  assert.match(String(second.reason), /déjà en cours sur cette instance/);
  assert.equal(winner.status, 'complete'); assert.deepEqual(winner.unitResults, [{ job: 'kpi_meta', status: 'complete' }]);
  assert.equal(sourceReads, 1, 'une seule lecture source');
  assert.equal(secondCalls, 0, 'le second passage ne lit ni n’écrit rien');
  assert.equal(calls.filter(call => call === 'rpc:begin_sync_stream').length, 1, 'une seule réclamation en base');
  assert.equal(get('source_aggregates').length, ROWS_PER_RUN, 'aucune ligne dupliquée');
  // Le verrou est rendu : un passage suivant s’exécute normalement et ne trouve rien à faire.
  const after = await tickSyncJobs(db, env, { lock, now: () => AT + 60_000, budget: budget(), execute: async () => assert.fail('rien n’est dû') });
  assert.equal(after.status, 'complete');
});

test('deux instances : le même flux dû est réclamé une fois ; la seconde réclamation (409 source_busy) donne waiting, jamais failed', async () => {
  const { db, get, calls } = journalDatabase(() => AT);seed(get);
  // Les deux passages lisent le journal avant toute réclamation : chacun croit le flux dû.
  const loaded = gate();let firstLoads = 0;
  const shared: Database = { ...db, select: async (table, options) => { const rows = await db.select(table, options); if (firstLoads < 16) { firstLoads++; if (firstLoads === 16) loaded.open(); await loaded.opened; } return rows; } };
  const release = gate();let sourceReads = 0, claimed = 0;
  const execute = (job: SyncJob, ctx: { db: Database }) => { assert.equal(job, 'kpi_meta', 'seules les dépenses KPI sont dues'); return syncKpiSource(ctx.db, 'meta', 'meta', FROM, TO, async () => { sourceReads++; await release.opened; return batch; }); };
  const tick = () => tickSyncJobs(shared, env, { lock: createProcessTickLock(), now: () => AT, budget: budget(), execute: async (job, ctx) => { claimed++; return execute(job, ctx); } });
  const running = [tick(), tick()];
  const loser = await Promise.race(running);
  release.open();
  const results = await Promise.all(running) as TickSummary[];
  const winner = results.find(result => result !== loser)!;
  assert.equal(claimed, 2, 'les deux passages ont tenté l’unité');
  assert.equal(calls.filter(call => call === 'rpc:begin_sync_stream').length, 2);
  assert.deepEqual(loser.unitResults, [{ job: 'kpi_meta', status: 'waiting' }]);
  assert.equal(loser.status, 'waiting', 'une réclamation refusée n’est pas une panne de source');
  assert.equal(loser.streams?.find(stream => stream.job === 'kpi_meta')?.state, 'waiting');
  assert.equal(loser.streams?.find(stream => stream.job === 'kpi_meta')?.errorCode, undefined);
  assert.deepEqual(winner.unitResults, [{ job: 'kpi_meta', status: 'complete' }]); assert.equal(winner.status, 'complete');
  assert.equal(sourceReads, 1, 'une seule lecture source');
  const kpiRuns = get('sync_runs').filter(row => row.stream_key === 'kpi_meta_daily');
  assert.equal(kpiRuns.length, 1, 'le refus n’a rien écrit dans le journal');
  assert.equal(kpiRuns[0].status, 'complete');
  assert.equal(calls.filter(call => call === 'rpc:finish_sync').length, 1, 'une seule publication');
  assert.equal(get('source_aggregates').length, ROWS_PER_RUN, 'aucune ligne dupliquée');
  assert.ok(get('source_aggregates').every(row => row.sync_run_id === kpiRuns[0].id));
});

test('rejeu : réécrire les lignes d’une même tentative ne duplique rien ; une nouvelle tentative ajoute une version complète de sa fenêtre', async () => {
  let clock = AT;
  const { db, get } = journalDatabase(() => clock);
  const first = await syncKpiSource(db, 'meta', 'meta', FROM, TO, async () => batch);
  const written = structuredClone(get('source_aggregates'));
  assert.equal(written.length, ROWS_PER_RUN);
  // Réponse perdue puis nouvel envoi des mêmes lignes : la clé de conflit contient sync_run_id, la ligne est remplacée.
  await db.upsert('source_aggregates', written.map(({ id: _id, ...row }) => row), AGGREGATE_KEY);
  assert.equal(get('source_aggregates').length, ROWS_PER_RUN, 'aucune ligne dupliquée au rejeu d’une tentative');
  // Une tentative terminée ne peut pas être republiée : finish_sync refuse (55000, traduit en 409 state_changed).
  await assert.rejects(db.rpc('finish_sync', { p_run: first.runId, p_status: 'complete', p_read: 2, p_rejected: 0, p_complete: true, p_error: null }), (error: AppError) => error.code === 'state_changed');
  // Passage suivant, 30 minutes plus tard : une nouvelle tentative écrit sa propre version de la même fenêtre.
  clock += 30 * 60_000;
  const second = await syncKpiSource(db, 'meta', 'meta', FROM, TO, async () => batch);
  assert.notEqual(second.runId, first.runId);
  assert.equal(get('source_aggregates').length, 2 * ROWS_PER_RUN, 'chaque tentative conserve sa version : volume proportionnel au nombre de passages');
  assert.equal(new Set(get('source_aggregates').map(row => row.sync_run_id)).size, 2);
  assert.equal(get('sync_runs').filter(row => row.status === 'complete' && row.query_profile_key === KPI_PROFILE).length, 2);
});

test('reprise après échec : une tentative interrompue ne bloque le flux que dix minutes, puis la suivante publie', async () => {
  let clock = AT;
  const { db, get } = journalDatabase(() => clock);
  // Fonction arrêtée après la réclamation (aucun finish_sync) : la tentative reste « running ».
  await db.rpc('begin_sync_stream', { p_source: 'meta', p_namespace: 'meta', p_from: 'a', p_to: 'b', p_profile: KPI_PROFILE, p_coverage_kind: 'aggregate_period', p_stream: 'kpi_meta_daily' });
  clock += 5 * 60_000;
  await assert.rejects(syncKpiSource(db, 'meta', 'meta', FROM, TO, async () => batch), (error: AppError) => error.code === 'source_busy');
  clock += 6 * 60_000;
  const resumed = await syncKpiSource(db, 'meta', 'meta', FROM, TO, async () => batch);
  assert.equal(resumed.status, 'complete');
  const runs = get('sync_runs');
  assert.deepEqual(runs.map(row => [row.status, row.error_code ?? null]), [['failed', 'expired_worker'], ['complete', null]]);
  assert.ok(get('source_aggregates').every(row => row.sync_run_id === resumed.runId), 'la tentative abandonnée n’a laissé aucune ligne publiée');
});
