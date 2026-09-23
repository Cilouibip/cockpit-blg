import test from 'node:test';
import assert from 'node:assert/strict';
import { tickSyncJobs } from '../src/lib/sync-jobs';

// Chemin de production : la route appelle tickSyncJobs() sans base ; le bail partagé en base doit alors être pris.
// Base Supabase doublée par un fetch synthétique : aucune requête réseau, aucune donnée réelle.
type Handler = (path: string, body: Record<string, unknown> | null) => Response;
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
    return handler(path, init?.body ? JSON.parse(String(init.body)) : null);
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
    if (path.startsWith('sync_runs')) return json([]);
    return assert.fail('requête inattendue ' + path);
  };
  const summary = await tickSyncJobs(undefined, process.env, options(executed));
  assert.deepEqual(summary.lock, { kind: 'shared', leaseSeconds: 90 }); assert.ok(executed.length >= 1 && executed.every(job => job === 'notion'), 'unités exécutées sous le bail');
  assert.equal(requests[0], 'rpc/cockpit_claim_tick'); assert.equal(requests.at(-1), 'rpc/cockpit_release_tick');
  assert.equal(holders.length, 2); assert.equal(holders[0], holders[1], 'libéré par le même détenteur'); assert.match(String(holders[0]), /^[0-9a-f-]{36}$/);
});

test('route du tick (base par défaut) : fonction inconnue de PostgREST (PGRST202), passage « process-only » signalé', async () => {
  requests.length = 0;const executed: string[] = [];
  handler = path => path === 'rpc/cockpit_claim_tick' ? json({ code: 'PGRST202', message: 'Could not find the function' }, 404) : path.startsWith('sync_runs') ? json([]) : assert.fail('requête inattendue ' + path);
  const summary = await tickSyncJobs(undefined, process.env, options(executed));
  assert.equal(summary.lock?.kind, 'process-only'); assert.ok(executed.length >= 1 && executed.every(job => job === 'notion'), 'passage exécuté malgré la fonction absente');
  assert.ok(!requests.includes('rpc/cockpit_release_tick'), 'aucune libération d’un bail jamais pris');
});

test('route du tick (base par défaut) : base injoignable pendant la réclamation, erreur 503 remontée, aucune lecture', async () => {
  requests.length = 0;const executed: string[] = [];
  handler = path => path === 'rpc/cockpit_claim_tick' ? json({ code: 'PGRST003' }, 503) : assert.fail('aucune lecture après un échec du bail : ' + path);
  await assert.rejects(tickSyncJobs(undefined, process.env, options(executed)), (error: { status?: number }) => error.status === 503);
  assert.deepEqual(requests, ['rpc/cockpit_claim_tick']); assert.deepEqual(executed, []);
});
