import test from 'node:test';
import assert from 'node:assert/strict';
import { BLG_NOTION_FIELDS, BLG_NOTION_PROPERTY_IDS, BLG_NOTION_PROPERTY_TYPES, syncNotion, type CommercialField } from '../src/connectors/notion';
import { readNotionBusinessSchema } from '../src/connectors/notion-schema';
import { synchronizeNotionChunk } from '../src/lib/sync-notion-business';
import type { Database } from '../src/lib/db';
import { readNotionInventoryPage } from '../src/connectors/notion-inventory';

const id = '22222222-2222-4222-8222-222222222222';
const expression = (status: string) => `if(prop(${JSON.stringify(status)})=="Noshow",style("Noshow","b","red"),if(prop(${JSON.stringify(status)})=="Ancien client" OR prop(${JSON.stringify(status)})=="RDV Terminé" OR prop(${JSON.stringify(status)})=="Closé" OR prop(${JSON.stringify(status)})=="Perdu" OR prop(${JSON.stringify(status)})=="À relancer" OR prop(${JSON.stringify(status)})=="Plus de réponses" OR prop(${JSON.stringify(status)})=="Plus tard",style("Show up","b","green"),""))`;
function schema(status = 'Statut closing', formula = expression(status)) {
  return { id, properties: Object.fromEntries(Object.entries(BLG_NOTION_FIELDS).map(([key, label]) => [key === 'status' ? status : label, {
    id: BLG_NOTION_PROPERTY_IDS[key as CommercialField], type: BLG_NOTION_PROPERTY_TYPES[key as CommercialField][0],
    ...(key === 'attendanceGroup' ? { formula: { expression: formula } } : {}),
  }])) };
}
const read = (value = schema()) => readNotionBusinessSchema({ token: 'synthetic', dataSourceId: id, fetcher: async () => Response.json(value) });

function localTestEndpoint(raw: string): URL {
  let endpoint: URL;
  try { endpoint = new URL(raw); }
  catch { throw new Error('INVALID_TEST_DATABASE_ENDPOINT'); }
  // pg's connection-string query parameters can override the URL host/database.
  // Refuse all query/fragment inputs before constructing any database client.
  if (endpoint.search || endpoint.hash) throw new Error('TEST_DATABASE_URL_OPTIONS_FORBIDDEN');
  if (!['postgres:', 'postgresql:'].includes(endpoint.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new Error('LOCAL_TEST_DATABASE_REQUIRED');
  if (endpoint.pathname !== '/postgres') throw new Error('TEST_ADMIN_DATABASE_MUST_BE_POSTGRES');
  return endpoint;
}

test('local database guard rejects query-host overrides and fragments before any connection', () => {
  for (const raw of [
    'postgres://localhost:55440/postgres?host=remote.example.invalid',
    'postgresql://127.0.0.1:5432/postgres?database=other',
    'postgresql://localhost:5432/postgres#fragment',
  ]) {
    let clientConstructed = false;
    assert.throws(() => { localTestEndpoint(raw); clientConstructed = true; }, { message: 'TEST_DATABASE_URL_OPTIONS_FORBIDDEN' });
    assert.equal(clientConstructed, false);
  }
  assert.equal(localTestEndpoint('postgresql://localhost:5432/postgres').port, '5432');
  assert.equal(localTestEndpoint('postgres://127.0.0.1:55440/postgres').hostname, '127.0.0.1');
  assert.throws(() => localTestEndpoint('postgres://remote.example.invalid:5432/postgres'), { message: 'LOCAL_TEST_DATABASE_REQUIRED' });
  assert.throws(() => localTestEndpoint('postgres://localhost:5432/other'), { message: 'TEST_ADMIN_DATABASE_MUST_BE_POSTGRES' });
});

test('a renamed status has no Etat alias, keeps its reviewed ID and semantic proof, including string whitespace', async () => {
  const historical = await read(schema('Etat'));
  const renamedSchema = schema('Statut closing');
  assert.equal('Etat' in renamedSchema.properties, false, 'this is the original name-based failure trigger');
  const renamed = await read(renamedSchema);
  assert.equal(renamed.fields.status, BLG_NOTION_PROPERTY_IDS.status);
  assert.equal(renamed.proof.deltaSafe, true);
  assert.deepEqual(renamed.proof, historical.proof, 'a cosmetic rename cannot invalidate a running checkpoint');
  const renamedAgain = await read(schema('Closing du test'));
  assert.deepEqual(renamedAgain.proof, historical.proof);
  const compactedOutsideStrings = expression('Statut closing').replace(/ OR prop/g, 'ORprop');
  assert.deepEqual((await read(schema('Statut closing', compactedOutsideStrings))).proof, renamed.proof);
  const alteredValue = await read(schema('Statut closing', expression('Statut closing').replace('Show up', 'Showup')));
  assert.equal(alteredValue.proof.deltaSafe, false, 'source value changes cannot be normalized away');
  assert.notEqual(alteredValue.proof.digest, renamed.proof.digest);
});

test('missing or replaced ID, incompatible type and ambiguous ID fail before claim, staging or publication', async () => {
  const missing = schema(); delete missing.properties['Statut closing'];
  const replaced = schema(); replaced.properties['Statut closing'].id = 'replacement-property';
  const wrongType = schema(); wrongType.properties['Statut closing'].type = 'rich_text';
  const duplicate = schema(); duplicate.properties['Duplicate synthetic label'] = { ...duplicate.properties['Statut closing'] };
  for (const [value, code] of [[missing, 'SOURCE_PROPERTY_MISSING'], [replaced, 'SOURCE_PROPERTY_MISSING'], [wrongType, 'SOURCE_PROPERTY_TYPE_CHANGED'], [duplicate, 'SOURCE_PROPERTY_AMBIGUOUS']] as const) {
    let calls = 0;
    const db: Database = { rpc: async () => { calls++; assert.fail('invalid schema cannot claim/publish'); }, select: async () => [], upsert: async () => {}, probe: async () => {} };
    await assert.rejects(synchronizeNotionChunk({ db, env: { COCKPIT_MODE: 'live', NOTION_TOKEN: 'synthetic', NOTION_DATA_SOURCE_ID: id, IDENTITY_HMAC_SECRET: 'synthetic-key-at-least-32-characters' }, fetcher: async () => Response.json(value) }), { code });
    assert.equal(calls, 0);
  }
});

test('unknown, stale-name or other-page dependency formulas explicitly disable delta and reach claim as unsafe', async () => {
  const unsafe = ['now()', 'prop("Clients").map(current.prop("Etat"))', expression('Etat'), expression('Statut closing').replace('prop("Statut closing")', 'prop("E-mail")')];
  for (const formula of unsafe) {
    const value = schema('Statut closing', formula);
    const result = await read(value);
    assert.equal(result.proof.deltaSafe, false);
    let claimed = false;
    const db: Database = { rpc: async <T,>(name: string, args: Record<string, unknown>) => {
      assert.equal(name, 'cockpit_claim_notion'); assert.deepEqual(args.p_schema, result.proof);
      claimed = true; return { busy: true, runId: 'synthetic-occupied-run' } as T;
    }, select: async () => [], upsert: async () => {}, probe: async () => {} };
    await synchronizeNotionChunk({ db, env: { COCKPIT_MODE: 'live', NOTION_TOKEN: 'synthetic', NOTION_DATA_SOURCE_ID: id, IDENTITY_HMAC_SECRET: 'synthetic-key-at-least-32-characters' }, fetcher: async () => Response.json(value) });
    assert.equal(claimed, true);
  }
});

function row(statusLabel = 'Closing du test') {
  return { id, created_time: '2026-01-02T00:00:00Z', last_edited_time: '2026-01-03T00:00:00Z', properties: {
    'Nom synthétique': { id: 'title', type: 'title', title: [{ plain_text: 'Synthetic only' }] },
    [statusLabel]: { id: BLG_NOTION_PROPERTY_IDS.status, type: 'select', select: { name: 'RDV Programmé' } },
  } };
}
const base = { token: 'synthetic', dataSourceId: id, fields: { name: BLG_NOTION_PROPERTY_IDS.name, status: BLG_NOTION_PROPERTY_IDS.status }, mappingVersion: 'synthetic', from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' };
test('ID-based page projection survives row renames and pagination interruption/replay without completing early', async () => {
  let interrupted = true;
  const fetcher: typeof fetch = async (url, init) => {
    assert.deepEqual(new URL(String(url)).searchParams.getAll('filter_properties[]'), Object.values(base.fields));
    const body = JSON.parse(String(init?.body));
    if (body.start_cursor && interrupted) return Response.json({}, { status: 503 });
    return Response.json(body.start_cursor ? { results: [row()], has_more: false } : { results: [row()], has_more: true, next_cursor: 'synthetic-next' });
  };
  const initial = await syncNotion({ ...base, fetcher, sleep: async () => {} });
  assert.equal(initial.status, 'partial'); assert.equal(initial.coverage.complete, false);
  assert.deepEqual(initial.checkpoint, { cursor: 'synthetic-next' });
  interrupted = false;
  const resumed = await syncNotion({ ...base, fetcher, cursor: initial.checkpoint.cursor });
  assert.equal(resumed.status, 'complete'); assert.equal(resumed.records[0].status, 'RDV Programmé');
  const replay = await syncNotion({ ...base, fetcher });
  assert.equal(replay.status, 'complete'); assert.equal(replay.records.length, 1, 'replayed page identity is not counted twice');
});

test('a row with a missing, ambiguous or incompatible projected property cannot claim complete coverage', async () => {
  const missing = row(); delete (missing.properties as Record<string, unknown>)['Closing du test'];
  const wrongType = row(); wrongType.properties['Closing du test'].type = 'rich_text';
  const duplicate = row(); (duplicate.properties as Record<string, unknown>).extra = { ...duplicate.properties['Closing du test'] };
  for (const [value, code] of [[missing, 'SOURCE_PROPERTY_MISSING'], [wrongType, 'SOURCE_PROPERTY_TYPE_CHANGED'], [duplicate, 'SOURCE_PROPERTY_AMBIGUOUS']] as const) {
    const result = await syncNotion({ ...base, fetcher: async () => Response.json({ results: [value], has_more: false }) });
    assert.equal(result.coverage.complete, false); assert.equal(result.counts.rejected, 1);
    assert.equal(result.records.length, 0); assert.equal(result.safeError, code);
    assert.equal(result.checkpoint.completedThrough, undefined);
  }
});

test('encoded and decoded IDs preserve booking, acquisition, email identity and inventory dependencies end to end', async () => {
  const reviewed = await read();
  const mapped = { ...base, fields: reviewed.fields, identitySecret: 'synthetic-key-at-least-32-characters' };
  const properties = (decoded: boolean) => Object.fromEntries(Object.entries(schema().properties).map(([label, property]) => [label, {
    id: decoded ? decodeURIComponent(property.id) : property.id, type: property.type,
    ...(property.type === 'title' ? { title: [{ plain_text: 'Synthetic only' }] } :
      property.type === 'select' ? { select: { name: 'RDV Programmé' } } :
      property.type === 'date' ? { date: { start: label === BLG_NOTION_FIELDS.bookedAt ? '2026-01-05' : '2026-01-02' } } :
      property.type === 'email' ? { email: 'synthetic@example.test' } :
      property.type === 'relation' ? { relation: [{ id: '33333333-3333-4333-8333-333333333333' }], has_more: false } :
      property.type === 'created_time' ? { created_time: '2026-01-02T00:00:00Z' } :
      property.type === 'formula' ? { formula: { type: 'string', string: 'Show up' } } : { multi_select: [{ name: 'Synthetic' }] }),
  }]));
  const business = [];
  for (const decoded of [false, true]) {
    const value = { ...row(), properties: properties(decoded) };
    const result = await syncNotion({ ...mapped, fetcher: async () => Response.json({ results: [value], has_more: false }) });
    assert.equal(result.status, 'complete'); business.push(result.records[0].business);
    assert.equal(result.records[0].business?.dates.booked, '2026-01-05');
    assert.equal(result.records[0].business?.acquisitionDay, '2026-01-02');
    assert.equal(result.records[0].business?.identityBasis, 'email_hmac');
    const inventory = await readNotionInventoryPage({ ...mapped, fetcher: async () => Response.json({ results: [value], has_more: false }) });
    assert.equal(inventory.status, 'complete'); assert.equal(inventory.records[0].attendanceGroup, 'Show up');
    assert.deepEqual(inventory.records[0].clientIds, ['33333333-3333-4333-8333-333333333333']);
  }
  assert.deepEqual(business[0], business[1]);
  const decodedSchema = schema();
  for (const property of Object.values(decodedSchema.properties)) property.id = decodeURIComponent(property.id);
  assert.deepEqual((await read(decodedSchema)).proof, reviewed.proof);
});

// Opt-in integration: the same migration functions as production, a dedicated local
// synthetic database only. Ordinary unit runs need no PostgreSQL service.
test('real local claim keeps rename deltas, unknown formulas force full and an interrupted full never publishes', { skip: process.env.NOTION_SCHEMA_DB_TEST !== '1' }, async () => {
  const { Client } = await import('pg');
  const { readFileSync, readdirSync } = await import('node:fs');
  const endpoint = localTestEndpoint(process.env.TEST_DATABASE_URL || 'postgresql://localhost:55440/postgres');
  const dbName = `notion_contract_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  assert.match(dbName, /^notion_contract_\d+_\d+$/);
  const admin = new Client({ connectionString: endpoint.href });
  let created = false;
  let sql: InstanceType<typeof Client> | undefined;
  try {
    await admin.connect();
    assert.equal((await admin.query('SELECT current_database() AS name')).rows[0].name, 'postgres');
    await admin.query(`CREATE DATABASE ${dbName}`); created = true;
    const target = new URL(endpoint); target.pathname = `/${dbName}`;
    sql = new Client({ connectionString: target.href }); await sql.connect();
    assert.equal((await sql.query('SELECT current_database() AS name')).rows[0].name, dbName);
    for (const file of readdirSync('supabase/migrations').filter(name => /^\d{3}_.*\.sql$/.test(name)).sort()) await sql.query(readFileSync(`supabase/migrations/${file}`, 'utf8'));
    const db: Database = { select: async () => [], upsert: async () => assert.fail('RPC only'), probe: async () => {},
      rpc: async <T,>(name: string, args: Record<string, unknown>) => {
        assert.ok(['cockpit_claim_notion', 'cockpit_stage_notion', 'cockpit_publish_notion', 'cockpit_release_notion'].includes(name));
        const keys = Object.keys(args);
        return (await sql!.query(`SELECT public.${name}(${keys.map((key, index) => `${key}=>$${index + 1}`).join(',')}) AS value`, Object.values(args).map(value => value && typeof value === 'object' ? JSON.stringify(value) : value))).rows[0].value as T;
      } };
    let currentSchema = schema('Etat');
    const properties = () => Object.fromEntries(Object.entries(currentSchema.properties).map(([label, property]) => [label, {
      id: property.id, type: property.type,
      ...(property.type === 'title' ? { title: [{ plain_text: 'Synthetic only' }] } :
        property.type === 'select' ? { select: { name: 'RDV Programmé' } } :
        property.type === 'date' ? { date: null } :
        property.type === 'email' ? { email: null } :
        property.type === 'relation' ? { relation: [], has_more: false } :
        property.type === 'created_time' ? { created_time: '2026-01-02T00:00:00Z' } :
        property.type === 'formula' ? { formula: { type: 'string', string: '' } } : { multi_select: [] }),
    }]));
    let rows = [0, 1].map(index => ({ id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`, created_time: '2026-01-02T00:00:00Z', last_edited_time: '2026-01-03T00:00:00Z', properties: properties() }));
    let failNextPage = false;
    const timestamps: string[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      if (init?.method !== 'POST') return Response.json(currentSchema);
      const body = JSON.parse(String(init.body));
      if (failNextPage && body.start_cursor) return Response.json({}, { status: 503 });
      const stamp = body.filter.and[0].timestamp as 'created_time' | 'last_edited_time'; timestamps.push(stamp);
      const lower = Date.parse(body.filter.and[0][stamp].on_or_after), upper = Date.parse(body.filter.and[1][stamp].before);
      const filtered = rows.filter(value => Date.parse(value[stamp]) >= lower && Date.parse(value[stamp]) < upper);
      const offset = Number(body.start_cursor ?? 0), more = offset + 1 < filtered.length;
      const inventory = new URL(String(url)).searchParams.getAll('filter_properties[]').length === 2;
      return Response.json({ results: filtered.slice(offset, offset + 1).map(value => inventory ? { ...value, properties: Object.fromEntries(Object.entries(value.properties).filter(([, property]) => [BLG_NOTION_PROPERTY_IDS.clients, BLG_NOTION_PROPERTY_IDS.attendanceGroup].includes(property.id))) } : value), has_more: more, next_cursor: more ? String(offset + 1) : null });
    };
    const env = { COCKPIT_MODE: 'live', NOTION_TOKEN: 'synthetic', NOTION_DATA_SOURCE_ID: id, IDENTITY_HMAC_SECRET: 'synthetic-key-at-least-32-characters' };
    const tick = (maxPages = 1) => synchronizeNotionChunk({ db, env, fetcher, maxPages });
    const finish = async () => { for (let attempt = 0; attempt < 20; attempt++) { const result = await tick(); if (result.status !== 'partial') return result; } throw new Error('SYNTHETIC_TEST_DID_NOT_COMPLETE'); };
    const mirror = async () => (await sql!.query('SELECT external_id,source_status,sync_run_id FROM prospects ORDER BY external_id')).rows;
    const run = async (runId: string) => (await sql!.query('SELECT checkpoint,period_to,error_code,lease_until>now() AS busy FROM sync_runs WHERE id=$1', [runId])).rows[0];
    const first = await finish(); assert.equal(first.status, 'complete'); assert.equal(first.coverage.mode, 'full');
    const firstRun = await run(first.runId); const unchanged = await mirror();
    currentSchema = schema('Statut closing');
    rows = rows.map(value => ({ ...value, properties: properties(), last_edited_time: new Date(Date.parse(firstRun.period_to) - 30000).toISOString() }));
    timestamps.length = 0;
    const renamed = await finish(); assert.equal(renamed.coverage.mode, 'delta');
    assert.equal((await run(renamed.runId)).checkpoint.schemaDigest, firstRun.checkpoint.schemaDigest);
    assert.ok(timestamps.includes('last_edited_time'));
    assert.equal((await mirror()).length, unchanged.length);
    const beforeFull = await mirror();
    currentSchema = schema('Statut closing', 'now()');
    timestamps.length = 0;
    const started = await tick(); assert.equal(started.status, 'partial');
    assert.equal((await run(started.runId)).checkpoint.mode, 'full', 'real SQL claim must choose full on unsafe proof');
    await tick(); failNextPage = true;
    await assert.rejects(tick()); assert.deepEqual(await mirror(), beforeFull, 'failed full preserves published mirror');
    const interrupted = await run(started.runId);
    assert.equal(interrupted.busy, false, '503 must release its lease without artificially expiring it');
    assert.equal(interrupted.error_code, 'UPSTREAM_HTTP_ERROR_HTTP_503');
    failNextPage = false;
    const recovered = await finish(); assert.equal(recovered.status, 'complete'); assert.equal(recovered.coverage.mode, 'full');
    assert.ok(timestamps.every(stamp => stamp === 'created_time'));
    assert.equal((await mirror()).length, 2);
  } finally {
    await sql?.end();
    if (created) await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  }
});
