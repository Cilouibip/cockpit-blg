import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { issueSession, passwordHash, COOKIE_NAME } from '../src/lib/auth';
import { getConfig } from '../src/lib/config';

// Base Supabase et Notion doublées : aucune requête réseau, aucune donnée réelle.
test('pause du lecteur des ventes : refus des appels directs, passage de contrôle réservé au bearer', async () => {
  const previous = { ...process.env }, originalFetch = globalThis.fetch;
  for (const key of Object.keys(process.env)) if (/^(NOTION_|WIX_|META_|POSTHOG_|VERCEL|DATABASE_URL|BLG_COMMERCE_READER)/.test(key)) delete process.env[key];
  const secret = 'synthetic-cron-secret-for-route-32-characters';
  Object.assign(process.env, {
    COCKPIT_MODE: 'live', APP_ORIGIN: 'http://127.0.0.1:3192', COCKPIT_SESSION_SECRET: 'synthetic-session-secret-with-32-characters', COCKPIT_PASSWORD_HASH: passwordHash('synthetic-only'),
    CRON_SECRET: secret, SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_SECRET_KEY: 'synthetic-secret', IDENTITY_HMAC_SECRET: 'synthetic-identity-secret-with-32-characters',
    NOTION_TOKEN: 'synthetic', NOTION_COMMERCE_CONFIG: JSON.stringify({ clients: { dataSourceId: 'ds-clients' }, payments: { dataSourceId: 'ds-payments' }, schedule: { dataSourceId: 'ds-schedule' }, parcours: { dataSourceId: 'ds-parcours' } }),
  });
  const calls: string[] = [];
  let begin: 'open' | 'busy' = 'open';
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== 'synthetic.supabase.co') assert.fail('requête externe inattendue ' + url.hostname);
    const body = JSON.parse(String(init?.body ?? 'null'));
    if (url.pathname.endsWith('/rpc/begin_sync_stream')) { calls.push('begin:' + body.p_stream); return begin === 'busy' ? response({ code: '55P03' }, 409) : response(randomUUID()); }
    if (url.pathname.endsWith('/rpc/finish_sync')) { calls.push('finish:' + body.p_status); return response(true); }
    // Symptôme observé : la recherche du point de reprise dépasse le délai de la base.
    if (url.pathname.endsWith('/sync_runs') && url.searchParams.get('stream_key') === 'eq.commerce_reader_checkpoint') { calls.push('checkpoint'); return response({ code: '57014' }, 500); }
    if (url.pathname.endsWith('/sync_runs')) { calls.push('sync_runs:' + url.searchParams.get('stream_key')); return response([]); }
    assert.fail('requête Supabase inattendue ' + url.pathname);
  }) as typeof fetch;
  try {
    const { GET, POST } = await import('../src/app/api/[...path]/route');
    const config = getConfig(), session = { Cookie: `${COOKIE_NAME}=${issueSession(config)}`, Origin: config.origin };
    const direct = () => POST(new Request(config.origin + '/api/sync/commerce', { method: 'POST', headers: session }));
    const control = (authorization?: string) => GET(new Request(config.origin + '/api/jobs/commerce', authorization ? { headers: { Authorization: authorization } } : {}));

    const refused = await direct();
    assert.equal(refused.status, 423);
    assert.deepEqual(await refused.json(), { error: 'La lecture des ventes est suspendue.', code: 'commerce_paused' });
    process.env.BLG_COMMERCE_READER = 'paused';
    assert.equal((await direct()).status, 423, 'valeur explicite paused');
    assert.equal(calls.length, 0, 'aucune lecture ouverte par un appel direct en pause');

    assert.equal((await control()).status, 401, 'sans bearer');
    assert.equal((await control('Bearer ' + 'x'.repeat(secret.length))).status, 401, 'mauvais bearer');
    const session401 = await GET(new Request(config.origin + '/api/jobs/commerce', { headers: session }));
    assert.equal(session401.status, 401, 'une session de l’interface ne suffit pas');
    assert.equal(calls.length, 0);

    const failed = await control('Bearer ' + secret);
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { job: 'commerce', readerMode: 'paused', status: 'failed', safeError: 'database_query_interrupted' });
    assert.deepEqual(calls, ['begin:commerce_reader_checkpoint', 'checkpoint', 'finish:failed'], 'un seul passage borné, échec persisté');

    calls.length = 0; begin = 'busy';
    const busy = await control('Bearer ' + secret);
    assert.equal(busy.status, 207);
    assert.equal((await busy.json()).reason, 'actualisation_en_cours');
    assert.deepEqual(calls, ['begin:commerce_reader_checkpoint']);
    assert.equal((await control('Bearer ' + secret)).status, 429, 'deux passages de contrôle par minute au plus');

    calls.length = 0;
    const tick = await GET(new Request(config.origin + '/api/jobs/tick', { headers: { Authorization: 'Bearer ' + secret } }));
    assert.equal(tick.status, 200);
    const summary = await tick.json();
    assert.ok(!summary.jobs.includes('commerce') && !summary.streams.some((stream: { job: string }) => stream.job === 'commerce'), 'le tick ignore le lecteur suspendu');
    assert.ok(!calls.some(call => call.includes('commerce')), 'aucune lecture commerce dans le tick');

    process.env.BLG_COMMERCE_READER = 'active';
    calls.length = 0;
    const restored = await direct();
    assert.equal(restored.status, 207, 'actif : la lecture directe est de nouveau acceptée');
    assert.deepEqual(calls, ['begin:commerce_reader_checkpoint']);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
