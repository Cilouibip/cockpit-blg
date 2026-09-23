import test from 'node:test';
import assert from 'node:assert/strict';
import { CADENCE_DEGRADED_REASON, chooseSyncJob, databaseTickLease, jobScope, PILOT_REFRESH_JOBS, refreshCadenceMinutes, refreshCadences, syncStreamStates, tickSyncJobs, type SharedTickLease, type SyncJob } from '../src/lib/sync-jobs';
import { AppError } from '../src/lib/errors';
import type { Database, Row } from '../src/lib/db';

// Horloge simulée, données synthétiques : aucun identifiant ni chiffre réel.
const MIN = 60_000;
const T0 = Date.parse('2026-09-23T10:00:07Z'); // départ d'unité typique : quelques secondes après un déclenchement à 10:00
const STREAM: Record<SyncJob, [string, string]> = {
  notion: ['notion', 'prospects_business'], meta: ['meta', 'meta_account_daily'], wix: ['wix', 'payments_analytics'], receipts: ['wix', 'receipt_observations'],
  meta_ads: ['meta', 'ad_daily'], meta_catalog: ['meta', 'ad_catalog'], quiz: ['posthog', 'quiz_observations'], masterclass: ['posthog', 'masterclass_observations'],
  forms: ['wix', 'lead_entries_forms'], quiz_entries: ['wix', 'lead_entries_quiz'], client_history: ['notion', 'lead_entries_client_history'],
  kpi_meta: ['meta', 'kpi_meta_daily'], kpi_posthog: ['posthog', 'kpi_posthog_daily'], kpi_email: ['wix', 'kpi_wix_daily'], commerce: ['notion', 'commerce_declared_snapshot'],
};
const ALL = Object.keys(STREAM) as SyncJob[];
const PILOT: SyncJob[] = ['meta_ads', 'masterclass', 'forms', 'kpi_meta', 'kpi_posthog', 'kpi_email'];
const done = (job: SyncJob, at: number): Row => ({ id: `${job}-${at}`, source: STREAM[job][0], source_namespace: STREAM[job][0], stream_key: STREAM[job][1], status: 'complete', pagination_complete: true, started_at: new Date(at).toISOString(), finished_at: new Date(at + 5000).toISOString() });
const env = (value?: string) => (value === undefined ? {} : { BLG_REFRESH_CADENCE_MINUTES: value }) as NodeJS.ProcessEnv;

test('réglage : absent, vide ou invalide = 60 minutes (défaut de transition) ; 30 explicite active la demi-heure ; jamais sous 30', () => {
  assert.equal(refreshCadenceMinutes({}), 60, 'réglage absent = 60');
  for (const value of ['', '60', ' 60\n', '15', '5', '0', '-30', '45', 'abc', '30min', '60min', '3 0']) assert.equal(refreshCadenceMinutes(env(value)), 60, `« ${value} » = 60`);
  assert.equal(refreshCadenceMinutes(env('30')), 30, 'activation explicite');
  assert.equal(refreshCadenceMinutes(env(' 30\n')), 30, 'un retour à la ligne copié avec la valeur ne change pas son sens');
  assert.deepEqual([...PILOT_REFRESH_JOBS].sort(), [...PILOT].sort(), 'flux Masterclass bornés : publicités par jour, PostHog Masterclass, formulaires Wix, trois KPI quotidiens');
  const fast = refreshCadences(env('30')), slow = refreshCadences({});
  for (const job of ALL) {
    assert.equal(fast[job], PILOT.includes(job) ? 30 * MIN : 60 * MIN, `${job} : cadence activée à 30`);
    assert.equal(slow[job], 60 * MIN, `${job} : réglage absent = comportement antérieur`);
    assert.equal(refreshCadences(env('60'))[job], 60 * MIN, `${job} : 60 explicite = comportement antérieur`);
  }
  assert.equal(fast.notion, 60 * MIN, 'l’inventaire Notion complet n’est jamais relu plus souvent qu’aujourd’hui');
  assert.equal(fast.meta_catalog, 60 * MIN, 'le catalogue Meta complet n’est jamais relu plus souvent qu’aujourd’hui');
});

test('horloge simulée : à 30 activé, les flux Masterclass sont dus à 30 minutes, les autres à 60, depuis le début de la tentative précédente', () => {
  for (const job of ALL) {
    const rows = [done(job, T0)], due = (minutes: number, settings = env('30')) => chooseSyncJob(rows, T0 + minutes * MIN, [job], refreshCadences(settings)) === job;
    assert.equal(due(1), false, `${job} reste à jour juste après sa publication`);
    assert.equal(due(29), false, `${job} n’est pas dû avant 30 minutes`);
    assert.equal(due(30), PILOT.includes(job), `${job} : dû à 30 minutes seulement s’il conditionne le pilotage Masterclass`);
    assert.equal(due(59), PILOT.includes(job), `${job} : un flux horaire reste à jour pendant son heure`);
    assert.equal(due(60), true, `${job} est dû à une heure`);
    assert.equal(due(30, env('60')), false, `${job} : avec le réglage 60, rien ne change par rapport à aujourd’hui`);
    assert.equal(due(30, env()), false, `${job} : réglage absent = défaut de transition 60, rien ne change`);
    assert.equal(due(60, env()), true, `${job} : réglage absent, dû à une heure`);
  }
});

test('un déclenchement toutes les 5 minutes ne fait pas dériver la cadence : passage au créneau suivant de 30 minutes', () => {
  // Sans la règle de créneau, une unité partie à 10:00:07 ne serait due qu’à 10:30:07 et manquerait le déclenchement de 10:30:00 :
  // la publication suivante glisserait à 10:35, puis 11:10... (35 minutes par cycle).
  const cadences = refreshCadences(env('30')), rows = [done('forms', T0)];
  const at = (clock: string) => Date.parse(`2026-09-23T${clock}Z`);
  assert.equal(chooseSyncJob(rows, at('10:25:00'), ['forms'], cadences), null);
  assert.equal(chooseSyncJob(rows, at('10:30:00'), ['forms'], cadences), 'forms', 'dû au premier déclenchement du créneau suivant');
  // Au plus un départ par créneau : reparti à 10:30:05, le flux reste à jour jusqu’au créneau de 11:00.
  const next = [done('forms', at('10:30:05'))];
  for (const clock of ['10:35:00', '10:45:00', '10:55:00', '10:59:59']) assert.equal(chooseSyncJob(next, at(clock), ['forms'], cadences), null, `à jour à ${clock}`);
  assert.equal(chooseSyncJob(next, at('11:00:00'), ['forms'], cadences), 'forms');
  // Délai minimal entre deux travaux d’un même flux : un départ tardif dans son créneau (10:26) est dû au créneau suivant (10:30),
  // soit un intervalle de déclenchement. C’est la même règle qu’aujourd’hui pour l’heure (départ à 10:56, dû à 11:00).
  assert.equal(chooseSyncJob([done('forms', at('10:26:00'))], at('10:30:00'), ['forms'], cadences), 'forms');
  assert.equal(chooseSyncJob([done('notion', at('10:56:00'))], at('11:00:00'), ['notion'], cadences), 'notion');
  assert.equal(chooseSyncJob([done('notion', at('10:56:00'))], at('10:59:00'), ['notion'], cadences), null);
});

test('la fraîcheur affichée suit la même cadence : une publication de plus de 30 minutes d’un flux Masterclass est ancienne', () => {
  const rows = [done('kpi_meta', T0), done('notion', T0)];
  const [kpi, notion] = syncStreamStates(rows, T0 + 31 * MIN, ['notion', 'kpi_meta'], refreshCadences(env('30'))).sort((a, b) => a.job.localeCompare(b.job));
  assert.equal(kpi.job, 'kpi_meta'); assert.equal(kpi.stale, true); assert.equal(kpi.state, 'due');
  assert.equal(notion.job, 'notion'); assert.equal(notion.stale, false); assert.equal(notion.state, 'complete');
});

// Toutes les lectures configurées, lecteur des ventes en pause (réglage absent) : 14 flux planifiables. Cadence 30 activée explicitement.
const liveEnv = {
  COCKPIT_MODE: 'live', BLG_REFRESH_CADENCE_MINUTES: '30', NOTION_DATA_SOURCE_ID: 'notion', NOTION_TOKEN: 'synthetic', NOTION_CLIENT_DATA_SOURCE_ID: 'clients', META_AD_ACCOUNT_ID: 'meta', META_ACCESS_TOKEN: 'synthetic',
  WIX_SITE_ID: 'wix', WIX_API_KEY: 'synthetic', IDENTITY_HMAC_SECRET: 'x'.repeat(32), POSTHOG_PROJECT_ID: '123', POSTHOG_PERSONAL_API_KEY: 'synthetic',
  WIX_LEAD_ENTRY_CONFIG: JSON.stringify({ formIds: ['form-1'], quiz: { collectionId: 'Quiz', originFields: { ad: 'publicite' } } }),
} as unknown as NodeJS.ProcessEnv;
const scoped = (job: SyncJob, at: number): Row => { const scope = jobScope(job, liveEnv)!; return { ...done(job, at), source_namespace: scope.namespace, query_profile_key: scope.profile }; };
/** Bail partagé détenu (double) : seule configuration où la demi-heure s'applique. */
const heldLease: SharedTickLease = { claim: async () => ({ state: 'acquired', release: async () => undefined }) };
function readOnlyDatabase(rows: Row[], calls: string[]): Database {
  return {
    select: async (table, options) => { calls.push(`select:${table}`); return rows.filter(row => Object.entries(options?.eq ?? {}).every(([key, value]) => String(row[key]) === value) && Object.entries(options?.in ?? {}).every(([key, values]) => values.includes(String(row[key])))); },
    upsert: async () => { calls.push('upsert'); assert.fail('aucune écriture quand rien n’est dû'); },
    // Seul appel autre que le journal : le nettoyage borné de la zone de préparation (migration 019), une fois par passage.
    rpc: async name => { calls.push(`rpc:${name}`); if (name === 'cockpit_cleanup_staged') return { source_aggregates: 0, ad_daily: 0, meta_conversions_daily: 0, lead_source_observations: 0 } as never; assert.fail('aucune réclamation quand rien n’est dû'); },
    probe: async () => {},
  };
}

test('tick sans travail : aucun appel source, aucune écriture métier, une seule lecture bornée du journal et un nettoyage borné, réponse complete immédiate', async () => {
  const enabled = ALL.filter(job => jobScope(job, liveEnv));
  assert.equal(enabled.length, 14, 'toutes les lectures sauf le lecteur des ventes suspendu');
  const at = Date.parse('2026-09-23T10:10:00Z'), rows = enabled.map(job => scoped(job, Date.parse('2026-09-23T10:00:05Z'))), calls: string[] = [];
  let sourceCalls = 0, executed = 0;
  const started = performance.now();
  const summary = await tickSyncJobs(readOnlyDatabase(rows, calls), liveEnv, {
    now: () => at, sharedLease: heldLease,
    budget: { sourceFetch: async () => { sourceCalls++; return new Response('{}'); }, canStart: () => true, dispose: () => {} },
    execute: async () => { executed++; return { status: 'complete' }; },
  });
  const elapsed = performance.now() - started;
  assert.equal(summary.status, 'complete'); assert.equal(summary.units, 0); assert.deepEqual(summary.unitResults, []);
  assert.equal(executed, 0); assert.equal(sourceCalls, 0, 'aucun appel Meta, PostHog, Wix ou Notion');
  assert.deepEqual(calls.filter(call => call !== 'select:sync_runs'), ['rpc:cockpit_cleanup_staged'], 'seuls le journal et le nettoyage borné sont appelés');
  assert.equal(calls.at(-1), 'rpc:cockpit_cleanup_staged', 'nettoyage après la lecture du journal');
  assert.equal(calls.length, 2 * enabled.length + 1, 'deux lectures du journal par flux, en parallèle, une seule fois ; un nettoyage');
  assert.equal(summary.schedulerMeasurements?.dbReads, 2 * enabled.length);
  assert.ok(summary.streams?.every(stream => stream.state === 'complete' && !stream.stale));
  assert.deepEqual(summary.cadence, { pilotMinutes: 30, pilotJobs: [...PILOT_REFRESH_JOBS], otherMinutes: 60 });
  assert.deepEqual(summary.cleanup, { deleted: { source_aggregates: 0, ad_daily: 0, meta_conversions_daily: 0, lead_source_observations: 0 } });
  assert.ok(elapsed < 1000, `aucune attente dans le passage lui-même (${Math.round(elapsed)} ms avec une base en mémoire)`);
});

test('tick sans travail entre deux créneaux : un flux Masterclass publié il y a 25 minutes n’est pas relu', async () => {
  const at = Date.parse('2026-09-23T10:25:00Z'), rows = ALL.filter(job => jobScope(job, liveEnv)).map(job => scoped(job, Date.parse('2026-09-23T10:00:05Z'))), calls: string[] = [];
  const summary = await tickSyncJobs(readOnlyDatabase(rows, calls), liveEnv, { now: () => at, sharedLease: heldLease, budget: { sourceFetch: async () => assert.fail('aucune lecture source'), canStart: () => true, dispose: () => {} }, execute: async () => assert.fail('rien n’est dû') });
  assert.equal(summary.status, 'complete'); assert.equal(summary.units, 0);
});

test('tick : sans réglage, la réponse annonce le défaut de transition 60 ; 30 seulement sur activation explicite', async () => {
  const { BLG_REFRESH_CADENCE_MINUTES: _unset, ...transitionEnv } = liveEnv;
  const at = Date.parse('2026-09-23T10:40:00Z'), rows = ALL.filter(job => jobScope(job, transitionEnv as NodeJS.ProcessEnv)).map(job => scoped(job, Date.parse('2026-09-23T10:00:05Z'))), calls: string[] = [];
  const summary = await tickSyncJobs(readOnlyDatabase(rows, calls), transitionEnv as NodeJS.ProcessEnv, { now: () => at, budget: { sourceFetch: async () => assert.fail('aucune lecture source'), canStart: () => true, dispose: () => {} }, execute: async () => assert.fail('rien n’est dû à 40 minutes avec la cadence horaire') });
  assert.deepEqual(summary.cadence, { pilotMinutes: 60, pilotJobs: [...PILOT_REFRESH_JOBS], otherMinutes: 60 });
  assert.equal(summary.status, 'complete'); assert.equal(summary.units, 0);
});

// Garde de la demi-heure (réserve Codex 3) : 30 n'est effectif que sous bail partagé détenu ; sinon 60, signalé.
// Journal : tous les flux publiés à 10:00:05 ; passage à 10:40 : à 30, les six flux Masterclass sont dus ; à 60, aucun.
async function passAt40(settings: NodeJS.ProcessEnv, sharedLease?: SharedTickLease | null) {
  const at = Date.parse('2026-09-23T10:40:00Z'), rows = ALL.filter(job => jobScope(job, settings)).map(job => ({ ...done(job, Date.parse('2026-09-23T10:00:05Z')), source_namespace: jobScope(job, settings)!.namespace, query_profile_key: jobScope(job, settings)!.profile })), calls: string[] = [], executed: SyncJob[] = [];
  const summary = await tickSyncJobs(readOnlyDatabase(rows, calls), settings, { now: () => at, ...(sharedLease !== undefined ? { sharedLease } : {}), budget: { sourceFetch: async () => assert.fail('aucune lecture source'), canStart: () => true, dispose: () => {} }, execute: async job => { executed.push(job); return { status: 'complete' }; } });
  return { summary, executed };
}
test('garde de cadence : réglage 30 et bail partagé détenu, la demi-heure s’applique (flux Masterclass relus à 40 minutes)', async () => {
  const { summary, executed } = await passAt40(liveEnv, heldLease);
  assert.deepEqual(summary.lock, { kind: 'shared', leaseSeconds: 90 });
  assert.deepEqual(summary.cadence, { pilotMinutes: 30, pilotJobs: [...PILOT_REFRESH_JOBS], otherMinutes: 60 });
  assert.deepEqual([...new Set(executed)].sort(), [...PILOT].sort(), 'les six flux Masterclass, et eux seuls');
  assert.ok(summary.streams?.every(stream => stream.stale === PILOT.includes(stream.job)), 'fraîcheur calculée à 30 pour les flux Masterclass, 60 pour les autres');
});
test('garde de cadence : réglage 30, base injectée sans bail partagé, cadence 60 appliquée et signalée', async () => {
  const { summary, executed } = await passAt40(liveEnv);
  assert.equal(summary.lock?.kind, 'process-only');
  assert.deepEqual(summary.cadence, { pilotMinutes: 60, requestedMinutes: 30, degradedReason: CADENCE_DEGRADED_REASON, pilotJobs: [...PILOT_REFRESH_JOBS], otherMinutes: 60 });
  assert.match(CADENCE_DEGRADED_REASON, /Bail partagé indisponible : cadence de transition 60 min appliquée/);
  assert.deepEqual(executed, [], 'aucun flux Masterclass relu avant l’heure');
  assert.ok(summary.streams?.every(stream => stream.state === 'complete' && !stream.stale), 'états calculés à 60');
  assert.equal(summary.status, 'complete');
});
test('garde de cadence : réglage 30, fonction du bail absente (schema_missing), cadence 60 appliquée et signalée', async () => {
  const missing: Database = { select: async () => [], upsert: async () => assert.fail('aucune écriture'), rpc: async () => { throw new AppError('Les tables du cockpit doivent être installées.', 503, 'schema_missing'); }, probe: async () => {} };
  const { summary, executed } = await passAt40(liveEnv, databaseTickLease(missing));
  assert.equal(summary.lock?.kind, 'process-only'); assert.match(String((summary.lock as { reason: string }).reason), /migration 017/);
  assert.deepEqual(summary.cadence, { pilotMinutes: 60, requestedMinutes: 30, degradedReason: CADENCE_DEGRADED_REASON, pilotJobs: [...PILOT_REFRESH_JOBS], otherMinutes: 60 });
  assert.deepEqual(executed, []);
});
test('garde de cadence : réglage 60 ou absent, rien ne change avec ou sans bail (aucune cadence demandée signalée)', async () => {
  const { BLG_REFRESH_CADENCE_MINUTES: _unset, ...absent } = liveEnv;
  for (const settings of [{ ...liveEnv, BLG_REFRESH_CADENCE_MINUTES: '60' }, absent] as NodeJS.ProcessEnv[]) for (const lease of [heldLease, undefined]) {
    const { summary, executed } = await passAt40(settings, lease);
    assert.deepEqual(summary.cadence, { pilotMinutes: 60, pilotJobs: [...PILOT_REFRESH_JOBS], otherMinutes: 60 });
    assert.deepEqual(executed, []);
  }
});
