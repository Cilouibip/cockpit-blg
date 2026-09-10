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

test('une requête pendue s’arrête au délai choisi et renvoie un message lisible', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    await assert.rejects(request('/api/commercial', { timeoutMs: 5 }), (e: unknown) => e instanceof CockpitRequestError && e.status === 0 && /pris trop de temps/.test(e.message));
  } finally { globalThis.fetch = original; }
});

test('une annulation demandée par l’écran reste une annulation utilisateur', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  try {
    globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    const pending = request('/api/commercial', { signal: controller.signal, timeoutMs: 1_000 });
    controller.abort();
    await assert.rejects(pending, (e: unknown) => e instanceof DOMException && e.name === 'AbortError');
  } finally { globalThis.fetch = original; }
});

test('un retour HTML en erreur garde son statut et un JSON invalide est expliqué', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('<html>Erreur</html>', { status: 500, headers: { 'Content-Type': 'text/html' } });
    await assert.rejects(request('/api/commercial'), (e: unknown) => e instanceof CockpitRequestError && e.status === 500 && /lecture n’a pas abouti/.test(e.message));
    globalThis.fetch = async () => new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(request('/api/commercial'), (e: unknown) => e instanceof CockpitRequestError && e.status === 200 && /réponse du serveur est illisible/.test(e.message));
  } finally { globalThis.fetch = original; }
});
