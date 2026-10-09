import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from 'pg';
import { postgresDatabase, type Database, type Row } from '../src/lib/db';
import { readKpiMeta } from '../src/connectors/kpi-meta';
import { syncKpiSource, readKpiSource, readKpiWindows, KPI_PROFILE, type KpiSourceBatch } from '../src/lib/kpi-source-store';

// Disposable PostgreSQL, loopback only, synthetic data; no environment file or live source.
const base = new URL(process.env.TEST_DATABASE_URL || 'postgresql://localhost:55440/postgres');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw Error('LOCAL_ONLY');
const name = 'aggregate_payload_confirmation_' + Date.now(), target = new URL(base);target.pathname = '/' + name;
const admin = new Client({ connectionString: base.href });let sql: Client, db: Database;
const migration = 'supabase/migrations/025_aggregate_payload_confirmation.sql';
const from = '2026-09-10', to = '2026-09-11', namespace = 'synthetic-confirmation';
before(async () => {
 await admin.connect();await admin.query(`CREATE DATABASE ${name}`);
 sql = new Client({ connectionString: target.href });await sql.connect();
 for (const file of fs.readdirSync('supabase/migrations').filter(f => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0,3)) <= 28 && Number(f.slice(0,3)) !== 25).sort()) await sql.query(fs.readFileSync('supabase/migrations/' + file, 'utf8'));
 await sql.query(fs.readFileSync(migration, 'utf8'));
 // UPDATE OF proves the unchanged branch does not even target the payload columns.
 // A plain value-equality trigger could miss redundant assignments of equal values.
 await sql.query(`CREATE TABLE payload_assignments(id uuid, metric text);
 CREATE FUNCTION audit_payload_assignment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO payload_assignments VALUES(NEW.id,NEW.metric_key);RETURN NEW;END $$;
 CREATE TRIGGER payload_assignment AFTER UPDATE OF dimensions,value,timezone,coverage_state,unit,currency,currency_exponent,tax_basis,definition_version,source_locator
 ON source_aggregates FOR EACH ROW EXECUTE FUNCTION audit_payload_assignment();`);
 db = postgresDatabase(target.href);
});
after(async () => { await sql?.end();await new Promise(resolve => setTimeout(resolve,5500));await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end(); });
const one = async (q: string, params: unknown[] = []) => (await sql.query(q,params)).rows[0];
const rows = async () => (await sql.query('SELECT * FROM source_aggregates WHERE source_namespace=$1 AND is_current ORDER BY metric_key,dimensions_key',[namespace])).rows;
const clearAudit = () => sql.query('TRUNCATE payload_assignments');
const assignments = async () => (await sql.query('SELECT metric,count(*)::int AS n FROM payload_assignments GROUP BY metric ORDER BY metric')).rows;
const state = async (run: string) => (await one("SELECT checkpoint->'state' AS s FROM sync_runs WHERE id=$1",[run])).s;
const publish = (batch: KpiSourceBatch) => syncKpiSource(db,'meta',namespace,from,to,async () => batch);
const read = () => readKpiSource(db,'meta',namespace,from,to);
const mockMeta: typeof fetch = async input => {
 const url = new URL(String(input));
 return new Response(JSON.stringify(url.pathname.endsWith('/insights') ? { data: [{ account_id:'999',campaign_id:'123',date_start:from,date_stop:from,spend:'10.00',impressions:'100',inline_link_clicks:'3',unique_inline_link_clicks:'2',actions:[] }] } : {account_id:'999',currency:'EUR',timezone_name:'Europe/Paris'}),{status:200});
};
let batch: KpiSourceBatch, firstIds: string[];

test('real KPI connector shape: changed observation updates manifest, identical daily content targets only run', async () => {
 batch = await readKpiMeta(from,to,{NODE_ENV:'test',META_AD_ACCOUNT_ID:'999',META_ACCESS_TOKEN:'synthetic',BLG_KPI_META_UNIQUE_READS:'off'},mockMeta);
 assert.equal(batch.rows.length,1);assert.equal('observedAt' in batch.rows[0].data,false);
 const first = await publish(batch);const previous = await read();firstIds = (await rows()).map(r => r.id);
 await clearAudit();
 const later = {...batch,observedAt:new Date(Date.parse(batch.observedAt)+60_000).toISOString()};
 const second = await publish(later), current = await read();
 assert.deepEqual((await rows()).map(r => r.id),firstIds);
 assert.deepEqual(current.days.get(from)?.rows,previous.days.get(from)?.rows);
 assert.equal(current.days.get(from)?.runId,second.runId);
 assert.equal(current.days.get(from)?.observedAt,later.observedAt);
 assert.deepEqual(await assignments(),[{metric:'kpi_daily_manifest',n:1}]);
 const s = await state(second.runId);assert.equal(s.confirmed,1);assert.equal(s.changed,1);assert.equal(s.inserted,0);
 assert.ok((await rows()).every(r => r.sync_run_id === second.runId));
 assert.notEqual(first.runId,second.runId);batch=later;
});

test('same observed payload confirms every row, consuming staging; lost acknowledgement retry is idempotent', async () => {
 await clearAudit();const result = await publish(batch);
 assert.deepEqual(await assignments(),[]);assert.equal((await state(result.runId)).confirmed,2);
 assert.deepEqual((await rows()).map(r => r.id),firstIds);
 assert.equal((await one('SELECT count(*)::int AS n FROM source_aggregates WHERE sync_run_id=$1 AND NOT is_current',[result.runId])).n,0);
 const before = await rows();
 const ack = await db.rpc<Row>('cockpit_publish_aggregate_state',{p_run:result.runId,p_metric_keys:'{kpi_daily_row,kpi_daily_manifest}',p_read:batch.rows.length});
 assert.equal(ack.duplicate,true);assert.deepEqual(await rows(),before);assert.deepEqual(await assignments(),[]);
});

test('changed values use same IDs and update payload; whole-window manifests still match new run', async () => {
 await clearAudit();
 const changed = {...batch, rows:batch.rows.map(row => ({...row,data:{...row.data,impressions:101}}))};
 const result = await publish(changed), current=await read();
 assert.deepEqual((await rows()).map(r => r.id),firstIds);
 assert.equal(current.days.get(from)?.rows[0].data.impressions,101);
 assert.equal((await state(result.runId)).changed,2);
 assert.deepEqual(await assignments(),[{metric:'kpi_daily_manifest',n:1},{metric:'kpi_daily_row',n:1}]);batch=changed;
 const window={from,to,key:'123',data:{reach:42,unique_link_clicks:3}};
 await publish({...batch,windows:[window]});await clearAudit();
 const later={...batch,observedAt:new Date(Date.parse(batch.observedAt)+60_000).toISOString(),windows:[window]};
 const next=await publish(later), windows=await readKpiWindows(db,'meta',namespace);
 assert.equal(windows.size,1);assert.deepEqual([...windows.values()][0].data,window.data);assert.equal([...windows.values()][0].runId,next.runId);
 assert.deepEqual(await assignments(),[{metric:'kpi_daily_manifest',n:1},{metric:'kpi_window_manifest',n:1}]);batch=later;
});

test('failure inside publication rolls back confirmations, changes and staging deletion atomically', async () => {
 const before=await rows();await clearAudit();
 await sql.query(`CREATE FUNCTION reject_synthetic_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.is_current AND NEW.dimensions->'data'->>'impressions'='9999' THEN RAISE EXCEPTION 'synthetic publication failure';END IF;RETURN NEW;END $$;
 CREATE TRIGGER reject_change BEFORE UPDATE OF dimensions ON source_aggregates FOR EACH ROW EXECUTE FUNCTION reject_synthetic_change();`);
 const broken={...batch,rows:batch.rows.map(row=>({...row,data:{...row.data,impressions:9999}}))};
 await assert.rejects(publish(broken));
 assert.deepEqual(await rows(),before);assert.deepEqual(await assignments(),[]);
 const current=await read();assert.equal(current.days.get(from)?.rows[0].data.impressions,101);
 await sql.query('DROP TRIGGER reject_change ON source_aggregates');
 const recovered=await publish(batch);assert.equal(recovered.status,'complete');assert.deepEqual((await rows()).map(r=>r.id),before.map(r=>r.id));
});

test('disappeared objects are retained; reappearance reuses the same ID and preserves reader consistency', async () => {
 const old=await one("SELECT id FROM source_aggregates WHERE source_namespace=$1 AND is_current AND metric_key='kpi_daily_row'",[namespace]);
 await publish({...batch,rows:[]});
 assert.equal((await one('SELECT is_current FROM source_aggregates WHERE id=$1',[old.id])).is_current,false);
 assert.deepEqual((await read()).days.get(from)?.rows,[]);
 await clearAudit();const again=await publish(batch);
 assert.deepEqual(await assignments(),[{metric:'kpi_daily_manifest',n:1}]);
 const revived=await one('SELECT id,is_current,sync_run_id FROM source_aggregates WHERE id=$1',[old.id]);
 assert.equal(revived.is_current,true);assert.equal(revived.sync_run_id,again.runId);
 assert.equal((await state(again.runId)).reappeared,1);
 assert.equal((await one("SELECT count(*)::int AS n FROM source_aggregates a JOIN sync_runs r ON r.id=a.sync_run_id WHERE a.source_namespace=$1 AND a.metric_key='kpi_daily_row' AND r.status IN ('complete','empty')",[namespace])).n,1);
 assert.equal((await read()).days.get(from)?.rows[0].data.impressions,101);
});

test('changed reappearance updates payload; order, null and scalar types are not confirmations', async () => {
 const old=await one("SELECT id FROM source_aggregates WHERE source_namespace=$1 AND is_current AND metric_key='kpi_daily_row'",[namespace]);
 await publish({...batch,rows:[]});await clearAudit();
 const changed={...batch,rows:batch.rows.map(row=>({...row,data:{...row.data,impressions:102,exact:[null,1,'1',1]}}))};
 const revived=await publish(changed);
 assert.equal((await state(revived.runId)).reappeared,1);
 assert.deepEqual(await assignments(),[{metric:'kpi_daily_manifest',n:1},{metric:'kpi_daily_row',n:1}]);
 assert.equal((await one('SELECT is_current FROM source_aggregates WHERE id=$1',[old.id])).is_current,true);
 for(const exact of [[1,null,'1',1],[1,null,1,'1'],[1,1,'1']]){
  await clearAudit();const next={...changed,rows:changed.rows.map(row=>({...row,data:{...row.data,exact}}))};
  const result=await publish(next);assert.equal((await state(result.runId)).changed,2);
  assert.deepEqual((await read()).days.get(from)?.rows[0].data.exact,exact);
  assert.deepEqual(await assignments(),[{metric:'kpi_daily_manifest',n:1},{metric:'kpi_daily_row',n:1}]);
 }
 batch=changed;await publish(batch);
});

test('Masterclass exact publication confirms stable detail while its observed overview changes; periods stay separate', async () => {
 const ns='77025', profile='synthetic-mc-confirmation';
 const context={origin:'https://eu.posthog.com',scope:{source:'all',campaignId:null},client:{quizHost:'https://quiz.example.test'},expectedQueries:['masterclass']};
 const start='2026-09-09T22:00:00.000Z', end='2026-09-10T22:00:00.000Z';
 async function publishMc(observation: number) {
  const claim=await db.rpc<Row>('cockpit_claim_posthog',{p_namespace:ns,p_stream:'masterclass_observations',p_profile:profile,p_from:start,p_to:end,p_context:context});
  assert.equal(claim.busy,false);
  await db.rpc('cockpit_save_posthog_query',{p_run:claim.runId,p_lease:claim.lease,p_name:'masterclass',p_continuation:{version:1,id:'q-'+String(claim.runId).slice(0,8),origin:'https://eu.posthog.com',projectId:ns,queryHash:'b'.repeat(64),startedAt:Date.now()},p_complete:true});
  const common={source:'posthog',source_namespace:ns,metric_key:'posthog_mc_events',period_from:start,period_to:end,report_profile_key:profile,timezone:'Europe/Paris',coverage_state:'complete',unit:'count',currency:null,currency_exponent:null,tax_basis:'unknown',definition_version:profile};
  const records=[{...common,dimensions_key:'all',value:5,dimensions:{observedAt:`2026-09-20T${observation}:00:00Z`},source_locator:'posthog:masterclass:overview'},
   {...common,dimensions_key:'event:play',value:5,dimensions:{event:'play',events:5},source_locator:'posthog:masterclass:play'}];
  const ack=await db.rpc<Row>('cockpit_publish_posthog',{p_run:claim.runId,p_lease:claim.lease,p_records:records,p_read:5});
  return {run:String(claim.runId),lease:claim.lease,records,ack};
 }
 const first=await publishMc(10);
 const ids=(await sql.query('SELECT id FROM source_aggregates WHERE source_namespace=$1 ORDER BY id',[ns])).rows;
 await clearAudit();const second=await publishMc(11);
 assert.deepEqual((await sql.query('SELECT id FROM source_aggregates WHERE source_namespace=$1 ORDER BY id',[ns])).rows,ids);
 assert.equal((await state(second.run)).confirmed,1);assert.equal((await state(second.run)).changed,1);
 assert.deepEqual(await assignments(),[{metric:'posthog_mc_events',n:1}]);
 const snapshot=await db.rpc<Row>('cockpit_source_window',{p_source:'posthog',p_namespace:ns,p_stream:'masterclass_observations',p_profile:profile,p_from:from,p_to:to,p_timezone:'Europe/Paris',p_currency:null,p_currency_exponent:null,p_kind:'exact_report'});
 assert.equal(snapshot.exactRunId,second.run);assert.equal((snapshot.aggregates as Row[]).length,2);
 const other=await db.rpc<Row>('cockpit_source_window',{p_source:'posthog',p_namespace:ns,p_stream:'masterclass_observations',p_profile:profile,p_from:'2026-09-09',p_to:to,p_timezone:'Europe/Paris',p_currency:null,p_currency_exponent:null,p_kind:'exact_report'});
 assert.equal(other.exactRunId,null);
 const retry=await db.rpc<Row>('cockpit_publish_posthog',{p_run:second.run,p_lease:second.lease,p_records:second.records,p_read:5});
 assert.equal(retry.duplicate,true);assert.equal(first.ack.status,'complete');
});

test('concurrent acknowledgement retries serialize publication; readers retain old coherent state until commit', async () => {
 const previous=await read();await clearAudit();let checked=false;
 const concurrent:Database={...db,rpc:async<T>(name:string,args:Row,options?:Parameters<Database['rpc']>[2])=>{
  if(name!=='cockpit_publish_aggregate_state')return db.rpc<T>(name,args,options);
  const blocker=new Client({connectionString:target.href}),a=new Client({connectionString:target.href}),b=new Client({connectionString:target.href});
  await Promise.all([blocker.connect(),a.connect(),b.connect()]);
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM sync_runs WHERE id=$1 FOR UPDATE',[args.p_run]);
   const statement='SELECT cockpit_publish_aggregate_state($1,$2::text[],$3) AS ack',params=[args.p_run,args.p_metric_keys,args.p_read];
   const first=a.query(statement,params),second=b.query(statement,params);
   // Poll a visible lock predicate, not a guessed sleep duration.
   let waiting=0;for(let i=0;i<100&&waiting<2;i++){
    waiting=(await sql.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT cockpit_publish_aggregate_state%' AND wait_event_type='Lock'")).rows[0].n;
    if(waiting<2)await new Promise(resolve=>setTimeout(resolve,10));
   }
   assert.equal(waiting,2);assert.deepEqual((await read()).days,previous.days);
   await blocker.query('COMMIT');const results=await Promise.all([first,second]);const acks=results.map(result=>result.rows[0].ack);
   assert.equal(acks.filter(ack=>ack.duplicate===true).length,1);assert.equal(acks.filter(ack=>ack.status==='complete'&&!ack.duplicate).length,1);checked=true;
   return acks.find(ack=>!ack.duplicate) as T;
  }finally{await blocker.query('ROLLBACK');await Promise.all([blocker.end(),a.end(),b.end()]);}
 }};
 const result=await syncKpiSource(concurrent,'meta',namespace,from,to,async()=>batch);assert.equal(checked,true);
 const current=await read();assert.equal(current.days.get(from)?.runId,result.runId);assert.deepEqual(current.days.get(from)?.rows,previous.days.get(from)?.rows);
 assert.deepEqual(await assignments(),[]);
 assert.equal((await one('SELECT count(*)::int n FROM source_aggregates WHERE sync_run_id=$1 AND NOT is_current',[result.runId])).n,0);
});

test('migration replay has no data effect and preserves private invoker grants; restoring 022 is compatible', async () => {
 const before=await rows();await clearAudit();await sql.query(fs.readFileSync(migration,'utf8'));await sql.query(fs.readFileSync(migration,'utf8'));
 assert.deepEqual(await rows(),before);assert.deepEqual(await assignments(),[]);
 assert.equal((await one('SELECT count(*)::int AS n FROM cockpit_migrations WHERE version=25')).n,1);
 for(const role of ['anon','authenticated']) assert.equal((await one("SELECT has_function_privilege($1,'public.cockpit_apply_aggregate_state(uuid,text[],boolean)','EXECUTE') AS ok",[role])).ok,false);
 const fn=await one("SELECT prosecdef,proconfig FROM pg_proc WHERE oid='public.cockpit_apply_aggregate_state(uuid,text[],boolean)'::regprocedure");
 assert.equal(fn.prosecdef,false);assert.deepEqual(fn.proconfig,['search_path=public, pg_temp']);
 const old=fs.readFileSync('supabase/migrations/022_reappearance_same_row.sql','utf8');
 await sql.query(old.slice(old.indexOf('CREATE OR REPLACE FUNCTION public.cockpit_apply_aggregate_state'),old.indexOf('CREATE OR REPLACE FUNCTION public.cockpit_publish_meta_daily')));
 const oldResult=await publish(batch);assert.equal((await read()).days.get(from)?.runId,oldResult.runId);
 assert.deepEqual((await rows()).map(r=>r.id),before.map(r=>r.id));
 await sql.query(fs.readFileSync(migration,'utf8'));await clearAudit();
 const restored=await publish(batch);assert.equal((await read()).days.get(from)?.runId,restored.runId);assert.deepEqual(await assignments(),[]);
});
