import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { postgresDatabase, type Database, type Row } from '../src/lib/db';
import { checkpointParts } from '../src/lib/sync-notion-commerce';
import { checkpointContentRows, checkpointRolloutBatch, stageCheckpointContent } from '../src/lib/checkpoint-content-store';

// This executable procedure creates only disposable loopback databases.
// It cannot target Supabase or use any real environment/config file.
const base=new URL(process.env.TEST_DATABASE_URL||'postgresql://localhost:55440/postgres');
if(!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw Error('LOCAL_ONLY');
const admin=new Client({connectionString:base.href}),stamp=Date.now();
const names=[`checkpoint_rollout_legacy_${stamp}`,`checkpoint_rollout_compact_${stamp}`];
type Local={sql:Client;db:Database;runs:string[];url:string};const local:Local[]=[];
const profile='synthetic-comparable-v1',namespace='synthetic-comparable',startedAt='2026-09-01T12:00:00Z';
const sha=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const corpus=Array.from({length:8},(_,i)=>JSON.stringify({version:1,profile,startedAt,pages:500+i,completedAt:`2026-09-01T12:00:0${i}Z`,
 snapshot:{clients:Array.from({length:300},(_,j)=>({id:`synthetic-${String(j).padStart(4,'0')}`,emailKey:null,emailBisKey:null,startedDay:'2024-01-01',prospectIds:[],binome:false,text:`unicode é 😀 retained ${j}`,amountMinor:j%3===0?null:10000,ordered:[null,1,1,'1',false]})),payments:[],schedules:[],parcours:[],sourceCounts:{clients:300}}}));
before(async()=>{
 await admin.connect();assert.equal((await admin.query('SHOW server_version_num')).rows[0].server_version_num.slice(0,2),'17');
 for(const name of names)await createLocal(name);
});
async function createLocal(name:string){
 await admin.query(`CREATE DATABASE ${name}`);const target=new URL(base);target.pathname='/'+name;
 const sql=new Client({connectionString:target.href});await sql.connect();
 for(const file of fs.readdirSync('supabase/migrations').filter(f=>/^\d{3}_.*\.sql$/.test(f)&&Number(f.slice(0,3))<=23).sort())await sql.query(fs.readFileSync('supabase/migrations/'+file,'utf8'));
 await sql.query(fs.readFileSync('supabase/migrations/026_checkpoint_content_storage.sql','utf8'));
 const env={sql,db:postgresDatabase(target.href),runs:[],url:target.href};local.push(env);return env;
}
after(async()=>{for(const env of local)await env.sql.end();await new Promise(r=>setTimeout(r,5500));for(const name of names)await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();});
async function write(env:Local,serialized:string,compact:boolean,preparedParts?:string[]){
 const run=await env.db.rpc<string>('begin_sync_stream',{p_source:'notion',p_namespace:namespace,p_from:'1970-01-01T00:00:00Z',p_to:'2026-09-02T12:00:00Z',p_profile:profile,p_coverage_kind:'source_snapshot',p_stream:'commerce_reader_checkpoint'});
 const parts=preparedParts??checkpointParts(serialized);
 if(compact)await stageCheckpointContent(env.db,{runId:run,profile,startedAt,serialized,parts});
 else await env.db.upsert('source_aggregates',parts.map((part,index)=>({source:'notion',source_namespace:namespace,metric_key:'notion_commerce_checkpoint',period_from:'1970-01-01T00:00:00Z',period_to:startedAt,dimensions_key:'checkpoint:'+String(index).padStart(6,'0'),report_profile_key:profile,sync_run_id:run,timezone:'Europe/Paris',coverage_state:'partial',value:1,unit:'count',currency:null,currency_exponent:null,tax_basis:'unknown',dimensions:{index,total:parts.length,hash:sha(serialized),part},definition_version:profile,source_locator:'notion:commerce-reader-checkpoint'})),'source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id');
 await env.db.rpc('finish_sync',{p_run:run,p_status:'complete',p_read:300,p_rejected:0,p_complete:true,p_error:null});env.runs.push(run);return run;
}
async function serialized(env:Local,run:string){let result='';for(let offset=0;offset<10000;offset+=1000){const rows=await checkpointContentRows(env.db,run,offset);result+=rows.map(r=>(r.dimensions as Row).part).join('');if(rows.length<1000)break;}return result;}
async function measure(env:Local){return (await env.sql.query(`SELECT
 pg_relation_size('source_aggregates')::text aggregate_heap,
 pg_indexes_size('source_aggregates')::text aggregate_indexes,
 pg_total_relation_size('source_aggregates')::text aggregate_total,
 pg_total_relation_size('commerce_checkpoint_part_contents')::text content_total,
 (pg_total_relation_size('source_aggregates')+pg_total_relation_size('commerce_checkpoint_part_contents'))::text checkpoint_storage_total,
 pg_total_relation_size('sync_runs')::text run_table_total,
 pg_current_wal_insert_lsn()::text wal_lsn,
 (SELECT count(*)::int FROM source_aggregates) logical_references,
 (SELECT coalesce(sum(pg_column_size(a)),0)::text FROM source_aggregates a) reference_row_bytes,
 (SELECT coalesce(sum(pg_column_size(dimensions)),0)::text FROM source_aggregates) reference_dimensions_bytes,
 (SELECT count(*)::int FROM commerce_checkpoint_part_contents) content_rows,
 (SELECT sum(octet_length(part))::text FROM commerce_checkpoint_part_contents) unique_part_utf8_bytes`)).rows[0];}

test('same eight synthetic runs/corpus: measure legacy vs compact allocated table/index and WAL, no production extrapolation',async()=>{
 const comparison:Row[]=[];
 for(const [index,env] of local.entries()){
  const compact=index===1;if(compact)await env.sql.query("SELECT cockpit_checkpoint_storage_mode('compact')");
  const before=await measure(env);
  for(const document of corpus)await write(env,document,compact);
  const after=await measure(env),wal=(await env.sql.query('SELECT pg_wal_lsn_diff($1,$2)::text bytes',[after.wal_lsn,before.wal_lsn])).rows[0].bytes;
  for(const [i,run] of env.runs.entries())assert.equal(await serialized(env,run),corpus[i]);
  comparison.push({mode:compact?'compact':'legacy',runs:8,corpus_sha256:sha(JSON.stringify(corpus)),total_serialized_utf8_bytes:corpus.reduce((n,s)=>n+Buffer.byteLength(s,'utf8'),0),
   before,after,write_wal_bytes:wal,allocated_checkpoint_storage_growth:Number(after.checkpoint_storage_total)-Number(before.checkpoint_storage_total)});
 }
 assert.equal(comparison[0].corpus_sha256,comparison[1].corpus_sha256);
 assert.equal((comparison[0].after as Row).logical_references,(comparison[1].after as Row).logical_references);
 console.log(JSON.stringify({syntheticComparison:comparison,limits:'Identical synthetic corpus/runs and schema/indexes, separate disposable PG17 databases. WAL is server-level sequential interval on the isolated server. Allocated bytes include indexes/toast/free pages, no VACUUM/compaction. No real gain/extrapolation.'}));
});

test('executable bounded dry-run → freeze/convert → compact new write → freeze/rollback covers every new checkpoint',async()=>{
 const env=local[0],ledger:Row[]=[];
 const dry=await checkpointRolloutBatch(env.db,env.runs,{onManifest:async m=>{ledger.push(m);}});
 assert.equal(dry.runs.length,8);assert.ok(ledger.every(m=>m.dryRun===true));
 await assert.rejects(checkpointRolloutBatch(env.db,env.runs,{phase:'convert',expected:dry}),'no conversion without DB frozen fence');
 await env.sql.query("SELECT cockpit_checkpoint_storage_mode('frozen')");
 await checkpointRolloutBatch(env.db,env.runs,{phase:'convert',expected:dry,onManifest:async m=>{ledger.push(m);}});
 assert.ok(ledger.every(m=>m.equivalent===true));
 for(const [i,run] of env.runs.entries())assert.equal(await serialized(env,run),corpus[i]);
 await env.sql.query("SELECT cockpit_checkpoint_storage_mode('compact')");
 const newestDocument=JSON.stringify({newAfterCutover:true,nullValue:null,duplicated:[1,1],unicode:'é 😀',body:'new retained'.repeat(800)});
 const newRun=await write(env,newestDocument,true);
 await env.sql.query("SELECT cockpit_checkpoint_storage_mode('frozen')");
 // Reinventory after cutover, rather than replaying the original eight-run plan.
 const actualRuns=(await env.sql.query("SELECT id FROM sync_runs WHERE source='notion' AND stream_key='commerce_reader_checkpoint' AND status<>'running' ORDER BY started_at,id")).rows.map(r=>String(r.id));
 assert.equal(actualRuns.length,9);assert.ok(actualRuns.includes(newRun));
 for(let offset=0;offset<actualRuns.length;offset+=8){
  const ids=actualRuns.slice(offset,offset+8),current=await checkpointRolloutBatch(env.db,ids);
  await checkpointRolloutBatch(env.db,ids,{phase:'rollback',expected:current,onManifest:async m=>{ledger.push(m);}});
 }
 assert.equal((await env.sql.query('SELECT count(*)::int n FROM source_aggregates WHERE checkpoint_part_id IS NOT NULL')).rows[0].n,0);
 assert.equal(await serialized(env,newRun),newestDocument);
 // Original reader (inline part) is usable again only after every retained ref restored.
 for(const [i,run] of env.runs.entries()){
  const raw=(await env.sql.query("SELECT dimensions->>'part' part FROM source_aggregates WHERE sync_run_id=$1 ORDER BY dimensions_key",[run])).rows.map(r=>r.part).join('');
  assert.equal(raw,i<corpus.length?corpus[i]:newestDocument);
 }
 await env.sql.query("SELECT cockpit_checkpoint_storage_mode('compatible')");
 console.log(JSON.stringify({rolloutReceipt:{dryRunRuns:dry.runs.length,retainedRunsAfterCutover:actualRuns.length,newRunIncluded:true,rollbackLogicalEquality:true,allReferenceUUIDsPreserved:true,ledgerEntries:ledger.length,productionActions:0}}));
});

test('exclusive mode transition waits for in-flight write transaction; wrong expected manifest fails before conversion',async()=>{
 const env=local[1],left=new Client({connectionString:env.url});
 await left.connect();try{
  await left.query('BEGIN');await left.query('SELECT pg_advisory_xact_lock_shared(26,61008)');
  await env.sql.query("SET statement_timeout='75ms'");
  await assert.rejects(env.sql.query("SELECT cockpit_checkpoint_storage_mode('frozen')"),e=>(e as {code?:string}).code==='57014');
  assert.equal((await env.sql.query('SELECT mode FROM commerce_checkpoint_storage_control')).rows[0].mode,'compact');
  await left.query('COMMIT');await env.sql.query("SET statement_timeout='5s'");await env.sql.query("SELECT cockpit_checkpoint_storage_mode('frozen')");
  const ids=env.runs.slice(0,1),plan=await checkpointRolloutBatch(env.db,ids);plan.runs[0].logicalRowsHash='a'.repeat(64);
  const before=await measure(env);await assert.rejects(checkpointRolloutBatch(env.db,ids,{phase:'convert',expected:plan}),/CHECKPOINT_ROLLOUT_SOURCE_CHANGED/);
  assert.equal((await measure(env)).content_rows,before.content_rows);
 }finally{await left.query('ROLLBACK').catch(()=>undefined);await left.end();}
});


test('larger partially compressible corpus: at least 8000 references, identical UTF8 payload and runs in both modes',async()=>{
 // Common structure plus deterministic high-entropy text; no tuning to a desired ratio.
 const first=JSON.stringify({version:1,profile,startedAt,pages:500,completedAt:'2026-09-01T12:00:00Z',
  snapshot:{clients:Array.from({length:5000},(_,j)=>({id:`synthetic-${String(j).padStart(5,'0')}`,emailKey:null,emailBisKey:null,startedDay:'2024-01-01',prospectIds:[],binome:false,
   text:'unicode é 😀 retained '+Array.from({length:12},(_,block)=>createHash('sha256').update(`synthetic-entity-${j}-block-${block}`).digest('base64')).join(''),
   amountMinor:j%3===0?null:10000,ordered:[null,1,1,'1',false]})),payments:[],schedules:[],parcours:[],sourceCounts:{clients:5000}}});
 const documents=Array.from({length:8},(_,i)=>first.replace('"pages":500','"pages":'+(500+i)).replace('"completedAt":"2026-09-01T12:00:00Z"','"completedAt":"2026-09-01T12:00:0'+i+'Z"'));
 const firstParts=checkpointParts(first),allParts=documents.map((document,i)=>firstParts.map((part,index)=>index===0?part.replace('"pages":500','"pages":'+(500+i)).replace('"completedAt":"2026-09-01T12:00:00Z"','"completedAt":"2026-09-01T12:00:0'+i+'Z"'):part));
 allParts.forEach((parts,i)=>assert.equal(parts.join(''),documents[i]));
 assert.ok(firstParts.length*8>=8000);assert.ok(firstParts.length<=10000);
 const comparison:Row[]=[];
 for(const compact of [false,true]){
  const name=`checkpoint_rollout_large_${compact?'compact':'legacy'}_${stamp}`;names.push(name);const env=await createLocal(name);
  if(compact)await env.sql.query("SELECT cockpit_checkpoint_storage_mode('compact')");
  const before=await measure(env);
  for(const [i,document] of documents.entries())await write(env,document,compact,allParts[i]);
  const after=await measure(env),wal=(await env.sql.query('SELECT pg_wal_lsn_diff($1,$2)::text bytes',[after.wal_lsn,before.wal_lsn])).rows[0].bytes;
  for(const [i,run] of env.runs.entries())assert.equal(await serialized(env,run),documents[i]);
  comparison.push({mode:compact?'compact':'legacy',runs:8,entitiesPerRun:5000,partsPerRun:firstParts.length,corpus_sha256:sha(JSON.stringify(documents)),
   total_serialized_utf8_bytes:documents.reduce((n,s)=>n+Buffer.byteLength(s,'utf8'),0),before,after,write_wal_bytes:wal,
   allocated_checkpoint_storage_growth:Number(after.checkpoint_storage_total)-Number(before.checkpoint_storage_total)});
 }
 assert.equal(comparison[0].corpus_sha256,comparison[1].corpus_sha256);
 assert.equal((comparison[0].after as Row).logical_references,(comparison[1].after as Row).logical_references);
 console.log(JSON.stringify({largerSyntheticComparison:comparison,limits:'Synthetic generated entities only. Same text/runs/schema and exact reconstruction in each mode. Server-level sequential WAL on isolated PG17; no other tests concurrently. Allocated relation sizes are not live payload bytes or production savings.'}));
});
