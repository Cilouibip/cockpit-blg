import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Client} from 'pg';
import {postgresDatabase,type Database,type Row} from '../src/lib/db';
import {syncKpiSource,readKpiSource,type KpiSourceBatch} from '../src/lib/kpi-source-store';

// CI PostgreSQL service only, disposable database and synthetic rows. No live source or env file.
const base=new URL(process.env.TEST_DATABASE_URL||'postgresql://localhost:55440/postgres');
if(!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw Error('LOCAL_ONLY');
const name='kpi_current_scope_'+Date.now(),target=new URL(base);target.pathname='/'+name;
const admin=new Client({connectionString:base.href});let sql:Client,db:Database;
const beforeFile='supabase/migrations/025_aggregate_payload_confirmation.sql';
const afterFile='supabase/migrations/030_kpi_publication_current_scope.sql';
const namespace='synthetic-kpi-scope',from='2026-09-20',to='2026-09-21';
const metrics='{kpi_daily_row,kpi_daily_manifest}';
before(async()=>{
 await admin.connect();await admin.query(`CREATE DATABASE ${name}`);
 sql=new Client({connectionString:target.href});await sql.connect();
 for(const file of fs.readdirSync('supabase/migrations').filter(f=>/^\d{3}_.*\.sql$/.test(f)&&Number(f.slice(0,3))<=28).sort())await sql.query(fs.readFileSync('supabase/migrations/'+file,'utf8'));
 db=postgresDatabase(target.href);
});
after(async()=>{await sql?.end();await new Promise(resolve=>setTimeout(resolve,5500));await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();});
const batch=(n=12,stamp='2026-09-21T08:00:00Z'):KpiSourceBatch=>({from,to,observedAt:stamp,rows:Array.from({length:n},(_,i)=>({day:from,key:'synthetic-'+String(i).padStart(5,'0'),data:{sent:1,delivered:1,opens:i%3,clicks:0,recipientKey:'synthetic-key-'+i}}))});
const publish=(value:KpiSourceBatch,store=db)=>syncKpiSource(store,'wix',namespace,from,to,async()=>structuredClone(value));
const current=async()=> (await sql.query('SELECT * FROM source_aggregates WHERE source_namespace=$1 AND is_current ORDER BY metric_key,dimensions_key',[namespace])).rows;
const reset=async(file:string)=>{await sql.query('TRUNCATE source_aggregates,sync_runs CASCADE');await sql.query(fs.readFileSync(file,'utf8'));};
function normalized(rows:Row[],aliases:Map<string,string>){return rows.map(({id,sync_run_id,...row})=>({...row,sync_run_id:aliases.get(String(sync_run_id))??sync_run_id}));}
async function scenario(file:string){
 await reset(file);const aliases=new Map<string,string>(),records:unknown[]=[];
 const save=async(label:string,result:{runId:string})=>{
  aliases.set(result.runId,label);
  const state=(await sql.query("SELECT checkpoint->'state' state FROM sync_runs WHERE id=$1",[result.runId])).rows[0].state;
  records.push({label,state,current:normalized(await current(),aliases)});
 };
 let value=batch();const first=await publish(value);await save('first',first);
 const originalIds=new Map((await current()).map(row=>[row.dimensions_key,row.id]));
 const same=await publish(value);await save('same',same);
 assert.deepEqual(new Map((await current()).map(row=>[row.dimensions_key,row.id])),originalIds,'stable IDs on identical confirmation');
 const duplicate=await db.rpc<Row>('cockpit_publish_aggregate_state',{p_run:same.runId,p_metric_keys:metrics,p_read:value.rows.length});
 assert.equal(duplicate.duplicate,true);
 value=batch(12,'2026-09-21T08:10:00Z');value.rows[0].data.opens=99;
 const changed=await publish(value);await save('changed',changed);
 assert.deepEqual(new Map((await current()).map(row=>[row.dimensions_key,row.id])),originalIds);
 value.rows=value.rows.filter(row=>row.key!=='synthetic-00001');
 const retired=await publish(value);await save('retired',retired);
 const original=originalIds.get('synthetic-00001');
 assert.equal((await sql.query('SELECT is_current FROM source_aggregates WHERE id=$1',[original])).rows[0].is_current,false);
 value=batch(12,'2026-09-21T08:20:00Z');value.rows[0].data.opens=99;
 const revived=await publish(value);await save('revived',revived);
 assert.equal((await current()).find(row=>row.dimensions_key==='synthetic-00001')!.id,original,'reappearance reuses retired identity');
 const stable=await current();
 await sql.query(`CREATE FUNCTION synthetic_interrupt_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic interruption' USING ERRCODE='57014';END $$;
 CREATE TRIGGER synthetic_interruption AFTER UPDATE OF sync_run_id ON source_aggregates FOR EACH ROW EXECUTE FUNCTION synthetic_interrupt_publication();`);
 await assert.rejects(()=>publish(batch(12,'2026-09-21T08:30:00Z')),error=>(error as {code?:string}).code==='database_query_interrupted');
 await sql.query('DROP TRIGGER synthetic_interruption ON source_aggregates;DROP FUNCTION synthetic_interrupt_publication()');
 assert.deepEqual(await current(),stable,'failed transaction exposes no partial row or run promotion');
 const invalid={...db,upsert:async(table:Parameters<Database['upsert']>[0],rows:Row[],conflict?:string)=>db.upsert(table,rows.map((row,i)=>i===0?{...row,report_profile_key:'outside-profile'}:row),conflict)};
 await assert.rejects(()=>publish(batch(),invalid));assert.deepEqual(await current(),stable,'scope rejection preserves current state');
 return records;
}

test('025 and030 produce the same full state: identical, changed, retired, reappeared, duplicate, interruption and invalid scope',async()=>{
 const baseline=await scenario(beforeFile),candidate=await scenario(afterFile);
 assert.deepEqual(candidate,baseline);
});

test('publication remains atomic to a concurrent reader and same-run retry returns the existing result',async()=>{
 await reset(afterFile);await publish(batch());const old=await current();
 const writer=new Client({connectionString:target.href});await writer.connect();
 try{
  const transactional={...db,rpc:async<T>(functionName:string,args:Row):Promise<T>=>{
   if(functionName!=='cockpit_publish_aggregate_state')return db.rpc<T>(functionName,args);
   await writer.query('BEGIN');
   try{
    const result=(await writer.query('SELECT cockpit_publish_aggregate_state($1,$2::text[],$3) result',[args.p_run,args.p_metric_keys,args.p_read])).rows[0].result;
    assert.deepEqual(await current(),old,'uncommitted new publication is invisible from a separate connection');
    await writer.query('COMMIT');return result as T;
   }catch(error){await writer.query('ROLLBACK');throw error;}
  }};
  const result=await publish(batch(12,'2026-09-21T09:00:00Z'),transactional);
  const data=await readKpiSource(db,'wix',namespace,from,to);
  assert.equal(data.days.get(from)!.runId,result.runId);assert.equal(data.days.get(from)!.rows.length,12);
  const results=await Promise.all([db.rpc<Row>('cockpit_publish_aggregate_state',{p_run:result.runId,p_metric_keys:metrics,p_read:12}),writer.query('SELECT cockpit_publish_aggregate_state($1,$2::text[],$3) result',[result.runId,metrics,12]).then(r=>r.rows[0].result)]);
  assert.ok(results.every(r=>r.duplicate===true));assert.equal((await current()).length,13);
  const racing={...db,rpc:async<T>(functionName:string,args:Row):Promise<T>=>{
   if(functionName!=='cockpit_publish_aggregate_state')return db.rpc<T>(functionName,args);
   const acknowledgements=await Promise.all([db.rpc<Row>(functionName,args),writer.query('SELECT cockpit_publish_aggregate_state($1,$2::text[],$3) result',[args.p_run,args.p_metric_keys,args.p_read]).then(r=>r.rows[0].result as Row)]);
   assert.deepEqual(acknowledgements.map(r=>r.duplicate).sort(),[false,true],'same-run concurrent callers serialize on its lock');
   return acknowledgements[0] as T;
  }};
  await publish(batch(12,'2026-09-21T09:10:00Z'),racing);assert.equal((await current()).length,13);

 }finally{await writer.end();}
});

async function measuredPublication(file:string){
 await reset(file);const value=batch(4000);await publish(value);
 let plan:unknown;
 const measured={...db,rpc:async<T>(functionName:string,args:Row):Promise<T>=>{
  if(functionName!=='cockpit_publish_aggregate_state')return db.rpc<T>(functionName,args);
  const result=await sql.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT cockpit_publish_aggregate_state($1,$2::text[],$3)',[args.p_run,args.p_metric_keys,args.p_read]);
  plan=result.rows[0]['QUERY PLAN'][0];
  return (await db.rpc(functionName,args)) as T; // lost acknowledgement replay, already complete
 }};
 const result=await publish({...value,observedAt:'2026-09-21T10:00:00Z'},measured);
 const rows=await current(),data=await readKpiSource(db,'wix',namespace,from,to);
 assert.equal(rows.length,4001);assert.equal(data.days.get(from)!.rows.length,4000);assert.equal(data.days.get(from)!.runId,result.runId);
 return {plan,rows:rows.length};
}
test('4000-row mutation plans are captured on the CI database; both functions publish exactly4001 verified rows',async()=>{
 const baseline=await measuredPublication(beforeFile),candidate=await measuredPublication(afterFile);
 console.log('SYNTHETIC_PUBLICATION_PLANS',JSON.stringify({baseline,candidate}));
 assert.equal(candidate.rows,baseline.rows);
 // Timings are evidence, not a machine-dependent pass threshold. Production SELECT plans are stored separately.
});

test('exact-period callers retain the same matching and scope rejection as025',async()=>{
 const compare=[];
 for(const file of [beforeFile,afterFile]){
  await reset(file);let originalId:string|undefined;const states=[];
  for(let attempt=0;attempt<2;attempt++){
   const run=await db.rpc<string>('begin_sync_stream',{p_source:'posthog',p_namespace:namespace,p_from:'2026-09-20T00:00:00Z',p_to:'2026-09-21T00:00:00Z',p_profile:'synthetic-exact',p_stream:'masterclass_observations',p_coverage_kind:'aggregate_period'});
   await db.upsert('source_aggregates',[{source:'posthog',source_namespace:namespace,metric_key:'synthetic_exact',report_profile_key:'synthetic-exact',sync_run_id:run,period_from:'2026-09-20T00:00:00Z',period_to:'2026-09-21T00:00:00Z',dimensions_key:'all',timezone:'Europe/Paris',coverage_state:'complete',value:1,unit:'count',currency:null,currency_exponent:null,tax_basis:'unknown',dimensions:{count:1},definition_version:'synthetic-exact',source_locator:'synthetic:test'}]);
   states.push((await sql.query('SELECT cockpit_apply_aggregate_state($1,$2::text[],true) state',[run,'{synthetic_exact}'])).rows[0].state);
   const row=(await current())[0];if(originalId)assert.equal(row.id,originalId);else originalId=String(row.id);
   await db.rpc('finish_sync',{p_run:run,p_status:'complete',p_read:1,p_rejected:0,p_complete:true,p_error:null});
  }
  const run=await db.rpc<string>('begin_sync_stream',{p_source:'posthog',p_namespace:namespace,p_from:'2026-09-20T00:00:00Z',p_to:'2026-09-21T00:00:00Z',p_profile:'synthetic-exact',p_stream:'masterclass_observations',p_coverage_kind:'aggregate_period'});
  await sql.query("INSERT INTO source_aggregates(source,source_namespace,metric_key,report_profile_key,sync_run_id,period_from,period_to,dimensions_key,timezone,coverage_state,value,unit,tax_basis,dimensions,definition_version,source_locator) VALUES('posthog',$1,'synthetic_exact','synthetic-exact',$2,'2026-09-20T01:00:00Z','2026-09-21T00:00:00Z','invalid','Europe/Paris','complete',1,'count','unknown','{}','synthetic-exact','synthetic:test')",[namespace,run]);
  await assert.rejects(()=>sql.query('SELECT cockpit_apply_aggregate_state($1,$2::text[],true)',[run,'{synthetic_exact}']),error=>(error as {code?:string}).code==='23514');
  assert.equal((await current()).length,1);assert.equal((await current())[0].id,originalId);
  compare.push(states);
 }
 assert.deepEqual(compare[1],compare[0]);
});

test('preflight accepts the exact025 baseline and exact030 replay, but refuses body, security or missing-signature drift',async()=>{
 await reset(beforeFile);
 await sql.query(fs.readFileSync(afterFile,'utf8'));
 const source=async()=> (await sql.query("SELECT prosrc,prosecdef,proconfig FROM pg_proc WHERE oid=to_regprocedure('public.cockpit_apply_aggregate_state(uuid,text[],boolean)')")).rows;
 const installed=await source();await sql.query(fs.readFileSync(afterFile,'utf8'));assert.deepEqual(await source(),installed,'exact replay is idempotent');
 const refuses=async()=>{
  const unchanged=await source();
  await assert.rejects(()=>sql.query(fs.readFileSync(afterFile,'utf8')),error=>(error as {code?:string}).code==='55000');
  await sql.query('ROLLBACK');assert.deepEqual(await source(),unchanged,'preflight failure changes no function');
 };
 await sql.query("CREATE OR REPLACE FUNCTION public.cockpit_apply_aggregate_state(p_run uuid,p_metric_keys text[],p_exact boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$ BEGIN RETURN '{}'::jsonb;END $$;");
 await refuses();
 await sql.query(fs.readFileSync(beforeFile,'utf8'));
 await sql.query('ALTER FUNCTION public.cockpit_apply_aggregate_state(uuid,text[],boolean) SECURITY DEFINER');await refuses();
 await sql.query(fs.readFileSync(beforeFile,'utf8'));
 await sql.query('DROP FUNCTION public.cockpit_apply_aggregate_state(uuid,text[],boolean)');await refuses();
 await sql.query(fs.readFileSync(beforeFile,'utf8'));await sql.query(fs.readFileSync(afterFile,'utf8'));
 assert.deepEqual(await source(),installed);
});
