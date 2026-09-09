import test from 'node:test';
import assert from 'node:assert/strict';
import { request, CockpitRequestError } from '../src/lib/cockpit-request';

test('les retours de lecture gardent session expirée, conflit précis et interruption réseau', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{}', {status:401});
    await assert.rejects(request('/api/commercial'), (e:unknown) => e instanceof CockpitRequestError && e.status===401 && /session a expiré/.test(e.message));
    globalThis.fetch = async () => new Response(JSON.stringify({error:'Une actualisation de cette source est déjà en cours.'}), {status:409});
    await assert.rejects(request('/api/sync/notion'), /actualisation de cette source/);
    globalThis.fetch = async () => {throw new TypeError('Failed to fetch');};
    await assert.rejects(request('/api/links'), /connexion a été interrompue/);
  } finally { globalThis.fetch = original; }
});
