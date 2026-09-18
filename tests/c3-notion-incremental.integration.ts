import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import {readFileSync,readdirSync} from 'node:fs';
import {synchronizeNotionChunk} from '../src/lib/sync-notion-business';
import {BLG_NOTION_FIELDS} from '../src/connectors/notion';
import type {Database,Row} from '../src/lib/db';
const base=new URL(process.env.TEST_DATABASE_URL||'postgresql://localhost:55440/postgres');
if(!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw Error('LOCAL_ONLY');
const dbName='c3_delta_'+Date.now(),admin=new Client({connectionString:base.href}),target=new URL(base);target.pathname='/'+dbName;
let sql:Client;const proof={digest:'a'.repeat(64),deltaSafe:true};
const rpc=async<T=any>(name:string,args:Row):Promise<T>=>{const keys=Object.keys(args);return (await sql.query(`SELECT public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) AS x`,Object.values(args).map(v=>typeof v==='object'&&v!==null?JSON.stringify(v):v))).rows[0].x;};
const db:Database={rpc,select:async()=>[],upsert:async()=>assert.fail('RPC only'),probe:async()=>{}};
before(async()=>{await admin.connect();await admin.query(`CREATE DATABASE ${dbName}`);sql=new Client({connectionString:target.href});await sql.connect();for(const f of readdirSync('supabase/migrations').filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort())await sql.query(readFileSync('supabase/migrations/'+f,'utf8'));});
after(async()=>{await sql?.end();await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);await admin.end();});
const ns='22222222-2222-4222-8222-222222222222';
const makeRow=(index:number)=>({id:`11111111-1111-4111-8111-${index.toString(16).padStart(12,'0')}`,created_time:new Date(Date.parse('2026-01-02T00:00:00Z')+index*1500000).toISOString(),last_edited_time:'2026-01-02T00:00:00Z',properties:{'Nom complet':{id:'name',title:[{plain_text:'Synthetic'}]},Etat:{id:'status',select:{name:'RDV Programmé'}},Clients:{id:'clients',relation:[] as {id:string}[],has_more:false},"Groupe d'état Noshow":{id:'attendance',formula:{type:'string',string:''}},'Date acquisition reelle':{date:{start:'2026-01-02'}},'Date du RDV':{date:{start:'2026-09-22'}},'Réservation faite le':{date:{start:'2026-09-01'}}}});
let source=Array.from({length:3},(_,i)=>makeRow(i));let requests=0,inventoryRequests=0,responseBytes=0;
const fetcher:typeof fetch=async(url,init)=>{
 requests++;const body=JSON.parse(String(init?.body)),stamp=body.filter.and[0].timestamp,lo=Date.parse(body.filter.and[0][stamp].on_or_after),hi=Date.parse(body.filter.and[1][stamp].before);
 const inventory=new URL(String(url)).searchParams.getAll('filter_properties[]').length===2;if(inventory)inventoryRequests++;
 const filtered=source.filter(row=>Date.parse(row[stamp as 'created_time'|'last_edited_time'])>=lo&&Date.parse(row[stamp as 'created_time'|'last_edited_time'])<hi).sort((a,b)=>String(a[stamp as 'created_time']).localeCompare(String(b[stamp as 'created_time']))).slice(0,10000);
 const offset=Number(body.start_cursor??0),more=offset+100<filtered.length;
 const payload={results:filtered.slice(offset,offset+100).map(row=>inventory?{...row,properties:{Clients:row.properties.Clients,"Groupe d'état Noshow":row.properties["Groupe d'état Noshow"]}}:row),has_more:more,next_cursor:more?String(offset+100):null};responseBytes+=Buffer.byteLength(JSON.stringify(payload));return Response.json(payload);
};
const env=(namespace=ns)=>({COCKPIT_MODE:'live',NOTION_TOKEN:'synthetic',NOTION_DATA_SOURCE_ID:namespace,IDENTITY_HMAC_SECRET:'synthetic-secret-at-least-32-characters'});
const worker=(maxPages=5,namespace=ns)=>synchronizeNotionChunk({db,env:env(namespace),fetcher,maxPages,schemaReader:async()=>({proof,fields:BLG_NOTION_FIELDS})});
const finish=async(namespace=ns)=>{for(let i=0;i<300;i++){const result=await worker(5,namespace);if(result.status!=='partial')return result;}throw Error('bounded test did not complete');};
const mirror=async(namespace=ns)=>(await sql.query('SELECT external_id,source_status,archived,business,sync_run_id FROM prospects WHERE source_namespace=$1 ORDER BY external_id',[namespace])).rows;
const roll=async(namespace=ns)=>rpc<any>('cockpit_business_rollup',{p_namespace:namespace,p_from:'2026-01-01',p_to:'2027-01-01'});
test('delta stages, resumes, retains unchanged rows/history, reconciles omissions only after complete inventory',async()=>{
 assert.equal((await finish()).status,'complete');const old=await mirror();assert.equal(old.length,3);assert.equal((await roll()).appointments.total,3);
 const bound=(await sql.query("SELECT period_to FROM sync_runs WHERE source_namespace=$1 ORDER BY started_at DESC LIMIT 1",[ns])).rows[0].period_to;
 source[0].last_edited_time=new Date(Date.parse(bound)-30000).toISOString();source[0].properties.Etat.select.name='RDV Annulé';source=source.filter((_,i)=>i!==1);
 const partial=await worker(1);assert.equal(partial.status,'partial');assert.deepEqual(await mirror(),old,'no partial CRM publication');
 const completed=await finish();assert.equal(completed.status,'complete');assert.equal(completed.coverage.mode,'delta');assert.ok(inventoryRequests>0);
 const current=await mirror();assert.equal(current[0].source_status,'RDV Annulé');assert.equal(current[1].archived,true);assert.equal(current[2].sync_run_id,old[2].sync_run_id,'unchanged record is not rewritten');
 const summary=await roll();assert.equal(summary.sourceRows,2);assert.equal(summary.leads.rows,3);assert.equal(summary.leads.archivedRows,1);assert.equal(summary.appointments.cancelled,1);assert.ok(summary.inventoryThrough);
 const afterHistory=(await sql.query('SELECT count(*) n FROM commercial_history')).rows[0].n;
 await finish();assert.equal((await sql.query('SELECT count(*) n FROM commercial_history')).rows[0].n,afterHistory,'overlap replay adds no duplicate history');
});
test('relation changes without a parent edit are detected by hourly dependency projection',async()=>{
 source[1].properties.Clients.relation=[{id:'33333333-3333-4333-8333-333333333333'}];
 assert.equal((await finish()).status,'complete');assert.deepEqual((await mirror())[2].business.clientIds,['33333333-3333-4333-8333-333333333333']);
});
test('deletion after delta read is only applied after inventory, and formula drift forces full recovery',async()=>{
 const old=await mirror();const kept=source[1];
 const bound=(await sql.query("SELECT period_to FROM sync_runs WHERE source_namespace=$1 ORDER BY started_at DESC LIMIT 1",[ns])).rows[0].period_to;
 source[0].last_edited_time=new Date(Date.parse(bound)-10000).toISOString();
 assert.equal((await worker(1)).status,'partial');source=source.slice(1);
 await finish();assert.equal((await mirror())[0].archived,true,'a staged delta row absent from terminal inventory is archived');
 const before=await mirror();source[0].properties["Groupe d'état Noshow"].formula.string='Show up';
 const failed=await finish();assert.equal(failed.status,'failed');assert.equal(failed.coverage.reason,'DELTA_INVENTORY_GAP');assert.deepEqual(await mirror(),before,'formula drift cannot partially change published values');
 const recovered=await finish();assert.equal(recovered.coverage.mode,'full');assert.equal(recovered.status,'complete');
 source[0].properties["Groupe d'état Noshow"].formula.string='';await finish();await finish();
});
test('lease expires, page replay is idempotent, conflicting replay is rejected and checkpoint remains',async()=>{
 const namespace='lease-fixture';const args={p_namespace:namespace,p_profile:'v1',p_schema:proof};const claim=await rpc('cockpit_claim_notion',args);
 assert.equal((await rpc('cockpit_claim_notion',args)).busy,true);
 const stage={p_run:claim.runId,p_lease:claim.lease,p_records:[],p_read:0,p_checkpoint:{intervals:claim.checkpoint.intervals,page:1}};
 await rpc('cockpit_stage_notion',stage);await rpc('cockpit_stage_notion',stage);
 assert.equal((await sql.query('SELECT rows_read FROM sync_runs WHERE id=$1',[claim.runId])).rows[0].rows_read,0);
 await assert.rejects(rpc('cockpit_stage_notion',{...stage,p_read:1}),{code:'55000'});
 await sql.query("UPDATE sync_runs SET lease_until=now()-interval '1 second' WHERE id=$1",[claim.runId]);
 const resumed=await rpc('cockpit_claim_notion',args);assert.equal(resumed.runId,claim.runId);assert.notEqual(resumed.lease,claim.lease);assert.equal(resumed.checkpoint.page,1);
 await assert.rejects(rpc('cockpit_publish_notion',{p_run:claim.runId,p_lease:claim.lease}),{code:'55000'});
});
test('more than 10000 rows reach publication across interval splits and persisted worker invocations',async()=>{
 source=Array.from({length:12050},(_,i)=>makeRow(i));requests=0;inventoryRequests=0;responseBytes=0;
 const namespace='44444444-4444-4444-8444-444444444444';const result=await finish(namespace);
 assert.equal(result.status,'complete');assert.equal((await mirror(namespace)).length,12050);assert.equal((await roll(namespace)).sourceRows,12050);assert.ok(requests>120);
 const published=(await sql.query("SELECT checkpoint FROM sync_runs WHERE source_namespace=$1 ORDER BY started_at DESC LIMIT 1",[namespace])).rows[0].checkpoint;assert.ok(published.completedThrough);assert.deepEqual(published.intervals,[]);
 const readsBefore=requests,bytesBefore=responseBytes;await finish(namespace);assert.ok(inventoryRequests>=121);assert.ok(requests-readsBefore<140,'delta full rows are replaced by thin inventory requests');assert.equal((await roll(namespace)).sourceRows,12050);assert.ok(responseBytes-bytesBefore<bytesBefore);console.log(JSON.stringify({synthetic:true,rows:12050,initialRequests:readsBefore,deltaRequests:requests-readsBefore,initialResponseBytes:bytesBefore,deltaResponseBytes:responseBytes-bytesBefore}));
});
test('new RPC remains private; old/new rollup counts agree for the same fully published synthetic mirror',async()=>{
 for(const role of ['anon','authenticated']){
  const allowed=(await sql.query("SELECT has_function_privilege($1,'public.cockpit_claim_notion(text,text,jsonb)','EXECUTE') allowed",[role])).rows[0].allowed;assert.equal(allowed,false);
 }
 const old=readFileSync('supabase/migrations/007_business_metrics_and_resumable_imports.sql','utf8');const start=old.indexOf('CREATE FUNCTION public.cockpit_business_rollup'),end=old.indexOf('DO $$ DECLARE f record',start);
 await sql.query(old.slice(start,end).replace('public.cockpit_business_rollup','public.c3_old_business_rollup'));
 const namespace='44444444-4444-4444-8444-444444444444';
 // Request a full pass through the legacy claim to compare equal source snapshots.
 const c=await rpc('cockpit_claim_notion',{p_namespace:namespace,p_profile:'notion-acquisition-known-v1'});await rpc('cockpit_release_notion',{p_run:c.runId,p_lease:c.lease,p_error:null});await finish(namespace);
 const fresh=await roll(namespace),baseline=await rpc<any>('c3_old_business_rollup',{p_namespace:namespace,p_from:'2026-01-01',p_to:'2027-01-01'});
 // Old rollup intentionally loses unchanged rows with its latest-run filter; emulate
 // a legacy rewrite on a rollback-only transaction for an exact old/new comparison.
 await sql.query('BEGIN');try{await sql.query("UPDATE prospects SET sync_run_id=(SELECT id FROM sync_runs WHERE source_namespace=$1 AND status IN ('complete','empty') ORDER BY finished_at DESC LIMIT 1) WHERE source_namespace=$1 AND NOT archived",[namespace]);const expected=await rpc<any>('c3_old_business_rollup',{p_namespace:namespace,p_from:'2026-01-01',p_to:'2027-01-01'});for(const key of ['sourceRows','leads','appointments'])assert.deepEqual(fresh[key],expected[key]);}finally{await sql.query('ROLLBACK');}
 assert.ok(baseline.sourceRows<=fresh.sourceRows);
});
