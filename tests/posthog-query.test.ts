import test from 'node:test';
import assert from 'node:assert/strict';
import { readPostHogQuery } from '../src/connectors/posthog-query';

const config = () => ({ endpoint: new URL('https://eu.posthog.com'), projectId: '123', headers: { Authorization: 'Bearer synthetic-secret' }, query: 'SELECT 1', name: 'synthetic', deadline: Date.now() + 55_000, signal: new AbortController().signal, sleep: async () => {} });
test('une requête acceptée est relue jusqu’au résultat complet imbriqué', async () => {
  const calls: string[] = [];
  const result = { columns: ['alive'], results: [[1]], hasMore: false };
  const output = await readPostHogQuery({ ...config(), fetcher: async (url, init) => {
    calls.push(String(url));
    if (init?.method === 'POST') {
      assert.equal(JSON.parse(String(init.body)).refresh, 'force_async');
      return Response.json({ query_status: { id: 'query-1', team_id: 123, complete: false } }, { status: 202 });
    }
    return Response.json({ query_status: { id: 'query-1', team_id: 123, complete: calls.length > 2, ...(calls.length > 2 ? { results: result } : {}) } });
  } });
  assert.deepEqual(output, result);
  assert.deepEqual(calls, ['https://eu.posthog.com/api/projects/123/query/', 'https://eu.posthog.com/api/projects/123/query/query-1/', 'https://eu.posthog.com/api/projects/123/query/query-1/']);
});
test('un résultat immédiat reste compatible avec les mêmes contrôles en aval', async () => {
  const result = { columns: ['alive'], results: [[1]] };
  assert.deepEqual(await readPostHogQuery({ ...config(), fetcher: async () => Response.json(result) }), result);
});
test('les identifiants inattendus et erreurs amont ne deviennent jamais des résultats partiels', async () => {
  for (const [status, code] of [
    [{ id: '../../other', complete: false }, 'INVALID_POSTHOG_QUERY_ID'],
    [{ id: 'ok', team_id: 456, complete: false }, 'PROJECT_IDENTITY_MISMATCH'],
    [{ id: 'ok', error: true, error_message: 'sensitive response body', complete: true }, 'POSTHOG_QUERY_FAILED'],
    [{ id: 'ok', complete: true, results: { error: 'sensitive', results: [] } }, 'INVALID_POSTHOG_RESPONSE'],
  ] as const) {
    let calls = 0;
    await assert.rejects(readPostHogQuery({ ...config(), fetcher: async () => { calls++; return Response.json({ query_status: status }); } }), { message: code });
    assert.equal(calls, 1);
  }
});
test('une requête qui reste en attente respecte son budget au lieu de publier des données vides', async () => {
  let now = 0, calls = 0;
  await assert.rejects(readPostHogQuery({ ...config(), deadline: 3_000, clock: () => now, sleep: async ms => { now += ms; }, fetcher: async () => {
    calls++; return Response.json({ query_status: { id: 'pending', complete: false } }, { status: 202 });
  } }), { message: 'POSTHOG_TIME_BUDGET' });
  assert.equal(calls, 2);
});
test('l’annulation d’une autre lecture interrompt la récupération en cours', async () => {
  const controller = new AbortController();
  const pending = readPostHogQuery({ ...config(), signal: controller.signal, fetcher: async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }) });
  controller.abort();
  await assert.rejects(pending, { message: 'NETWORK_ERROR' });
});

test('une interruption transitoire au lancement et à la récupération est reprise une seule fois', async () => {
  let posts = 0, gets = 0;
  const result = { columns: ['alive'], results: [[1]] };
  const output = await readPostHogQuery({ ...config(), fetcher: async (_url, init) => {
    if (init?.method === 'POST') {
      if (++posts === 1) throw new TypeError('fetch failed');
      return Response.json({ query_status: { id: 'query-1', complete: false } }, { status: 202 });
    }
    if (++gets === 1) return Response.json({}, { status: 503 });
    return Response.json({ query_status: { id: 'query-1', complete: true, results: result } });
  } });
  assert.deepEqual(output, result);
  assert.deepEqual({ posts, gets }, { posts: 2, gets: 2 });
});

test('un refus d’accès ne réessaie pas et une panne réseau persistante reste bornée', async () => {
  for (const status of [403, 503]) {
    let calls = 0;
    await assert.rejects(readPostHogQuery({ ...config(), fetcher: async () => { calls++; return Response.json({}, { status }); } }));
    assert.equal(calls, status === 403 ? 1 : 2);
  }
});
