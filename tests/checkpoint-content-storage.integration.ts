import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { postgresDatabase, type Database, type Row } from '../src/lib/db';
import { checkpointParts, refreshNotionCommerce } from '../src/lib/sync-notion-commerce';
import { notionCommerceProfile } from '../src/connectors/notion-commerce';
import { checkpointBackfillManifest, checkpointContentRows, stageCheckpointContent } from '../src/lib/checkpoint-content-store';

// Explicit local URL only, disposable database, synthetic data, no env file.
const base = new URL(process.env.TEST_DATABASE_URL || 'postgresql://localhost:55440/postgres');
if (!['localhost','127.0.0.1','[::1]'].includes(base.hostname)) throw Error('LOCAL_ONLY');
const name = 'checkpoint_content_' + Date.now(), target = new URL(base); target.pathname = '/' + name;
const admin = new Client({connectionString:base.href});let sql:Client, db:Database;
const migration='supabase/migrations/026_checkpoint_content_storage.sql';
const profile='synthetic-checkpoint-profile',startedAt='2026-09-01T12:00:00Z';
const hash=(s:string)=>createHash('sha256').update(s,'utf8').digest('hex');
const one=async(q:string,v:unknown[]=[])=> (await sql.query(q,v)).rows[0];
before(async()=>{
 await admin.connect();assert.equal((await admin.query('SHOW server_version_num')).rows[0].server_version_num.slice(0,2),'17');
 await admin.query(`CREATE DATABASE ${name}`);sql=new Client({connectionString:target.href});await sql.connect();
 for(const f of fs.readdirSync('supabase/migrations').filter(f=>/^\d{3}_.*\.sql$/.test(f)&&Number(f.slice(0,3))<=23).sort())await sql.query(fs.readFileSync('supabase/migrations/'+f,'utf8'));
 try { await sql.query(fs.readFileSync(migration,'utf8')); } catch (e) { console.log('migration diagnostic', e); throw e; } db=postgresDatabase(target.href);
 await sql.query(`CREATE TABLE content_writes(id uuid);CREATE TABLE checkpoint_updates(id uuid);
 CREATE FUNCTION audit_checkpoint_content() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO content_writes VALUES(NEW.id);RETURN NEW;END $$;
 CREATE TRIGGER content_written AFTER INSERT ON commerce_checkpoint_part_contents FOR EACH ROW EXECUTE FUNCTION audit_checkpoint_content();
 CREATE FUNCTION audit_checkpoint_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO checkpoint_updates VALUES(NEW.id);RETURN NEW;END $$;
 CREATE TRIGGER checkpoint_updated AFTER UPDATE ON source_aggregates FOR EACH ROW EXECUTE FUNCTION audit_checkpoint_update();`);
});
after(async()=>{await sql?.end();await new Promise(r=>setTimeout(r,5500));await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();});
async function begin(namespace='synthetic-checkpoint'){
 return db.rpc<string>('begin_sync_stream',{p_source:'notion',p_namespace:namespace,p_from:'1970-01-01T00:00:00Z',p_to:'2026-09-03T12:00:00Z',p_profile:profile,p_coverage_kind:'source_snapshot',p_stream:'commerce_reader_checkpoint'});
}
async function finish(run:string,status='complete') {await db.rpc('finish_sync',{p_run:run,p_status:status,p_read:0,p_rejected:0,p_complete:status==='complete',p_error:null});}
async function stage(run:string,serialized:string,parts=checkpointParts(serialized)) {
 await stageCheckpointContent(db,{runId:run,profile,startedAt,serialized,parts});
}
async function read(run:string){const rows:Row[]=[];for(let offset=0;offset<10000;offset+=1000){const page=await checkpointContentRows(db,run,offset);rows.push(...page);if(page.length<1000)break;}return rows;}
const serializedOf=(rows:Row[])=>rows.map(r=>(r.dimensions as Row).part).join('');
async function legacy(run:string,serialized:string){
 const r=await one('SELECT * FROM sync_runs WHERE id=$1',[run]),parts=checkpointParts(serialized);
 await db.upsert('source_aggregates',parts.map((part,index)=>({source:'notion',source_namespace:r.source_namespace,metric_key:'notion_commerce_checkpoint',period_from:'1970-01-01T00:00:00Z',period_to:startedAt,dimensions_key:'checkpoint:'+String(index).padStart(6,'0'),report_profile_key:profile,sync_run_id:run,timezone:'Europe/Paris',coverage_state:'partial',value:1,unit:'count',currency:null,currency_exponent:null,tax_basis:'unknown',dimensions:{index,total:parts.length,hash:hash(serialized),part},definition_version:profile,source_locator:'notion:commerce-reader-checkpoint'})),'source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id');
}

test('exact UTF8, escaping, null/types/duplicates/order, same-content reuse and zero payload updates on replay',async()=>{
 const serialized=JSON.stringify({version:1,n:null,zero:0,text:'é é 😀 " \\ \n',array:[null,1,1,'1',false],payload:'rugby 😀'.repeat(1500)});
 const run=await begin();await stage(run,serialized);const first=await read(run);
 assert.equal(serializedOf(first),serialized);assert.equal(hash(serializedOf(first)),hash(serialized));assert.deepEqual(JSON.parse(serializedOf(first)),JSON.parse(serialized));
 const ids=first.map(r=>r.id),contentBefore=await one('SELECT count(*)::int n FROM content_writes');
 await sql.query('TRUNCATE checkpoint_updates');await stage(run,serialized);assert.deepEqual((await read(run)).map(r=>r.id),ids);
 assert.equal((await one('SELECT count(*)::int n FROM content_writes')).n,contentBefore.n);assert.equal((await one('SELECT count(*)::int n FROM checkpoint_updates')).n,0);
 await finish(run);await stage(run,serialized); // lost acknowledgement after finish
 const next=await begin();await stage(next,serialized);assert.equal((await one('SELECT count(*)::int n FROM content_writes')).n,contentBefore.n);
 assert.equal((await read(next)).length,first.length);assert.notDeepEqual((await read(next)).map(r=>r.id),ids);await finish(next);
 await assert.rejects(stage(run,serialized+' '));
 assert.equal((await one("SELECT count(*)::int n FROM source_aggregates WHERE sync_run_id=$1 AND dimensions ? 'part'",[next])).n,0);
});

test('hash mismatch, interrupted batch and transaction failure never leave a published partial checkpoint',async()=>{
 const run=await begin('synthetic-errors'),serialized='["'+ 'a'.repeat(3500)+'"]',parts=checkpointParts(serialized);
 await assert.rejects(db.rpc('cockpit_stage_checkpoint_parts',{p_run:run,p_profile:profile,p_started_at:startedAt,p_hash:'a'.repeat(64),p_total:parts.length,p_parts:parts.map((part,index)=>({part,index}))}));
 assert.equal((await read(run)).length,0);
 await db.rpc('cockpit_stage_checkpoint_parts',{p_run:run,p_profile:profile,p_started_at:startedAt,p_hash:hash(serialized),p_total:parts.length,p_parts:[{part:parts[0],index:0}]});
 assert.equal((await one('SELECT status FROM sync_runs WHERE id=$1',[run])).status,'running');assert.equal((await read(run)).length,1);
 await assert.rejects(db.rpc('cockpit_stage_checkpoint_parts',{p_run:run,p_profile:profile,p_started_at:startedAt,p_hash:hash(serialized),p_total:parts.length,p_parts:[{part:parts[1],index:0}]}));
 await stage(run,serialized);await finish(run);assert.equal(serializedOf(await read(run)),serialized);
 const retry=await begin('synthetic-rollback-failure');
 await sql.query(`CREATE FUNCTION reject_synthetic_reference() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_namespace='synthetic-rollback-failure' THEN RAISE EXCEPTION 'injected failure';END IF;RETURN NEW;END $$;CREATE TRIGGER reject_reference BEFORE INSERT ON source_aggregates FOR EACH ROW EXECUTE FUNCTION reject_synthetic_reference();`);
 const before=(await one('SELECT count(*)::int n FROM commerce_checkpoint_part_contents')).n;
 await assert.rejects(stage(retry,'{"unique":"before crash"}'));assert.equal((await read(retry)).length,0);assert.equal((await one('SELECT count(*)::int n FROM commerce_checkpoint_part_contents')).n,before);
 await sql.query('DROP TRIGGER reject_reference ON source_aggregates');await stage(retry,'{"unique":"before crash"}');await finish(retry);
});

test('legacy compatibility, dry run equivalence, original UUIDs and rollback include writes after conversion',async()=>{
 const run=await begin('synthetic-backfill'),serialized=JSON.stringify({cursor:null,complete:false,array:['é',null,3,3],data:'stable'.repeat(1300)});
 await legacy(run,serialized);await finish(run);const original=await read(run);
 const count=(await one('SELECT count(*)::int n FROM commerce_checkpoint_part_contents')).n;
 const dry=await checkpointBackfillManifest(db,run);assert.equal(dry.dryRun,true);assert.equal(dry.equivalent,true);assert.equal(dry.converted,0);
 assert.equal((await one('SELECT count(*)::int n FROM commerce_checkpoint_part_contents')).n,count);
 await sql.query("SELECT cockpit_checkpoint_storage_mode('frozen')");
 const converted=await checkpointBackfillManifest(db,run,{apply:true});assert.equal(converted.logicalRowsHash,dry.logicalRowsHash);assert.deepEqual(await read(run),original);
 assert.equal((await checkpointBackfillManifest(db,run,{apply:true})).converted,0);
 await sql.query("SELECT cockpit_checkpoint_storage_mode('compatible')");
 const newer=await begin('synthetic-backfill');await stage(newer,serialized);await finish(newer);const newerRows=await read(newer);
 await sql.query("SELECT cockpit_checkpoint_storage_mode('frozen')");
 for(const id of [run,newer]){const restore=await checkpointBackfillManifest(db,id,{apply:true,restore:true});assert.equal(restore.equivalent,true);}
 await sql.query("SELECT cockpit_checkpoint_storage_mode('compatible')");
 assert.deepEqual(await read(run),original);assert.deepEqual(await read(newer),newerRows);
 for(const id of [run,newer]){const raw=await sql.query("SELECT to_jsonb(a)-'checkpoint_part_id' logical FROM source_aggregates a WHERE sync_run_id=$1 ORDER BY dimensions_key",[id]);assert.deepEqual(raw.rows.map(r=>r.logical),await read(id));}
 await sql.query(fs.readFileSync(migration,'utf8'));assert.deepEqual(await read(run),original);
});

test('owner fence blocks old inline writers and frozen new writes, allows only exact conversion, and refuses active runs',async()=>{
 const run=await begin('synthetic-fence');
 await assert.rejects(sql.query("SELECT cockpit_checkpoint_storage_mode('compact')"),e=>(e as {code?:string}).code==='55P03');
 await finish(run,'failed');await sql.query("SELECT cockpit_checkpoint_storage_mode('compact')");
 const compactRun=await begin('synthetic-fence'),serialized='{"fenced":"source"}';
 await assert.rejects(legacy(compactRun,serialized));assert.equal((await read(compactRun)).length,0);
 await stage(compactRun,serialized);await finish(compactRun);
 await assert.rejects(checkpointBackfillManifest(db,compactRun,{apply:true,restore:true}));
 await sql.query("SELECT cockpit_checkpoint_storage_mode('frozen')");
 const newRun=await begin('synthetic-fence');await assert.rejects(stage(newRun,serialized));await finish(newRun,'failed');
 await assert.rejects(sql.query('UPDATE source_aggregates SET value=2 WHERE sync_run_id=$1',[compactRun]));
 await assert.rejects(sql.query('DELETE FROM source_aggregates WHERE sync_run_id=$1',[compactRun]));
 const restored=await checkpointBackfillManifest(db,compactRun,{apply:true,restore:true});assert.equal(restored.equivalent,true);
 await assert.rejects(sql.query('SET ROLE service_role; SELECT cockpit_checkpoint_storage_mode(\'compatible\')'));await sql.query('RESET ROLE');
 await sql.query("SELECT cockpit_checkpoint_storage_mode('compatible')");
});

test('two PostgreSQL sessions share one exact content; byte inequality defeats a synthetic hash collision',async()=>{
 const left=new Client({connectionString:target.href}),right=new Client({connectionString:target.href});await Promise.all([left.connect(),right.connect()]);
 try{
  const part='collision-proof 😀';
  const query='SELECT cockpit_checkpoint_content_id($1,$2,$3) id';
  const [a,b]=await Promise.all([left.query(query,['synthetic-concurrency',profile,part]),right.query(query,['synthetic-concurrency',profile,part])]);assert.equal(a.rows[0].id,b.rows[0].id);
  // Test-only corruption simulates a same-hash candidate without claiming a real SHA collision.
  await sql.query('ALTER TABLE commerce_checkpoint_part_contents DROP CONSTRAINT checkpoint_part_exact_hash');
  await sql.query('INSERT INTO commerce_checkpoint_part_contents(source_namespace,report_profile_key,content_hash,part) VALUES($1,$2,$3,$4)',['synthetic-collision',profile,hash(part),'different bytes']);
  const selected=await left.query(query,['synthetic-collision',profile,part]);assert.equal((await one('SELECT part FROM commerce_checkpoint_part_contents WHERE id=$1',[selected.rows[0].id])).part,part);
  await sql.query('ALTER TABLE commerce_checkpoint_part_contents ADD CONSTRAINT checkpoint_part_exact_hash CHECK(content_hash=encode(pg_catalog.sha256(convert_to(part,\'UTF8\')),\'hex\')) NOT VALID');
  await assert.rejects(sql.query('UPDATE commerce_checkpoint_part_contents SET part=part WHERE id=$1',[a.rows[0].id]));
  for(const role of ['anon','authenticated']){assert.equal((await one("SELECT has_function_privilege($1,'cockpit_checkpoint_rows(uuid,integer,integer)','EXECUTE') ok",[role])).ok,false);assert.equal((await one("SELECT has_table_privilege($1,'commerce_checkpoint_part_contents','SELECT') ok",[role])).ok,false);}
 }finally{await Promise.all([left.end(),right.end()]);}
});

test('real compact refresh preserves published baseline, newer checkpoint, archived clients and report-before-marker recovery',async()=>{
 const config={
  clients:{dataSourceId:'cp-clients',fields:{email:'Email',emailBis:'Email 2',started:'Début',prospect:'Prospect',binome:'Binôme'}},
  payments:{dataSourceId:'cp-payments',fields:{client:'Client',email:'Email',date:'Date',amount:'Montant',status:'Statut',provider:'Transaction',invoice:'Facture'}},
  parcours:{dataSourceId:'cp-parcours',fields:{client:'Client',order:'Ordre',format:'Format',start:'Début',closing:'Closing',status:'Statut'}},
 };
 const clientId='11111111-1111-4111-8111-111111111111',calls:string[]=[];
 let archived=false;
 const fetcher:typeof fetch=async input=>{
  const url=new URL(String(input));calls.push(url.pathname);assert.equal(url.hostname,'api.notion.com');
  if(url.pathname===`/v1/pages/${clientId}`)return Response.json({object:'page',id:clientId,archived:true,in_trash:true,last_edited_time:'2026-09-22T15:52:00Z',parent:{type:'data_source_id',data_source_id:config.clients.dataSourceId}});
  const family=url.pathname.includes('cp-clients')?'clients':url.pathname.includes('cp-payments')?'payments':'parcours';
  if(!url.pathname.endsWith('/query'))return Response.json({properties:Object.fromEntries(Object.values(config[family].fields).map((name,i)=>[name,{id:'p'+i}]))});
  const client={id:clientId,properties:{Nom:{type:'title',title:[{plain_text:'Synthetic retained client'}]},Email:{email:null},'Email 2':{email:null},Début:{date:{start:'2024-01-01'}},Prospect:{relation:[]},Binôme:{relation:[]}}};
  const parcours={id:'synthetic-parcours',properties:{Client:{relation:[{id:clientId}]},Ordre:{number:1},Format:{select:{name:'Solo'}},Début:{date:{start:'2024-01-01'}},Closing:{date:null},Statut:{select:{name:'Actif'}}}};
  return Response.json({results:family==='clients'?(archived?[]:[client]):family==='parcours'?[parcours]:[],has_more:false,next_cursor:null});
 };
 const options={db,config,token:'synthetic',identitySecret:'x'.repeat(32),fetcher,maxPages:3};
 assert.equal((await refreshNotionCommerce(options)).coverage,'published');
 const baseline=await one("SELECT id FROM sync_runs WHERE source_namespace=$1 AND stream_key='commerce_reader_checkpoint' ORDER BY finished_at DESC,id DESC LIMIT 1",[config.parcours.dataSourceId]);
 const baselineRows=await read(baseline.id),cp=JSON.parse(serializedOf(baselineRows));assert.ok(cp.completedAt);
 const baselineMarker=await one("SELECT dimensions->>'publishedRunId' id FROM source_aggregates WHERE sync_run_id=$1 AND metric_key='notion_commerce_checkpoint_publication'",[baseline.id]);assert.ok(baselineMarker.id);
 const actualProfile=notionCommerceProfile(config),partial=structuredClone(cp);delete partial.completedAt;partial.familyIndex=1;partial.pages=1;partial.snapshot.clients=[];partial.snapshot.payments=[];partial.snapshot.parcours=[];
 const partialRun=await db.rpc<string>('begin_sync_stream',{p_source:'notion',p_namespace:config.parcours.dataSourceId,p_from:'1970-01-01T00:00:00Z',p_to:new Date().toISOString(),p_profile:actualProfile,p_coverage_kind:'source_snapshot',p_stream:'commerce_reader_checkpoint'});
 const partialSerialized=JSON.stringify(partial);await stageCheckpointContent(db,{runId:partialRun,profile:actualProfile,startedAt:partial.startedAt,serialized:partialSerialized,parts:checkpointParts(partialSerialized)});await finish(partialRun);
 archived=true;calls.length=0;let rejectMarker=true;
 const interruptedDb:Database={...db,upsert:async(table,rows,conflict)=>{if(rejectMarker&&rows.some(r=>r.metric_key==='notion_commerce_checkpoint_publication')){rejectMarker=false;throw Error('synthetic marker crash');}await db.upsert(table,rows,conflict);}};
 // Real finish_sync cannot close an already-complete run again: the original
 // marker error propagates, while its recoverable completed checkpoint remains.
 await assert.rejects(refreshNotionCommerce({...options,db:interruptedDb}),/synthetic marker crash/);
 assert.ok(calls.includes(`/v1/pages/${clientId}`));assert.ok(!calls.includes('/v1/data_sources/cp-clients/query'),'resumed the newer partial, not a fresh source traversal');
 const pending=await one("SELECT id FROM sync_runs WHERE source_namespace=$1 AND stream_key='commerce_reader_checkpoint' ORDER BY finished_at DESC,id DESC LIMIT 1",[config.parcours.dataSourceId]);
 const pendingCp=JSON.parse(serializedOf(await read(pending.id)));assert.equal(pendingCp.retainedArchivedClients[0].sourceCheckpointRunId,baseline.id);
 assert.equal((await one("SELECT count(*)::int n FROM source_aggregates WHERE sync_run_id=$1 AND metric_key='notion_commerce_checkpoint_publication'",[pending.id])).n,0);
 const publishedReport=await one("SELECT id FROM sync_runs WHERE source_namespace=$1 AND stream_key='commerce_declared_snapshot' ORDER BY finished_at DESC,id DESC LIMIT 1",[config.parcours.dataSourceId]);
 calls.length=0;const recovered=await refreshNotionCommerce(options);assert.equal(recovered.coverage,'published');assert.deepEqual(calls,[`/v1/pages/${clientId}`]);
 const newest=await one("SELECT id FROM sync_runs WHERE source_namespace=$1 AND stream_key='commerce_reader_checkpoint' ORDER BY finished_at DESC,id DESC LIMIT 1",[config.parcours.dataSourceId]);
 const recoveredCp=JSON.parse(serializedOf(await read(newest.id)));assert.equal(recoveredCp.retainedArchivedClients[0].sourceCheckpointRunId,baseline.id);
 assert.equal((await one("SELECT dimensions->>'publishedRunId' id FROM source_aggregates WHERE sync_run_id=$1 AND metric_key='notion_commerce_checkpoint_publication'",[newest.id])).id,publishedReport.id);
 assert.deepEqual(await read(baseline.id),baselineRows,'old baseline UUIDs and payloads unchanged');
});

test('mismatched content provenance and missing fragment are rejected rather than silently reconstructed',async()=>{
 const run=await begin('synthetic-bad-reference'),serialized='["'+'b'.repeat(3500)+'"]';await stage(run,serialized);await finish(run);
 const original=await read(run),wrong=await one("SELECT cockpit_checkpoint_content_id('other-namespace',$1,'other') id",[profile]);
 const ref=await one('SELECT checkpoint_part_id FROM source_aggregates WHERE id=$1',[original[0].id]);
 await sql.query('UPDATE source_aggregates SET checkpoint_part_id=$1 WHERE id=$2',[wrong.id,original[0].id]);await assert.rejects(read(run));
 await sql.query('UPDATE source_aggregates SET checkpoint_part_id=$1 WHERE id=$2',[ref.checkpoint_part_id,original[0].id]);
 // Removing a synthetic reference demonstrates a lost fragment: conversion refuses all mutation.
 await sql.query('DELETE FROM source_aggregates WHERE id=$1',[original[1].id]);await assert.rejects(checkpointBackfillManifest(db,run));
});

test('synthetic repeated checkpoint references retain multiplicity while part payload writes stop; physical/WAL evidence only',async()=>{
 const ns='synthetic-volume',serialized=JSON.stringify({stable:'rugby'.repeat(4000)});
 const measure=()=>one("SELECT pg_total_relation_size('source_aggregates')::text aggregate_bytes,pg_total_relation_size('commerce_checkpoint_part_contents')::text content_bytes,pg_current_wal_insert_lsn()::text lsn,(SELECT count(*)::int FROM content_writes) payload_inserts");
 const before=await measure();const initial=await begin(ns);await stage(initial,serialized);await finish(initial);const first=await measure();
 for(let i=0;i<12;i++){const r=await begin(ns);await stage(r,serialized);await finish(r);}
 const after=await measure();assert.equal(after.payload_inserts,first.payload_inserts);
 const rows=await one('SELECT count(*)::int n,count(DISTINCT checkpoint_part_id)::int distinct_contents FROM source_aggregates WHERE source_namespace=$1',[ns]);
 assert.equal(rows.n,checkpointParts(serialized).length*13);assert.ok(rows.distinct_contents<rows.n);
 const wal=await one('SELECT pg_wal_lsn_diff($1,$2)::text bytes',[after.lsn,first.lsn]);
 console.log(JSON.stringify({syntheticOnly:true,checkpoints:13,partsPerCheckpoint:checkpointParts(serialized).length,physicalBefore:before,physicalFirst:first,physicalAfter:after,repeatWalBytes:wal.bytes,logicalReferences:rows.n,distinctContents:rows.distinct_contents,noProductionExtrapolation:true}));
});
