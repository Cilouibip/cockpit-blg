import test from 'node:test';
import assert from 'node:assert/strict';
import { notionFullHours, synchronizeNotionChunk } from '../src/lib/sync-notion-business';
import { BLG_NOTION_FIELDS } from '../src/connectors/notion';
import type { Database, Row } from '../src/lib/db';

// Migration 023 · réglage BLG_NOTION_FULL_HOURS : lecture du réglage et transmission avec la preuve de schéma à la réclamation.
test('BLG_NOTION_FULL_HOURS : absent ou vide = aucune fenêtre (règle 021) ; « 2-4 » = [2, 4] ; formes invalides refusées explicitement', () => {
  assert.equal(notionFullHours({}), null);assert.equal(notionFullHours({ BLG_NOTION_FULL_HOURS: '' }), null);assert.equal(notionFullHours({ BLG_NOTION_FULL_HOURS: '  ' }), null);
  assert.deepEqual(notionFullHours({ BLG_NOTION_FULL_HOURS: '2-4' }), [2, 4]);assert.deepEqual(notionFullHours({ BLG_NOTION_FULL_HOURS: ' 02-04 ' }), [2, 4]);
  assert.deepEqual(notionFullHours({ BLG_NOTION_FULL_HOURS: '3-3' }), [3, 3]);assert.deepEqual(notionFullHours({ BLG_NOTION_FULL_HOURS: '0-23' }), [0, 23]);
  for (const bad of ['4-2', '2', '2-24', 'nuit', '2:00-4:00', '-1-4', '2-4-6']) assert.throws(() => notionFullHours({ BLG_NOTION_FULL_HOURS: bad }), { code: 'notion_full_hours_invalid' }, bad);
});

test('la réclamation Notion porte la fenêtre avec la preuve de schéma quand le réglage est posé, rien de plus sinon', async () => {
  const calls: Row[] = [];
  const db: Database = { select: async () => [], upsert: async () => {}, probe: async () => {}, rpc: async <T,>(name: string, args: Row) => { calls.push({ name, ...args });return { busy: true, runId: 'occupied' } as T; } };
  const base = { COCKPIT_MODE: 'live', NOTION_TOKEN: 's', NOTION_DATA_SOURCE_ID: 'ds', IDENTITY_HMAC_SECRET: 'x'.repeat(32) };
  const proof = { digest: 'a'.repeat(64), deltaSafe: true }, schemaReader = async () => ({ proof, fields: BLG_NOTION_FIELDS });
  await synchronizeNotionChunk({ db, env: base, schemaReader, fetcher: async () => assert.fail('aucun appel réseau') });
  assert.deepEqual(calls.at(-1)?.p_schema, proof, 'sans réglage : preuve inchangée (règle 021)');
  await synchronizeNotionChunk({ db, env: { ...base, BLG_NOTION_FULL_HOURS: '2-4' }, schemaReader, fetcher: async () => assert.fail('aucun appel réseau') });
  assert.deepEqual(calls.at(-1)?.p_schema, { ...proof, fullHours: [2, 4] });
  await assert.rejects(synchronizeNotionChunk({ db, env: { ...base, BLG_NOTION_FULL_HOURS: '4-2' }, schemaReader, fetcher: async () => assert.fail('aucun appel réseau') }), { code: 'notion_full_hours_invalid' });
  assert.equal(calls.length, 2, 'réglage invalide : aucune réclamation');
});
