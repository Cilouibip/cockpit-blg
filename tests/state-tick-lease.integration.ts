import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { postgresDatabase } from '../src/lib/db';
import { databaseTickLease } from '../src/lib/sync-jobs';

// PostgreSQL jetable local uniquement. Bail partagé de niveau passage (migration 017).
const base = new URL(process.env.TEST_DATABASE_URL || 'postgresql://localhost:55440/postgres');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw Error('LOCAL_ONLY');
const stamp = Date.now(), name = 'tick_lease_' + stamp, legacy = 'tick_lease_legacy_' + stamp;
const admin = new Client({ connectionString: base.href });
const url = (database: string) => { const target = new URL(base); target.pathname = '/' + database; return target.href; };
const migrations = fs.readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).sort();
let a: Client, b: Client;
before(async () => {
  await admin.connect();
  for (const database of [name, legacy]) await admin.query(`CREATE DATABASE ${database}`);
  const setup = new Client({ connectionString: url(name) });await setup.connect();
  for (const file of migrations) await setup.query(fs.readFileSync('supabase/migrations/' + file, 'utf8'));
  await setup.end();
  // Base « avant la migration 017 » : tout sauf 017 et suivantes.
  const old = new Client({ connectionString: url(legacy) });await old.connect();
  for (const file of migrations.filter(f => Number(f.slice(0, 3)) < 17)) await old.query(fs.readFileSync('supabase/migrations/' + file, 'utf8'));
  await old.end();
  a = new Client({ connectionString: url(name) });b = new Client({ connectionString: url(name) });await a.connect();await b.connect();
});
// Les pools de db.ts ferment leurs connexions inactives après 5 s : on les laisse se fermer avant de supprimer les bases.
after(async () => { await a?.end();await b?.end();await new Promise(resolve => setTimeout(resolve, 5500));for (const database of [name, legacy]) await admin.query(`DROP DATABASE IF EXISTS ${database}`);await admin.end(); });
const claim = (client: Client, holder: string, seconds = 90) => client.query('SELECT public.cockpit_claim_tick($1,$2) AS ok', [holder, seconds]).then(r => r.rows[0].ok as boolean);
const release = (client: Client, holder: string) => client.query('SELECT public.cockpit_release_tick($1) AS ok', [holder]).then(r => r.rows[0].ok as boolean);
const reset = () => a.query("UPDATE public.cockpit_tick_lease SET holder=NULL, lease_until='-infinity'");

test('deux réclamations concurrentes : une seule réussit, la seconde attend le verrou de ligne puis échoue', async () => {
  await reset();const first = randomUUID(), second = randomUUID();
  await a.query('BEGIN');assert.equal(await claim(a, first), true);
  const pending = claim(b, second);let settled = false;void pending.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(settled, false, 'la seconde réclamation est sérialisée derrière la première');
  await a.query('COMMIT');
  assert.equal(await pending, false, 'elle relit le bail posé par la première et échoue');
  const rows = await Promise.all([claim(a, randomUUID()), claim(b, randomUUID())]);
  assert.deepEqual(rows, [false, false], 'bail actif : aucun autre détenteur');
  assert.equal(await claim(a, first), true, 'le détenteur peut réaffirmer son bail');
  assert.equal((await a.query('SELECT holder FROM public.cockpit_tick_lease')).rows[0].holder, first);
});

test('bail expiré (passage interrompu) repris par un autre détenteur ; libération par un mauvais détenteur refusée', async () => {
  await reset();const crashed = randomUUID(), next = randomUUID();
  assert.equal(await claim(a, crashed, 30), true);
  assert.equal(await claim(b, next), false);
  // Le passage interrompu ne libère jamais : on avance son échéance au passé (équivalent de 90 s écoulées).
  await a.query("UPDATE public.cockpit_tick_lease SET lease_until=clock_timestamp()-interval '1 second'");
  assert.equal(await claim(b, next), true, 'bail expiré repris sans intervention');
  assert.equal(await release(a, crashed), false, 'l’ancien détenteur ne peut pas libérer le bail d’un autre');
  assert.equal((await a.query('SELECT holder FROM public.cockpit_tick_lease')).rows[0].holder, next);
  assert.equal(await release(b, next), true);
  assert.equal(await claim(a, randomUUID()), true, 'libéré : réclamable immédiatement');
});

test('durée bornée de 30 à 300 s et détenteur obligatoire', async () => {
  await reset();
  for (const seconds of [0, 29, 301, null]) await assert.rejects(a.query('SELECT public.cockpit_claim_tick($1,$2)', [randomUUID(), seconds]), { code: '23514' });
  await assert.rejects(a.query('SELECT public.cockpit_claim_tick(NULL,90)'), { code: '23514' });
});

test('droits : anon et authenticated sans exécution ni lecture ; service_role seul', async () => {
  const rows = (await a.query(`SELECT p.proname,
    has_function_privilege('anon',p.oid,'execute') AS anon, has_function_privilege('authenticated',p.oid,'execute') AS auth,
    has_function_privilege('service_role',p.oid,'execute') AS service, p.prosecdef
    FROM pg_proc p WHERE p.proname IN ('cockpit_claim_tick','cockpit_release_tick') ORDER BY 1`)).rows;
  assert.equal(rows.length, 2);
  for (const row of rows) { assert.equal(row.anon, false);assert.equal(row.auth, false);assert.equal(row.service, true);assert.equal(row.prosecdef, false); }
  const table = (await a.query("SELECT has_table_privilege('anon','public.cockpit_tick_lease','SELECT') AS anon, has_table_privilege('authenticated','public.cockpit_tick_lease','UPDATE') AS auth, has_table_privilege('service_role','public.cockpit_tick_lease','UPDATE') AS service")).rows[0];
  assert.deepEqual(table, { anon: false, auth: false, service: true });
});

test('migration 017 rejouable : aucune erreur, une seule inscription, bail en cours conservé', async () => {
  await reset();const holder = randomUUID();assert.equal(await claim(a, holder), true);
  await a.query(fs.readFileSync('supabase/migrations/017_cockpit_tick_lease.sql', 'utf8'));
  assert.equal((await a.query('SELECT count(*)::int AS n FROM public.cockpit_migrations WHERE version=17')).rows[0].n, 1);
  assert.equal((await a.query('SELECT count(*)::int AS n FROM public.cockpit_tick_lease')).rows[0].n, 1);
  assert.equal((await a.query('SELECT holder FROM public.cockpit_tick_lease')).rows[0].holder, holder);
});

test('par db.ts : bail pris et rendu ; base sans migration 017 = « fonction absente » identifiée (42883 → schema_missing)', async () => {
  await reset();
  const db = postgresDatabase(url(name)), old = postgresDatabase(url(legacy));
  const first = await databaseTickLease(db).claim();assert.equal(first.state, 'acquired');
  assert.equal((await databaseTickLease(db).claim()).state, 'refused');
  if (first.state === 'acquired') await first.release();
  assert.equal((await a.query('SELECT holder FROM public.cockpit_tick_lease')).rows[0].holder, null);
  const missing = await databaseTickLease(old).claim();
  assert.equal(missing.state, 'missing');
});
