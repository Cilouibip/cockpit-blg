import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Client} from 'pg';
import {postgresDatabase,type Database,type Row} from '../src/lib/db';
import {syncKpiSource,readKpiSource,type KpiSourceBatch} from '../src/lib/kpi-source-store';

// CI PostgreSQL service only, disposable database and synthetic rows. No live source or env file.
const base=new URL(process.env.TEST_DATABASE_URL||'postgresql://127.0.0.1:55440/postgres');
if(!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw Error('LOCAL_ONLY');
const name='kpi_email_plan_'+Date.now(),target=new URL(base);target.pathname='/'+name;
const admin=new Client({connectionString:base.href});let sql:Client,db:Database;
const beforeFile='supabase/migrations/030_kpi_publication_current_scope.sql';
const afterFile='supabase/migrations/032_kpi_email_publication_plan.sql';
const namespace='synthetic-kpi-scope',from='2026-09-20',to='2026-09-21';
const metrics='{kpi_daily_row,kpi_daily_manifest}';
before(async()=>{
 await admin.connect();await admin.query(`CREATE DATABASE ${name}`);
 sql=new Client({connectionString:target.href});await sql.connect();
 for(const file of fs.readdirSync('supabase/migrations').filter(f=>/^\d{3}_.*\.sql$/.test(f)&&Number(f.slice(0,3))<=30).sort())await sql.query(fs.readFileSync('supabase/migrations/'+file,'utf8'));
 db=postgresDatabase(target.href);
});
after(async()=>{await sql?.end();await new Promise(resolve=>setTimeout(resolve,5500));await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();});
const batch=(n=12,stamp='2026-09-21T08:00:00Z'):KpiSourceBatch=>({from,to,observedAt:stamp,rows:Array.from({length:n},(_,i)=>({day:from,key:'synthetic-'+String(i).padStart(5,'0'),data:{sent:1,delivered:1,opens:i%3,clicks:0,recipientKey:'synthetic-key-'+i}}))});
const publish=(value:KpiSourceBatch,store=db)=>syncKpiSource(store,'wix',namespace,from,to,async()=>structuredClone(value));
const current=async()=> (await sql.query('SELECT * FROM source_aggregates WHERE source_namespace=$1 AND is_current ORDER BY metric_key,dimensions_key',[namespace])).rows;
const reset=async(file:string)=>{await sql.query('TRUNCATE source_aggregates,sync_runs CASCADE');await sql.query(fs.readFileSync('supabase/migrations/025_aggregate_payload_confirmation.sql','utf8'));await sql.query(fs.readFileSync(beforeFile,'utf8'));if(file!==beforeFile)await sql.query(fs.readFileSync(file,'utf8'));};
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


function firstStatement(file:string,run:string){
 let statement=fs.readFileSync(file,'utf8').match(/ WITH staged_scope AS MATERIALIZED \([\s\S]+?INTO n_confirmed,n_changed;/)![0].trim().replace('INTO n_confirmed,n_changed;',';');
 statement=statement.replaceAll('p_metric_keys',"'{kpi_daily_row,kpi_daily_manifest}'::text[]").replaceAll('p_exact','false').replaceAll('p_run',"'"+run+"'::uuid");
 return statement.replace(/\br\.(source_namespace|query_profile_key|period_from|period_to|source)\b/g,(_,field:string)=>({source_namespace:"'"+namespace+"'::text",source:"'wix'::text",query_profile_key:"'kpi-funnel-sources-v1'::text",period_from:"'2026-09-19T22:00:00Z'::timestamptz",period_to:"'2026-09-20T22:00:00Z'::timestamptz"} as Record<string,string>)[field]);
}
async function history(n:number){
 const run=await db.rpc<string>('begin_sync_stream',{p_source:'notion',p_namespace:'synthetic-history',p_from:'2026-01-01T00:00:00Z',p_to:'2026-02-01T00:00:00Z',p_profile:'synthetic-history',p_stream:'synthetic_history',p_coverage_kind:'aggregate_period'});
 await sql.query(`INSERT INTO source_aggregates(source,source_namespace,metric_key,report_profile_key,sync_run_id,period_from,period_to,dimensions_key,timezone,coverage_state,value,unit,tax_basis,dimensions,definition_version,source_locator)
 SELECT 'notion','synthetic-history','notion_commerce_checkpoint','synthetic-history',$1,'2026-01-01T00:00:00Z','2026-02-01T00:00:00Z',n::text,'Europe/Paris','complete',1,'count','unknown',jsonb_build_object('synthetic',repeat(md5(n::text),12)),'synthetic-history','synthetic:history' FROM generate_series(1,$2::int)n`,[run,n]);
 await db.rpc('finish_sync',{p_run:run,p_status:'complete',p_read:n,p_rejected:0,p_complete:true,p_error:null});
 await sql.query('ANALYZE source_aggregates');
}
test('030 and032 preserve state through confirmation/change/retirement/reappearance/replay/failure/scope rejection',async()=>{
 assert.deepEqual(await scenario(afterFile),await scenario(beforeFile));
});
function nodes(plan:Row):Row[]{return [plan,...((plan.Plans as Row[]|undefined)??[]).flatMap(nodes)];}
test('full publication plans: 940k synthetic history, 4000 daily rows; full matching has no quadratic scope rescan',async()=>{
 await reset(beforeFile);await history(940000);const value=batch(4000);await publish(value);await sql.query('ANALYZE source_aggregates');
 const evidence:unknown[]=[];let baseline:Row|undefined,candidate:Row|undefined;
 for(const [i,file] of [beforeFile,afterFile].entries()){
  if(file!==beforeFile)await sql.query(fs.readFileSync(file,'utf8'));
  let plan:Row|undefined,elapsed=0;
  const traced={...db,rpc:async<T>(fn:string,args:Row):Promise<T>=>{
   if(fn!=='cockpit_publish_aggregate_state')return db.rpc<T>(fn,args);
   await sql.query('BEGIN');
   try{plan=(await sql.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+firstStatement(file,String(args.p_run)))).rows[0]['QUERY PLAN'][0];}
   finally{await sql.query('ROLLBACK');}
   const started=performance.now(),result=await db.rpc<T>(fn,args);elapsed=performance.now()-started;return result;
  }};
  const result=await publish({...value,observedAt:`2026-09-21T${10+i}:00:00Z`},traced);
  assert.equal((await current()).length,4001);const read=await readKpiSource(db,'wix',namespace,from,to);
  assert.equal(read.days.get(from)?.runId,result.runId);assert.equal(read.days.get(from)?.rows.length,4000);
  const all=nodes(plan!.Plan as Row),match=all.find(n=>n['Subplan Name']==='CTE matches')!;
  evidence.push({file,totalMs:plan!['Execution Time'],publicationMs:elapsed,match,historyRows:940000,currentRows:4001});
  if(i===0)baseline=match;else candidate=match;
 }
 assert.equal(candidate!['Join Type'],'Full');assert.ok(['Hash Join','Merge Join'].includes(String(candidate!['Node Type'])));
 assert.ok(nodes(candidate!).every(n=>Number(n['Actual Loops'])<=1),'each matching scope is consumed once');
 assert.ok(nodes(baseline!).some(n=>Number(n['Actual Loops'])>=4000),'regression fixture exercises030 repeated matching');
 // No hardware-dependent speed threshold; work counts prove the removed quadratic scan.
 console.log('EMAIL_PUBLICATION_PLAN_COMPARISON',JSON.stringify(evidence));
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

test('exact-period callers retain the same matching and scope rejection as030',async()=>{
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

test('032 exact replay is accepted, security/body drift refuses atomically',async()=>{
 await reset(beforeFile);await sql.query(fs.readFileSync(afterFile,'utf8'));
 const metadata=async()=> (await sql.query("SELECT prosrc,prosecdef,proconfig,proacl FROM pg_proc WHERE oid=to_regprocedure('public.cockpit_apply_aggregate_state(uuid,text[],boolean)')")).rows;
 const installed=await metadata();await sql.query(fs.readFileSync(afterFile,'utf8'));assert.deepEqual(await metadata(),installed);
 await sql.query('ALTER FUNCTION public.cockpit_apply_aggregate_state(uuid,text[],boolean) SECURITY DEFINER');
 const drifted=await metadata();await assert.rejects(()=>sql.query(fs.readFileSync(afterFile,'utf8')),e=>(e as {code?:string}).code==='55000');await sql.query('ROLLBACK');assert.deepEqual(await metadata(),drifted);
 await reset(beforeFile);await sql.query("CREATE OR REPLACE FUNCTION public.cockpit_apply_aggregate_state(p_run uuid,p_metric_keys text[],p_exact boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$ BEGIN RETURN '{}'::jsonb;END $$;");
 const wrong=await metadata();await assert.rejects(()=>sql.query(fs.readFileSync(afterFile,'utf8')),e=>(e as {code?:string}).code==='55000');await sql.query('ROLLBACK');assert.deepEqual(await metadata(),wrong);
});

test('nullable payloads retain SQL NULL and identical confirmation/changes in030 and032',async()=>{
 const snapshots=[];
 for(const file of [beforeFile,afterFile]){
  await reset(file);const value=batch(3);value.rows.forEach(row=>{row.data.nullable=null;row.data.ordered=[null,1,'1',false];});
  let changed=false;
  const nullable={...db,upsert:async(table:Parameters<Database['upsert']>[0],rows:Row[],conflict?:string)=>db.upsert(table,rows.map(row=>row.metric_key==='kpi_daily_row'?{...row,value:changed&&row.dimensions_key==='synthetic-00000'?7:null,currency:null,currency_exponent:null}:row),conflict)};
  const first=await publish(value,nullable),ids=(await current()).map(row=>row.id);
  const second=await publish(value,nullable);let state=(await sql.query("SELECT checkpoint->'state' state FROM sync_runs WHERE id=$1",[second.runId])).rows[0].state;
  assert.equal(state.confirmed,4);assert.equal(state.changed,0);
  assert.ok((await current()).filter(row=>row.metric_key==='kpi_daily_row').every(row=>row.value===null));
  changed=true;const third=await publish(value,nullable);state=(await sql.query("SELECT checkpoint->'state' state FROM sync_runs WHERE id=$1",[third.runId])).rows[0].state;
  assert.equal(state.changed,1);assert.equal(state.confirmed,3);assert.deepEqual((await current()).map(row=>row.id),ids);
  snapshots.push({state,rows:normalized(await current(),new Map([[first.runId,'first'],[second.runId,'same'],[third.runId,'changed']]))});
 }
 assert.deepEqual(snapshots[1],snapshots[0]);
});

test('publication preserves different namespace, profile, metric and out-of-scope periods byte for byte',async()=>{
 await reset(afterFile);const value=batch(3);await publish(value);const template=(await current()).find(row=>row.metric_key==='kpi_daily_row')!;
 const foreignIds:string[]=[];
 for(const kind of ['namespace','profile','metric','period']){
  const ns=kind==='namespace'?'synthetic-foreign':namespace,profile=kind==='profile'?'synthetic-foreign-profile':'kpi-funnel-sources-v1';
  const a=kind==='period'?'2020-01-01T00:00:00Z':'2026-09-19T22:00:00Z',b=kind==='period'?'2020-01-02T00:00:00Z':'2026-09-20T22:00:00Z';
  const run=await db.rpc<string>('begin_sync_stream',{p_source:'wix',p_namespace:ns,p_from:a,p_to:b,p_profile:profile,p_stream:'synthetic_isolation',p_coverage_kind:'aggregate_period'});
  const inserted=(await sql.query(`INSERT INTO source_aggregates(id,source,source_namespace,metric_key,report_profile_key,sync_run_id,period_from,period_to,dimensions_key,timezone,coverage_state,value,unit,tax_basis,dimensions,definition_version,source_locator,is_current)
   SELECT gen_random_uuid(),source,$2,$3,$4,$5,$6,$7,$8,timezone,coverage_state,value,unit,tax_basis,dimensions,definition_version,source_locator,true FROM source_aggregates WHERE id=$1 RETURNING id`,[template.id,ns,kind==='metric'?'synthetic_foreign_metric':'kpi_daily_row',profile,run,a,b,'foreign-'+kind])).rows[0];
  foreignIds.push(inserted.id);await db.rpc('finish_sync',{p_run:run,p_status:'complete',p_read:1,p_rejected:0,p_complete:true,p_error:null});
 }
 const snapshot=async()=> (await sql.query('SELECT * FROM source_aggregates WHERE id=ANY($1::uuid[]) ORDER BY id',[foreignIds])).rows;
 const untouched=await snapshot();await publish({...value,rows:[],observedAt:'2026-09-21T09:00:00Z'});assert.deepEqual(await snapshot(),untouched);
 await publish(value);assert.deepEqual(await snapshot(),untouched);
});

test('rollback restores exact030 function body and ACL without rewriting records; writer remains usable',async()=>{
 await reset(beforeFile);
 const metadata=async()=> (await sql.query("SELECT prosrc,prosecdef,proconfig,proacl FROM pg_proc WHERE oid=to_regprocedure('public.cockpit_apply_aggregate_state(uuid,text[],boolean)')")).rows;
 const original=await metadata();await sql.query(fs.readFileSync(afterFile,'utf8'));await publish(batch(3));const records=await current();
 const previous=fs.readFileSync(beforeFile,'utf8'),rollback='BEGIN;\n'+previous.slice(previous.indexOf('CREATE OR REPLACE FUNCTION'),previous.indexOf('INSERT INTO public.cockpit_migrations'))+'COMMIT;\n';
 await sql.query(rollback);assert.deepEqual(await metadata(),original);assert.deepEqual(await current(),records);
 const access=(await sql.query("SELECT has_function_privilege('anon','public.cockpit_apply_aggregate_state(uuid,text[],boolean)','execute') anon,has_function_privilege('authenticated','public.cockpit_apply_aggregate_state(uuid,text[],boolean)','execute') authenticated,has_function_privilege('service_role','public.cockpit_apply_aggregate_state(uuid,text[],boolean)','execute') service_role")).rows[0];
 assert.deepEqual(access,{anon:false,authenticated:false,service_role:true});
 const result=await publish(batch(3,'2026-09-21T10:00:00Z'));assert.deepEqual((await current()).map(row=>row.id),records.map(row=>row.id));assert.equal((await readKpiSource(db,'wix',namespace,from,to)).days.get(from)?.runId,result.runId);
});
