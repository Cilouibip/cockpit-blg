import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFileSync,readdirSync} from 'node:fs';
import {postgresDatabase} from '../src/lib/db';
import {synchronizePostHogReport} from '../src/lib/sync-posthog-reports';
import {postHogAggregateQueries,postHogMasterclassQuery,postHogMasterclassProfile,postHogScopeProfile,POSTHOG_DEFAULT_CLIENT,POSTHOG_DEFAULT_SCOPE} from '../src/connectors/posthog-analytics';

const adminUrl=new URL(process.env.TEST_DATABASE_URL||'postgresql://postgres@127.0.0.1:55443/postgres');
if(!['127.0.0.1','localhost','[::1]'].includes(adminUrl.hostname))throw Error('LOCAL_ONLY');
const databaseName='c3_posthog_resume';
const targetUrl=new URL(adminUrl);targetUrl.pathname='/'+databaseName;
let admin:Client,worker:Client,other:Client,created=false;
const rpc=async<T=any>(db:Client,name:string,args:Record<string,unknown>):Promise<T>=>{
 const entries=Object.entries(args);
 const query=`SELECT public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) AS result`;
 const result=await db.query(query,entries.map(([,value])=>value&&typeof value==='object'?JSON.stringify(value):value));
 return result.rows[0].result;
};
const from='2026-09-01T22:00:00Z',to='2026-09-03T22:00:00Z';
const context=(expectedQueries=['overview','byEvent','byHostEvent','daily'])=>({origin:'https://eu.posthog.com',scope:{source:'all',campaignId:null},client:{quizHost:'https://quizz.blg-studio.fr'},expectedQueries});
const claim=(db:Client,profile:string,period={from,to},scope=context())=>rpc(db,'cockpit_claim_posthog',{p_namespace:'123',p_stream:'quiz_observations',p_profile:profile,p_from:period.from,p_to:period.to,p_context:scope});
const continuation=(id='client-id',startedAt=Date.now())=>({version:1,id,origin:'https://eu.posthog.com',projectId:'123',queryHash:'a'.repeat(64),startedAt});
const save=(db:Client,c:any,name:string,cont:Record<string,unknown>=continuation(),complete=false)=>rpc(db,'cockpit_save_posthog_query',{p_run:c.runId,p_lease:c.lease,p_name:name,p_continuation:cont,p_complete:complete});
const allComplete=async(c:any)=>{for(const name of context().expectedQueries)await save(worker,c,name,continuation(name),true);};
const record=(c:any,metric='posthog_events',value:number|null=0)=>({source:'posthog',source_namespace:'123',metric_key:metric,period_from:from,period_to:to,dimensions_key:'all',report_profile_key:c.profile??'report-v1',timezone:'Europe/Paris',coverage_state:'complete',value,unit:'count',currency:null,currency_exponent:null,tax_basis:'unknown',dimensions:{coverage:{queryComplete:true}},definition_version:c.profile??'report-v1',source_locator:'posthog:aggregate:all'});
const publish=(db:Client,c:any,records:unknown[],read=0)=>rpc(db,'cockpit_publish_posthog',{p_run:c.runId,p_lease:c.lease,p_records:records,p_read:read});

before(async()=>{
 admin=new Client({connectionString:adminUrl.href});await admin.connect();
 const exists=await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[databaseName]);
 if(exists.rowCount)throw Error('Dedicated C3 database already exists; refusing to overwrite it');
 await admin.query(`CREATE DATABASE ${databaseName}`);created=true;
 worker=new Client({connectionString:targetUrl.href});other=new Client({connectionString:targetUrl.href});await worker.connect();await other.connect();
 // Toutes les migrations, dont 018 (cockpit_publish_posthog : état courant pour Masterclass, quiz inchangé).
 const migrations=readdirSync('supabase/migrations').filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort();
 for(const file of migrations)await worker.query(readFileSync('supabase/migrations/'+file,'utf8'));
});
after(async()=>{await other?.end();await worker?.end();if(created){await new Promise(resolve=>setTimeout(resolve,5_500));await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[databaseName]);await admin.query(`DROP DATABASE ${databaseName}`);}await admin?.end();});

test('claim is exclusive across connections and preserves period/context',async()=>{
 const [first,second]=await Promise.all([claim(worker,'race-v1'),claim(other,'race-v1')]);
 const owner=first.busy?second:first,busy=first.busy?first:second;
 assert.equal(owner.busy,false);assert.equal(busy.busy,true);assert.equal(busy.runId,owner.runId);
 const shifted=await claim(other,'race-v1',{from,to:'2026-09-04T22:00:00Z'});assert.equal(shifted.busy,true);assert.equal(shifted.reason,'POSTHOG_SCOPE_BUSY');
 const changed=await claim(other,'race-v1',{from,to},context(['overview','byEvent','byHostEvent','daily','questions']));assert.equal(changed.busy,true);
 assert.deepEqual(owner.checkpoint.context,context());assert.equal(owner.checkpoint.version,1);
 assert.ok(Date.parse(owner.expiresAt)-Date.parse(owner.observedAt)<=600001);
 await rpc(worker,'cockpit_release_posthog',{p_run:owner.runId,p_lease:owner.lease,p_error:null});
});

test('takeover keeps checkpoint and fences stale save, release and publish',async()=>{
 const first=await claim(worker,'takeover-v1');const started=Date.now();
 await save(worker,first,'overview',continuation('client-id',started));
 await worker.query("UPDATE sync_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[first.runId]);
 const resumed=await claim(other,'takeover-v1');assert.equal(resumed.runId,first.runId);assert.notEqual(resumed.lease,first.lease);
 assert.equal(resumed.checkpoint.queries.overview.continuation.id,'client-id');
 await assert.rejects(save(worker,first,'overview',continuation('late',started)),{code:'55000'});
 await assert.rejects(rpc(worker,'cockpit_release_posthog',{p_run:first.runId,p_lease:first.lease,p_error:null}),{code:'55000'});
 await assert.rejects(publish(worker,first,[]),{code:'55000'});
 await save(other,resumed,'overview',continuation('server-id',started),true);
 const row=(await other.query('SELECT checkpoint FROM sync_runs WHERE id=$1',[first.runId])).rows[0];
 assert.equal(row.checkpoint.queries.overview.continuation.id,'server-id');
 await assert.rejects(save(other,resumed,'overview',{...continuation('server-id',started),queryHash:'b'.repeat(64)},true),{code:'55000'});
 await assert.rejects(save(other,resumed,'overview',continuation('server-id',started),false),{code:'55000'});
 await rpc(other,'cockpit_release_posthog',{p_run:resumed.runId,p_lease:resumed.lease,p_error:null});
});

test('pending work blocks publication; complete publish is atomic and digest-idempotent',async()=>{
 const c=await claim(worker,'report-v1');c.profile='report-v1';
 await assert.rejects(publish(worker,c,[record(c)]),{code:'55000'});
 await allComplete(c);
 const valid=[record(c,'posthog_events',1),record(c,'posthog_visitors',1),record(c,'posthog_sessions',1)];
 const invalid=[...valid,{...record(c,'posthog_events',1),dimensions_key:'bad',source_namespace:'different'}];
 await assert.rejects(publish(worker,c,invalid,1),{code:'23514'});
 assert.equal((await worker.query('SELECT count(*)::int n FROM source_aggregates WHERE sync_run_id=$1',[c.runId])).rows[0].n,0);
 const done=await publish(worker,c,valid,1);assert.equal(done.status,'complete');assert.equal(done.count,3);
 const repeated=await publish(other,{...c,lease:'00000000-0000-0000-0000-000000000000'},valid,1);assert.equal(repeated.duplicate,true);assert.equal(repeated.digest,done.digest);
 await assert.rejects(publish(other,c,[record(c,'posthog_events',2)],2),{code:'55000'});
 assert.equal((await worker.query('SELECT count(*)::int n FROM source_aggregates WHERE sync_run_id=$1',[c.runId])).rows[0].n,3);
 // A newer attempt cannot replace the published report until its own transaction succeeds.
 const next=await claim(worker,'report-v1');next.profile='report-v1';await allComplete(next);
 await assert.rejects(publish(worker,next,[{...record(next,'posthog_events',2),metric_key:'wix_total_revenue'}],2),{code:'23514'});
 assert.equal((await worker.query("SELECT count(*)::int n FROM sync_runs WHERE source='posthog' AND query_profile_key='report-v1' AND status='complete'")).rows[0].n,1);
});

test('expiry is absolute; failed attempt enforces cooldown before new context',async()=>{
 const c=await claim(worker,'expiry-v1');
 await worker.query("UPDATE sync_runs SET checkpoint=jsonb_set(checkpoint,'{expiresAt}',to_jsonb((clock_timestamp()-interval '1 second')::text)) WHERE id=$1",[c.runId]);
 const expired=await claim(worker,'expiry-v1');assert.equal(expired.busy,true);assert.equal(expired.reason,'POSTHOG_QUERY_EXPIRED');
 await assert.rejects(save(worker,c,'overview'),{code:'55000'});
 assert.equal((await claim(worker,'expiry-v1')).reason,'POSTHOG_COOLDOWN');
 await worker.query("UPDATE sync_runs SET finished_at=clock_timestamp()-interval '6 minutes' WHERE id=$1",[c.runId]);
 const fresh=await claim(worker,'expiry-v1',{from,to},context(['overview','byEvent','byHostEvent','daily','questions']));
 assert.equal(fresh.busy,false);assert.notEqual(fresh.runId,c.runId);assert.equal(fresh.checkpoint.context.expectedQueries.length,5);
 await rpc(worker,'cockpit_release_posthog',{p_run:fresh.runId,p_lease:fresh.lease,p_error:'POSTHOG_IMPORT_FAILED'});
 assert.equal((await claim(worker,'expiry-v1')).reason,'POSTHOG_COOLDOWN');
});

test('masterclass needs its sole query and rejects another project or unowned lease',async()=>{
 const scope=context(['masterclass']);
 const c=await rpc<any>(worker,'cockpit_claim_posthog',{p_namespace:'123',p_stream:'masterclass_observations',p_profile:'mc-v1',p_from:from,p_to:to,p_context:scope});
 assert.equal(c.busy,false);
 await assert.rejects(save(worker,c,'overview'),{code:'23514'});
 await assert.rejects(save(worker,c,'masterclass',{...continuation(),projectId:'999'}),{code:'23514'});
 await assert.rejects(rpc(worker,'cockpit_save_posthog_query',{p_run:c.runId,p_lease:null,p_name:'masterclass',p_continuation:continuation(),p_complete:true}),{code:'55000'});
 await save(worker,c,'masterclass',continuation(),true);
 const mc={...record({...c,profile:'mc-v1'},'posthog_mc_events',0),dimensions:{coverage:{queryComplete:true},observedAt:c.observedAt}};
 assert.equal((await publish(worker,c,[mc],0)).status,'empty');
 assert.equal(new Date((await worker.query('SELECT source_as_of FROM sync_runs WHERE id=$1',[c.runId])).rows[0].source_as_of).toISOString(),new Date(c.observedAt).toISOString());
});

test('RPC execute privileges are limited to service_role',async()=>{
 for(const fn of ['cockpit_claim_posthog(text,text,text,timestamptz,timestamptz,jsonb)','cockpit_save_posthog_query(uuid,uuid,text,jsonb,boolean)','cockpit_release_posthog(uuid,uuid,text)','cockpit_publish_posthog(uuid,uuid,jsonb,integer)']){
  for(const role of ['anon','authenticated'])assert.equal((await worker.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') allowed',[role,`public.${fn}`])).rows[0].allowed,false);
  assert.equal((await worker.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') allowed',['service_role',`public.${fn}`])).rows[0].allowed,true);
 }
});

test('null and oversized JSON input cannot enter a PostHog checkpoint or publication',async()=>{
 await assert.rejects(claim(worker,'null-context-v1',{from,to},null as any),{code:'23514'});
 const c=await claim(worker,'shape-v1');
 await assert.rejects(rpc(worker,'cockpit_save_posthog_query',{p_run:c.runId,p_lease:c.lease,p_name:'overview',p_continuation:null,p_complete:false}),{code:'23514'});
 await assert.rejects(rpc(worker,'cockpit_publish_posthog',{p_run:c.runId,p_lease:c.lease,p_records:null,p_read:0}),{code:'23514'});
 await assert.rejects(publish(worker,c,Array(751).fill({})),{code:'23514'});
 await assert.rejects(publish(worker,c,[{dimensions:'x'.repeat(2_000_001)}]),{code:'23514'});
 assert.equal((await worker.query('SELECT status,checkpoint FROM sync_runs WHERE id=$1',[c.runId])).rows[0].status,'running');
 await rpc(worker,'cockpit_release_posthog',{p_run:c.runId,p_lease:c.lease,p_error:'POSTHOG_RESULT_INVALID'});
});

/** The real driver and SQL run against a local DB. Only PostHog's HTTP endpoint
 * is simulated; the second invocation must GET the saved job, never POST it again. */
for(const kind of ['masterclass','quiz'] as const)test(`${kind} resumes a pending remote report and publishes an exact-period snapshot without duplicate POST`,async()=>{
 const env={POSTHOG_HOST:'https://eu.posthog.com',POSTHOG_PROJECT_ID:'123',POSTHOG_PERSONAL_API_KEY:'synthetic-local-only'};
 const db=postgresDatabase(targetUrl.href),posted:string[]=[];let phase=1;
 const schema={sessionIdAvailable:false,questionNumberProperty:'numero' as const};
 const queries=kind==='quiz'?postHogAggregateQueries(from,to,schema,POSTHOG_DEFAULT_SCOPE,POSTHOG_DEFAULT_CLIENT):{masterclass:postHogMasterclassQuery(from,to,POSTHOG_DEFAULT_CLIENT)};
 const prepare=async()=>({endpoint:new URL(env.POSTHOG_HOST),headers:{Authorization:'Bearer synthetic-local-only','Content-Type':'application/json'},schema,queries,deadline:Date.now()+(phase===1?7_200:20_000),signal:new AbortController().signal});
 const columns:Record<string,string[]>={
  overview:['events','visitors','sessions','events_with_visitor_id','events_with_session_id','observed_tracked_events','missing_host_events','conflicting_host_events','excluded_host_events','identifiable_test_events','first_observed_at','last_observed_at'],
  byEvent:['event','events','visitors','sessions','events_with_visitor_id','events_with_session_id'],
  byHostEvent:['host','event','events','visitors','sessions','events_with_visitor_id','events_with_session_id'],
  daily:['day','event','host','events','visitors','sessions','events_with_visitor_id','events_with_session_id'],
  questions:['question_number','events','visitors','sessions','events_with_visitor_id','events_with_session_id'],
  masterclass:['event','events','visitors','kit_sessions','events_with_visitor_id','events_with_kit_session_id','verified_host_events','unlocated_events','excluded_events'],
 };
 const completed=(name:string,id:string)=>({query_status:{id,complete:true,results:{columns:columns[name],results:name==='overview'?[[0,0,0,0,0,0,0,0,0,0,null,null]]:[]}}});
 const fetcher:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));assert.equal(url.origin,env.POSTHOG_HOST);
  if(init?.method==='POST'){
   const body=JSON.parse(String(init.body));const name=kind==='masterclass'?'masterclass':String(body.name).split(' ').at(-1)!;
   assert.ok(Object.hasOwn(queries,name));posted.push(name);
   const id=`${kind}-${name}`;
   return Response.json(phase===1?{query_status:{id,complete:false}}:completed(name,id));
  }
  const id=url.pathname.split('/').filter(Boolean).at(-1)!;const name=id.slice(kind.length+1);
  assert.ok(Object.hasOwn(queries,name));return Response.json(phase===1?{query_status:{id,complete:false}}:completed(name,id));
 };
 const options={db,env,fetcher,prepare:prepare as any};
 const first=await synchronizePostHogReport(kind,'2026-09-02','2026-09-04',options);
 assert.equal(first?.status,'pending');assert.deepEqual(posted,[kind==='quiz'?'overview':'masterclass']);
 const stream=kind==='quiz'?'quiz_observations':'masterclass_observations';
 const pendingRun=(await worker.query('SELECT id,status,lease_until,checkpoint FROM sync_runs WHERE source=$1 AND stream_key=$2 ORDER BY started_at DESC LIMIT 1',['posthog',stream])).rows[0];
 assert.equal(pendingRun.status,'running');assert.ok(pendingRun.checkpoint.queries[kind==='quiz'?'overview':'masterclass'].continuation.id);
 assert.ok(Date.parse(String(pendingRun.lease_until))<=Date.now());
 phase=2;
 // A new browser period cannot steal the saved report. A scheduled midnight
 // rollover may finish its original window before starting a fresh one.
 assert.equal((await synchronizePostHogReport(kind,'2026-09-02','2026-09-05',options))?.status,'pending');
 const second=await synchronizePostHogReport(kind,'2026-09-02','2026-09-05',{...options,resumeRunningPeriod:true});
 assert.equal(second?.to,new Date(to).toISOString());
 assert.equal(second?.status,'empty');assert.equal(posted.filter(name=>name===(kind==='quiz'?'overview':'masterclass')).length,1);
 assert.equal(posted.length,kind==='quiz'?5:1);
 const done=(await worker.query('SELECT status,pagination_complete,rows_written FROM sync_runs WHERE id=$1',[pendingRun.id])).rows[0];
 assert.equal(done.status,'empty');assert.equal(done.pagination_complete,true);assert.equal(done.rows_written,kind==='quiz'?3:1);
 const profile=kind==='quiz'?postHogScopeProfile(POSTHOG_DEFAULT_SCOPE,POSTHOG_DEFAULT_CLIENT):postHogMasterclassProfile(POSTHOG_DEFAULT_CLIENT);
 const window=await rpc<any>(worker,'cockpit_source_window',{p_source:'posthog',p_namespace:'123',p_stream:stream,p_profile:profile,p_from:'2026-09-02',p_to:'2026-09-04',p_timezone:'Europe/Paris',p_currency:null,p_currency_exponent:null,p_kind:'exact_report'});
 assert.equal(window.exactRunId,pendingRun.id);assert.equal(window.aggregates.length,kind==='quiz'?3:1);
});


test('recovery lookup reservations are monotonic and malformed counters cannot corrupt the checkpoint',async()=>{
 const c=await claim(worker,'lookup-slots-v1');const first={...continuation(),lookupAttempts:1,registered:false};
 await save(worker,c,'overview',first);
 for(const bad of [{...first,lookupAttempts:0},{...first,lookupAttempts:4},{...first,lookupAttempts:null},{...first,registered:null},{...first,id:null},{...first,queryHash:null},{...first,startedAt:null}]){
  await assert.rejects(save(worker,c,'overview',bad as any));
 }
 await save(worker,c,'overview',{...first,lookupAttempts:3,registered:true});
 await assert.rejects(save(worker,c,'overview',{...first,lookupAttempts:3,registered:false}),{code:'55000'});
 const row=(await worker.query('SELECT checkpoint FROM sync_runs WHERE id=$1',[c.runId])).rows[0];
 assert.equal(row.checkpoint.queries.overview.continuation.lookupAttempts,3);assert.equal(row.checkpoint.queries.overview.continuation.registered,true);
});


test('a row lock held beyond lease expiry cannot authorize save, release or publication',async()=>{
 for(const operation of ['save','release','publish']){
  const c=await claim(worker,'lock-expiry-'+operation);c.profile='lock-expiry-'+operation;await allComplete(c);
  await worker.query("UPDATE sync_runs SET lease_until=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",[c.runId]);
  await worker.query('BEGIN');await worker.query('SELECT id FROM sync_runs WHERE id=$1 FOR UPDATE',[c.runId]);
  const waiting=operation==='save'?save(other,c,'overview',continuation(),true):operation==='release'?rpc(other,'cockpit_release_posthog',{p_run:c.runId,p_lease:c.lease,p_error:null}):publish(other,c,[record(c)],0);
  const rejected=assert.rejects(waiting,{code:'55000'});
  await new Promise(resolve=>setTimeout(resolve,250));await worker.query('COMMIT');await rejected;
  assert.equal((await worker.query('SELECT count(*)::int n FROM source_aggregates WHERE sync_run_id=$1',[c.runId])).rows[0].n,0);
 }
 const c=await claim(worker,'claim-lock-expiry');
 await worker.query("UPDATE sync_runs SET lease_until=clock_timestamp(),checkpoint=jsonb_set(checkpoint,'{expiresAt}',to_jsonb(clock_timestamp()+interval '150 milliseconds')) WHERE id=$1",[c.runId]);
 await worker.query('BEGIN');await worker.query('SELECT id FROM sync_runs WHERE id=$1 FOR UPDATE',[c.runId]);
 const waiting=claim(other,'claim-lock-expiry');await new Promise(resolve=>setTimeout(resolve,250));await worker.query('COMMIT');
 assert.equal((await waiting).reason,'POSTHOG_QUERY_EXPIRED');
});


test('a killed process after accepted POST resumes the durable ID in a new worker',async()=>{
 const namespace='987',env={POSTHOG_HOST:'https://eu.posthog.com',POSTHOG_PROJECT_ID:namespace,POSTHOG_PERSONAL_API_KEY:'synthetic-local-only'};
 const script=`import {synchronizePostHogReport} from ${JSON.stringify(pathToFileURL(resolve('src/lib/sync-posthog-reports.ts')).href)};
 import {postgresDatabase} from ${JSON.stringify(pathToFileURL(resolve('src/lib/db.ts')).href)};
 await synchronizePostHogReport('masterclass','2026-09-02','2026-09-04',{db:postgresDatabase(${JSON.stringify(targetUrl.href)}),env:${JSON.stringify(env)},fetcher:async(url,init)=>{
  if(init?.method==='POST'){process.send({id:JSON.parse(init.body).client_query_id});return new Promise(()=>{});}
  if(String(url).includes('property_definitions'))return Response.json({results:[{name:'$host',property_type:'String'},{name:'$current_url',property_type:'String'}]});
  return Response.json({id:987});
 }});`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{stdio:['ignore','ignore','pipe','ipc']});
 let diagnostics='';child.stderr?.on('data',data=>{diagnostics+=String(data).slice(0,500);});
 const exit=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
 let id:string;
 try{id=await new Promise<string>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('child did not submit: '+diagnostics)),10000);child.once('message',message=>{clearTimeout(timer);resolve((message as {id:string}).id);});child.once('error',error=>{clearTimeout(timer);reject(error);});});}
 finally{child.kill('SIGKILL');await exit;}
 const row=(await worker.query('SELECT id,checkpoint FROM sync_runs WHERE source_namespace=$1',[namespace])).rows[0];
 assert.equal(row.checkpoint.queries.masterclass.continuation.id,id!);assert.equal(row.checkpoint.queries.masterclass.complete,false);
 await worker.query("UPDATE sync_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[row.id]);
 let gets=0;
 const report=await synchronizePostHogReport('masterclass','2026-09-02','2026-09-04',{db:postgresDatabase(targetUrl.href),env,fetcher:async(url,init)=>{
  assert.notEqual(init?.method,'POST','the new process must recover the accepted ID');
  if(String(url).includes('property_definitions'))return Response.json({results:[{name:'$host',property_type:'String'},{name:'$current_url',property_type:'String'}]});
  if(String(url).includes('/query/')){gets++;assert.ok(String(url).endsWith('/'+id+'/'));return Response.json({query_status:{id,complete:true,results:{columns:['event','events','visitors','kit_sessions','events_with_visitor_id','events_with_kit_session_id','verified_host_events','unlocated_events','excluded_events'],results:[]}}});}
  return Response.json({id:987});
 }});
 assert.equal(report?.status,'empty');assert.equal(gets,1);
 assert.equal((await worker.query('SELECT status FROM sync_runs WHERE id=$1',[row.id])).rows[0].status,'empty');
});
