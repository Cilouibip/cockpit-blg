import test from 'node:test';
import assert from 'node:assert/strict';
import { CADENCE_DEGRADED_REASON, jobScope, PILOT_REFRESH_JOBS, tickSyncJobs, type SyncJob } from '../src/lib/sync-jobs';

// Chemin de production : la route appelle tickSyncJobs() sans base ; le bail partagé en base doit alors être pris.
// Base Supabase doublée par un fetch synthétique : aucune requête réseau, aucune donnée réelle.
type Handler = (path: string, body: Record<string, unknown> | null, query: URLSearchParams) => Response;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
let handler: Handler = () => assert.fail('aucune requête attendue');
const requests: string[] = [];
const originalFetch = globalThis.fetch, previous = { ...process.env };
test.before(() => {
  for (const key of Object.keys(process.env)) if (/^(NOTION_|WIX_|META_|POSTHOG_|VERCEL|DATABASE_URL|BLG_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { COCKPIT_MODE: 'live', APP_ORIGIN: 'http://127.0.0.1:3193', SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_SECRET_KEY: 'synthetic-secret', NOTION_DATA_SOURCE_ID: 'synthetic-notion' });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== 'synthetic.supabase.co') assert.fail('requête externe inattendue ' + url.hostname);
    const path = url.pathname.replace('/rest/v1/', '');requests.push(path);
    return handler(path, init?.body ? JSON.parse(String(init.body)) : null, url.searchParams);
  }) as typeof fetch;
});
test.after(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
});
const options = (executed: string[]) => ({ now: () => Date.parse('2026-09-23T10:00:00Z'), budget: { sourceFetch: async () => assert.fail('aucune lecture source'), canStart: () => true, dispose: () => {} }, execute: async (job: string) => { executed.push(job); return { status: 'complete' }; } });

test('route du tick (base par défaut) : bail refusé, une seule requête, réponse waiting', async () => {
  requests.length = 0;const executed: string[] = [];
  handler = path => path === 'rpc/cockpit_claim_tick' ? json(false) : assert.fail('rien d’autre que la réclamation : ' + path);
  const summary = await tickSyncJobs(undefined, process.env, options(executed));
  assert.equal(summary.status, 'waiting'); assert.deepEqual(requests, ['rpc/cockpit_claim_tick']); assert.deepEqual(executed, []);
});

test('route du tick (base par défaut) : bail pris pour 90 s, passage exécuté, bail rendu par son détenteur', async () => {
  requests.length = 0;const executed: string[] = [], holders: unknown[] = [];
  handler = (path, body) => {
    if (path === 'rpc/cockpit_claim_tick') { holders.push(body?.p_holder); assert.equal(body?.p_seconds, 90); return json(true); }
    if (path === 'rpc/cockpit_release_tick') { holders.push(body?.p_holder); return json(true); }
    if (path === 'rpc/cockpit_cleanup_staged') { assert.equal(body?.p_limit, 5000); return json({ source_aggregates: 2, ad_daily: 1, meta_conversions_daily: 0, lead_source_observations: 3 }); }
    if (path.startsWith('sync_runs')) return json([]);
    return assert.fail('requête inattendue ' + path);
  };
  const summary = await tickSyncJobs(undefined, process.env, options(executed));
  assert.deepEqual(summary.lock, { kind: 'shared', leaseSeconds: 90 }); assert.ok(executed.length >= 1 && executed.every(job => job === 'notion'), 'unités exécutées sous le bail');
  assert.equal(requests[0], 'rpc/cockpit_claim_tick'); assert.equal(requests.at(-1), 'rpc/cockpit_release_tick');
  assert.equal(requests.at(-2), 'rpc/cockpit_cleanup_staged', 'nettoyage borné une fois, sous le bail, avant la réponse');
  assert.equal(requests.filter(path => path === 'rpc/cockpit_cleanup_staged').length, 1);
  assert.deepEqual(summary.cleanup, { deleted: { source_aggregates: 2, ad_daily: 1, meta_conversions_daily: 0, lead_source_observations: 3 } });
  assert.equal(holders.length, 2); assert.equal(holders[0], holders[1], 'libéré par le même détenteur'); assert.match(String(holders[0]), /^[0-9a-f-]{36}$/);
});

test('route du tick (base par défaut) : fonction inconnue de PostgREST (PGRST202), passage « process-only » signalé', async () => {
  requests.length = 0;const executed: string[] = [];
  handler = path => path === 'rpc/cockpit_claim_tick' || path === 'rpc/cockpit_cleanup_staged' ? json({ code: 'PGRST202', message: 'Could not find the function' }, 404) : path.startsWith('sync_runs') ? json([]) : assert.fail('requête inattendue ' + path);
  const summary = await tickSyncJobs(undefined, process.env, options(executed));
  assert.equal(summary.lock?.kind, 'process-only');
  assert.equal((summary.cleanup as { error?: string }).error, 'schema_missing', 'base sans 017 ni 019 : nettoyage absent signalé, passage exécuté'); assert.ok(executed.length >= 1 && executed.every(job => job === 'notion'), 'passage exécuté malgré la fonction absente');
  assert.ok(!requests.includes('rpc/cockpit_release_tick'), 'aucune libération d’un bail jamais pris');
});

test('route du tick (base par défaut) : base injoignable pendant la réclamation, erreur 503 remontée, aucune lecture', async () => {
  requests.length = 0;const executed: string[] = [];
  handler = path => path === 'rpc/cockpit_claim_tick' ? json({ code: 'PGRST003' }, 503) : assert.fail('aucune lecture après un échec du bail : ' + path);
  await assert.rejects(tickSyncJobs(undefined, process.env, options(executed)), (error: { status?: number }) => error.status === 503);
  assert.deepEqual(requests, ['rpc/cockpit_claim_tick']); assert.deepEqual(executed, []);
});

// Garde de la demi-heure sur le chemin réel de la route (réserve Codex 3) : réglage 30, publicités par jour (flux Masterclass)
// et deux flux horaires publiés à 10:00:05 ; passage à 10:40. À 30, seul ad_daily est dû ; à 60, rien.
const STREAMS: Partial<Record<SyncJob, string>> = { notion: 'prospects_business', meta: 'meta_account_daily', meta_ads: 'ad_daily' };
const at40 = (executed: string[]) => ({ ...options(executed), now: () => Date.parse('2026-09-23T10:40:00Z') });
function journal(settings: NodeJS.ProcessEnv, query: URLSearchParams) {
  const stream = query.get('stream_key')?.replace(/^eq\./, '');
  const job = (Object.keys(STREAMS) as SyncJob[]).find(key => STREAMS[key] === stream);
  if (!job) return json([]);
  const scope = jobScope(job, settings)!;
  return json([{ id: `seed-${job}`, source: job === 'notion' ? 'notion' : 'meta', source_namespace: scope.namespace, stream_key: stream, query_profile_key: scope.profile, status: 'complete', pagination_complete: true, rows_rejected: 0, started_at: '2026-09-23T10:00:05.000Z', finished_at: '2026-09-23T10:00:10.000Z', source_as_of: '2026-09-23T10:00:05.000Z', period_to: '2026-09-23T10:00:05.000Z' }]);
}
test('route du tick (base par défaut) : réglage 30 et bail pris, la demi-heure s’applique', async () => {
  requests.length = 0;const executed: string[] = [], settings = { ...process.env, BLG_REFRESH_CADENCE_MINUTES: '30', META_AD_ACCOUNT_ID: 'synthetic-meta' } as NodeJS.ProcessEnv;
  handler = (path, _body, query) => path === 'rpc/cockpit_claim_tick' || path === 'rpc/cockpit_release_tick' ? json(true) : path === 'rpc/cockpit_cleanup_staged' ? json({ source_aggregates: 0, ad_daily: 0, meta_conversions_daily: 0, lead_source_observations: 0 }) : path.startsWith('sync_runs') ? journal(settings, query) : assert.fail('requête inattendue ' + path);
  const summary = await tickSyncJobs(undefined, settings, at40(executed));
  assert.deepEqual(summary.lock, { kind: 'shared', leaseSeconds: 90 });
  assert.deepEqual(summary.cadence, { pilotMinutes: 30, pilotJobs: [...PILOT_REFRESH_JOBS], otherMinutes: 60 });
  assert.deepEqual(executed, ['meta_ads'], 'seul le flux Masterclass publié il y a 40 minutes est relu');
});
test('route du tick (base par défaut) : réglage 30 et fonction du bail inconnue (PGRST202), cadence 60 appliquée et signalée', async () => {
  requests.length = 0;const executed: string[] = [], settings = { ...process.env, BLG_REFRESH_CADENCE_MINUTES: '30', META_AD_ACCOUNT_ID: 'synthetic-meta' } as NodeJS.ProcessEnv;
  handler = (path, _body, query) => path === 'rpc/cockpit_claim_tick' ? json({ code: 'PGRST202', message: 'Could not find the function' }, 404) : path === 'rpc/cockpit_cleanup_staged' ? json({ source_aggregates: 0, ad_daily: 0, meta_conversions_daily: 0, lead_source_observations: 0 }) : path.startsWith('sync_runs') ? journal(settings, query) : assert.fail('requête inattendue ' + path);
  const summary = await tickSyncJobs(undefined, settings, at40(executed));
  assert.equal(summary.lock?.kind, 'process-only');
  assert.deepEqual(summary.cadence, { pilotMinutes: 60, requestedMinutes: 30, degradedReason: CADENCE_DEGRADED_REASON, pilotJobs: [...PILOT_REFRESH_JOBS], otherMinutes: 60 });
  assert.deepEqual(executed, [], 'aucun flux relu avant l’heure : la demi-heure n’est pas appliquée sans bail');
  assert.equal(summary.streams?.find(stream => stream.job === 'meta_ads')?.stale, false, 'fraîcheur calculée à 60');
});
