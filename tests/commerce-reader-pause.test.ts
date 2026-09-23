import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { commerceReaderMode, getConfig } from '../src/lib/config';
import { commerceControlPass, configuredJobScope, jobScope, tickSyncJobs, type SyncJob } from '../src/lib/sync-jobs';
import { connections } from '../src/lib/connections';
import { Connections, commerceReaderPaused, resultsRefreshSources } from '../src/components/Cockpit';
import { formatDate } from '../src/components/ui-format';
import { AppError } from '../src/lib/errors';
import type { Database, Row } from '../src/lib/db';
import type { ConnectionsResponse, DashboardFilters } from '../src/lib/ui-contract';

// Données synthétiques uniquement : aucun identifiant de source, aucune date ni aucun chiffre métier réels.
const commerceConfig = JSON.stringify({ clients: { dataSourceId: 'ds-clients' }, payments: { dataSourceId: 'ds-payments' }, schedule: { dataSourceId: 'ds-schedule' }, parcours: { dataSourceId: 'ds-parcours' } });
const baseEnv = { NODE_ENV: 'test', COCKPIT_MODE: 'live', NOTION_DATA_SOURCE_ID: 'notion', META_AD_ACCOUNT_ID: 'meta', WIX_SITE_ID: 'wix', WIX_API_KEY: 'k', NOTION_TOKEN: 'synthetic', NOTION_COMMERCE_CONFIG: commerceConfig, IDENTITY_HMAC_SECRET: 'x'.repeat(32) } as NodeJS.ProcessEnv;
const withReader = (value?: string) => { const env = { ...baseEnv }; if (value !== undefined) env.BLG_COMMERCE_READER = value; return env; };
const COMMERCE_STREAMS = ['commerce_declared_snapshot', 'commerce_reader_checkpoint'];

test('réglage serveur : pause par défaut, seule la valeur active rétablit le lecteur des ventes', () => {
  assert.equal(commerceReaderMode({}), 'paused', 'variable absente = pause');
  for (const value of ['', 'paused', 'Active', 'ACTIVE', 'on', 'true', 'yes']) assert.equal(commerceReaderMode({ BLG_COMMERCE_READER: value }), 'paused', `« ${value} » ne réactive pas le lecteur`);
  assert.equal(commerceReaderMode({ BLG_COMMERCE_READER: 'active' }), 'active');
  assert.equal(commerceReaderMode({ BLG_COMMERCE_READER: ' active\n' }), 'active', 'un retour à la ligne copié avec la valeur ne change pas son sens');
  assert.equal(getConfig({}).commerceReader, 'paused');
  assert.equal(getConfig({ BLG_COMMERCE_READER: 'active' }).commerceReader, 'active');
});

test('planning : en pause, seule l’unité commerce disparaît ; la configuration reste lisible pour les publications', () => {
  const jobs: SyncJob[] = ['notion', 'meta', 'wix', 'receipts', 'meta_ads', 'meta_catalog', 'quiz', 'masterclass', 'forms', 'quiz_entries', 'client_history', 'kpi_meta', 'kpi_posthog', 'kpi_email'];
  for (const env of [withReader(), withReader('paused'), withReader('on')]) {
    assert.equal(jobScope('commerce', env), null);
    assert.deepEqual(configuredJobScope('commerce', env), jobScope('commerce', withReader('active')), 'le profil lu pour les dates reste celui du lecteur actif');
    for (const job of jobs) assert.deepEqual(jobScope(job, env), jobScope(job, withReader('active')), `${job} ne dépend pas du réglage des ventes`);
  }
  assert.equal(jobScope('commerce', withReader('active'))?.namespace, 'ds-parcours');
});

const NOW = Date.parse('2026-07-06T09:30:00Z');
const STREAM: Record<string, [string, string]> = { notion: ['notion', 'prospects_business'], meta: ['meta', 'meta_account_daily'], wix: ['wix', 'payments_analytics'], receipts: ['wix', 'receipt_observations'], meta_ads: ['meta', 'ad_daily'], kpi_email: ['wix', 'kpi_wix_daily'], commerce: ['notion', 'commerce_declared_snapshot'] };
async function runTick(env: NodeJS.ProcessEnv) {
  const rows: Row[] = [], executed: SyncJob[] = [], selectedStreams: string[] = [];
  const db: Database = {
    select: async (_table, options) => { selectedStreams.push(String(options?.eq?.stream_key)); return rows.filter(row => ['source', 'stream_key', 'source_namespace'].every(key => options?.eq?.[key] === undefined || String(row[key]) === options.eq[key])); },
    upsert: async () => assert.fail('aucune écriture de planning'), rpc: async () => assert.fail('aucun RPC de planning'), probe: async () => {},
  };
  const summary = await tickSyncJobs(db, env, {
    now: () => NOW, budget: { sourceFetch: async () => new Response('{}'), canStart: () => true, dispose: () => {} },
    execute: async job => {
      executed.push(job);
      const [source, stream] = STREAM[job] ?? assert.fail(`unité inattendue ${job}`);
      rows.push({ source, source_namespace: jobScope(job, env)!.namespace, stream_key: stream, status: 'complete', pagination_complete: true, started_at: new Date(NOW).toISOString(), finished_at: new Date(NOW).toISOString() });
      return { status: 'complete' };
    },
  });
  return { summary, executed, selectedStreams };
}

test('tick : réglage absent ou paused, aucune unité commerce lue ni exécutée ; les autres unités sont inchangées', async () => {
  const active = await runTick(withReader('active'));
  assert.equal(active.executed.filter(job => job === 'commerce').length, 1, 'actif : comportement d’origine, une unité commerce');
  assert.ok(active.summary.streams?.some(stream => stream.job === 'commerce'));
  for (const env of [withReader(), withReader('paused')]) {
    const paused = await runTick(env);
    assert.ok(!paused.executed.includes('commerce'), 'aucune unité commerce exécutée');
    assert.ok(!paused.summary.jobs.includes('commerce') && !paused.summary.unitResults.some(unit => unit.job === 'commerce'));
    assert.ok(!paused.summary.streams?.some(stream => stream.job === 'commerce'), 'le flux commerce ne compte plus dans l’état du tick');
    assert.ok(!paused.selectedStreams.some(stream => COMMERCE_STREAMS.includes(stream)), 'le planning ne lit plus les flux commerce');
    assert.deepEqual(paused.executed, active.executed.filter(job => job !== 'commerce'), 'mêmes unités, même ordre pour les autres sources');
    assert.equal(paused.summary.status, 'complete');
  }
});

test('passage de contrôle : une seule unité bornée, même en pause, avec un code d’échec lisible', async () => {
  const calls: string[] = [], finishes: Row[] = [];
  const control = (mode: 'busy' | 'slow'): Database => ({
    select: async (table, options) => { calls.push(`select:${table}:${options?.eq?.stream_key ?? ''}`); if (mode === 'slow') throw new AppError('Le chargement des données a été interrompu. Réessaie.', 503, 'database_query_interrupted'); return []; },
    upsert: async () => assert.fail('aucune écriture attendue'),
    rpc: async <T>(name: string, args: Row): Promise<T> => {
      calls.push(`rpc:${name}:${args.p_stream ?? args.p_status ?? ''}`);
      if (name === 'begin_sync_stream') { if (mode === 'busy') throw new AppError('Une actualisation de cette source est déjà en cours.', 409, 'source_busy'); return 'run-control' as T; }
      if (name === 'finish_sync') { finishes.push(args); return true as T; }
      throw Error(name);
    },
    probe: async () => {},
  });
  let disposed = 0;
  const budget = () => ({ sourceFetch: async () => assert.fail('aucune requête Notion dans ce double'), canStart: () => true, dispose: () => { disposed++; } });
  const busy = await commerceControlPass(control('busy'), withReader(), { budget: budget() });
  assert.deepEqual(busy, { job: 'commerce', readerMode: 'paused', status: 'partial', counts: { pages: 0, read: 0 }, coverage: 'unavailable', reason: 'actualisation_en_cours' });
  assert.deepEqual(calls, ['rpc:begin_sync_stream:commerce_reader_checkpoint'], 'un passage = une ouverture de lecture');
  calls.length = 0;
  const slow = await commerceControlPass(control('slow'), withReader(), { budget: budget() });
  assert.deepEqual(slow, { job: 'commerce', readerMode: 'paused', status: 'failed', safeError: 'database_query_interrupted' });
  assert.deepEqual(calls, ['rpc:begin_sync_stream:commerce_reader_checkpoint', 'select:sync_runs:commerce_reader_checkpoint', 'rpc:finish_sync:failed'], 'échec persisté, aucune relance');
  assert.equal(finishes.at(-1)?.p_status, 'failed');
  assert.equal(disposed, 2, 'le budget est libéré après chaque passage');
  await assert.rejects(() => commerceControlPass(control('busy'), { ...withReader(), COCKPIT_MODE: 'demo' } as NodeJS.ProcessEnv, { budget: budget() }), (error: unknown) => error instanceof AppError && error.code === 'demo_mode');
  await assert.rejects(() => commerceControlPass(control('busy'), { ...withReader(), NOTION_COMMERCE_CONFIG: '' } as NodeJS.ProcessEnv, { budget: budget() }), (error: unknown) => error instanceof AppError && error.code === 'commerce_missing');
});

function connectionsDb(publishedAt: string, failedAt: string, observed: Row[] = []): Database {
  const minus = (iso: string, minutes: number) => new Date(Date.parse(iso) - minutes * 60_000).toISOString();
  return {
    probe: async () => {},
    rpc: async <T>(name: string): Promise<T> => { if (name === 'cockpit_connection_status') return { runs: [], firstParty: { eventAt: null, leadAt: null } } as T; throw Error(name); },
    upsert: async () => assert.fail('Connexions ne modifie aucune donnée'),
    select: async (table, options) => {
      assert.equal(table, 'sync_runs');
      const eq = options?.eq ?? {};
      if (eq.stream_key === 'commerce_declared_snapshot') { observed.push(eq); return [{ source: 'notion', stream_key: 'commerce_declared_snapshot', status: 'complete', pagination_complete: true, started_at: minus(publishedAt, 12), finished_at: publishedAt, period_to: minus(publishedAt, 14), rows_read: 42 }]; }
      if (eq.stream_key === 'commerce_reader_checkpoint' && eq.status === 'failed') return [{ source: 'notion', stream_key: 'commerce_reader_checkpoint', status: 'failed', pagination_complete: false, started_at: failedAt, finished_at: failedAt, rows_read: 0, error_code: 'database_query_interrupted' }];
      return [];
    },
  };
}
const commerceCard = (response: ConnectionsResponse) => response.connections.find(connection => connection.id === 'notion_commerce')!;
const commerceSection = (html: string) => html.split('<section').find(part => part.includes('Notion · ventes payées')) ?? '';

test('Connexions : lecture suspendue avec la vraie date de dernière publication complète, sans bouton de lecture', async () => {
  for (const [publishedAt, failedAt] of [['2026-06-10T08:15:00Z', '2026-06-11T06:05:00Z'], ['2026-05-03T17:40:00Z', '2026-05-04T21:20:00Z']]) {
    const observed: Row[] = [];
    const response = await connections(connectionsDb(publishedAt, failedAt, observed), withReader());
    const card = commerceCard(response);
    assert.equal(card.status, 'paused');
    assert.equal(card.lastSyncAt, new Date(publishedAt).toISOString(), 'date issue des lignes sync_runs, jamais une constante');
    assert.equal(card.lastAttemptAt, failedAt, 'la dernière tentative réelle reste visible');
    assert.match(card.summary, /^Lecture suspendue\./);
    assert.equal(card.canSync, false, 'aucun bouton de mise à jour en pause');
    assert.equal(observed[0].source_namespace, configuredJobScope('commerce', withReader())!.namespace);
    assert.equal(observed[0].query_profile_key, configuredJobScope('commerce', withReader())!.profile);
    const html = renderToStaticMarkup(createElement(Connections, { data: response, refresh: () => {}, announce: () => {} }));
    const section = commerceSection(html);
    assert.match(section, /Lecture suspendue/);
    assert.ok(section.includes(formatDate(card.lastSyncAt, true)), 'la carte affiche la date de la publication lue');
    assert.ok(!section.includes('Lire les données disponibles'), 'la carte n’offre pas de lecture');
    const active = await connections(connectionsDb(publishedAt, failedAt), withReader('active'));
    assert.equal(commerceCard(active).status, 'error', 'actif : l’échec réel reste visible comme avant');
    assert.equal(commerceCard(active).canSync, true);
    assert.equal(commerceCard(active).lastSyncAt, card.lastSyncAt);
    assert.ok(commerceSection(renderToStaticMarkup(createElement(Connections, { data: active, refresh: () => {}, announce: () => {} }))).includes('Lire les données disponibles'));
    assert.deepEqual(response.connections.filter(connection => connection.id !== 'notion_commerce'), active.connections.filter(connection => connection.id !== 'notion_commerce'), 'les autres connexions ne changent pas');
  }
});

test('Actualiser : la lecture des ventes n’est plus lancée quand Connexions la signale suspendue', () => {
  const filters: DashboardFilters = { from: '2026-06-01', to: '2026-06-30', source: 'all', tunnel: 'all', campaign: '', compare: false };
  const card = (status: ConnectionsResponse['connections'][number]['status']): ConnectionsResponse => ({ mode: 'live', connections: [{ id: 'notion_commerce', name: 'Notion · ventes payées', status, summary: '', lastSyncAt: null, coverage: '', limits: [], canSync: status !== 'paused' }] });
  assert.equal(commerceReaderPaused(card('paused')), true);
  for (const status of ['error', 'connected', 'partial', 'missing', 'demo'] as const) assert.equal(commerceReaderPaused(card(status)), false, status);
  assert.equal(commerceReaderPaused(null), false, 'état illisible : le serveur refuse lui-même une lecture suspendue');
  assert.deepEqual(resultsRefreshSources(filters, false), ['wix', 'notion', 'commerce', 'receipts', 'inscriptions', 'meta', 'quiz', 'masterclass']);
  assert.deepEqual(resultsRefreshSources(filters, true), ['wix', 'notion', 'receipts', 'inscriptions', 'meta', 'quiz', 'masterclass'], 'toutes les autres lectures restent lancées');
  assert.deepEqual(resultsRefreshSources({ ...filters, tunnel: 'quiz' }, true), ['wix', 'notion', 'receipts', 'inscriptions', 'meta', 'quiz']);
});
