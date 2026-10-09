import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {Client} from 'pg';
import {postgresDatabase,type Database,type Row} from '../src/lib/db';
import {syncKpiSource,readKpiSource,type KpiSourceBatch} from '../src/lib/kpi-source-store';

// Equal synthetic inputs and schema; isolated loopback PG17 only. The public
// production environment/config is never loaded. Run this file alone for WAL.
const base=new URL(process.env.TEST_DATABASE_URL||'postgresql://localhost:55440/postgres');
if(!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw Error('LOCAL_ONLY');
const admin=new Client({connectionString:base.href}),stamp=Date.now();
type Local={name:string;sql:Client;db:Database;toast:string};const locals:Local[]=[];
const from='2026-09-10',to='2026-09-11',ns='synthetic-aggregate-volume';
const hash=(s:string)=>createHash('sha256').update(s,'utf8').digest('hex');
before(async()=>{await admin.connect();assert.equal((await admin.query('SHOW server_version_num')).rows[0].server_version_num.slice(0,2),'17');
 await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN;END IF;IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN;END IF;IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS;END IF;END $$");
});
after(async()=>{for(const l of locals)await l.sql.end();await new Promise(r=>setTimeout(r,5500));for(const l of locals)await admin.query('DROP DATABASE IF EXISTS '+l.name);await admin.end();});
async function create(mode:string,shape:string){const name=`aggregate_volume_${shape}_${mode}_${stamp}`;await admin.query('CREATE DATABASE '+name);const url=new URL(base);url.pathname='/'+name;const sql=new Client({connectionString:url.href});await sql.connect();
 for(const file of fs.readdirSync('supabase/migrations').filter(f=>/^\d{3}_.*\.sql$/.test(f)&&Number(f.slice(0,3))<=23).sort())await sql.query(fs.readFileSync('supabase/migrations/'+file,'utf8'));
 if(mode==='candidate025')await sql.query(fs.readFileSync('supabase/migrations/025_aggregate_payload_confirmation.sql','utf8'));
 const toast=String((await sql.query("SELECT reltoastrelid::regclass::text n FROM pg_class WHERE oid='source_aggregates'::regclass")).rows[0].n);
 assert.match(toast,/^pg_toast\.pg_toast_\d+$/);const result={name,sql,db:postgresDatabase(url.href),toast};locals.push(result);return result;
}
async function measure(l:Local){return (await l.sql.query(`SELECT pg_current_wal_insert_lsn()::text lsn,pg_total_relation_size('source_aggregates')::text aggregate_bytes,pg_relation_size('${l.toast}')::text toast_heap_bytes,(SELECT count(*)::int FROM source_aggregates WHERE is_current) current_rows,(SELECT count(*)::int FROM source_aggregates WHERE NOT is_current) staged_rows`)).rows[0];}
async function wal(l:Local,before:string,after:string){return Number((await l.sql.query('SELECT pg_wal_lsn_diff($1,$2)::text n',[after,before])).rows[0].n);}
async function chunks(l:Local){return (await l.sql.query(`SELECT DISTINCT chunk_id::text id FROM ${l.toast} ORDER BY id`)).rows.map(r=>String(r.id));}

for(const shape of ['inline','toasted'])test(`022 vs025 same ${shape} KPI inputs: stage/publication WAL, TOAST identity and readers`,async()=>{
 const rows=Array.from({length:32},(_,i)=>({day:from,key:String(i),data:{impressions:i,spend_minor:100,nullable:null,ordered:[null,1,1,'1',false],body:shape==='inline'?'synthetic small payload':Array.from({length:54},(_,j)=>hash(`entity:${i}:part:${j}`)).join('')}}));
 rows.sort((a,b)=>a.key.localeCompare(b.key));
 const batch:KpiSourceBatch={from,to,observedAt:'2026-09-20T12:00:00Z',rows};const comparison:Row[]=[];
 for(const mode of ['baseline022','candidate025']){const l=await create(mode,shape);await syncKpiSource(l.db,'meta',ns,from,to,async()=>batch);
 const ids=(await l.sql.query('SELECT id FROM source_aggregates ORDER BY id')).rows.map(r=>r.id);const initialChunks=await chunks(l),before=await measure(l);let stageWal=0,publishWal=0,stagedRowsSubmitted=0;
 for(let repeat=1;repeat<=8;repeat++){
  const traced:Database={...l.db,upsert:async(...args)=>{const b=await measure(l);await l.db.upsert(...args);const a=await measure(l);stageWal+=await wal(l,b.lsn,a.lsn);stagedRowsSubmitted+=args[1].length;},rpc:async<T>(name:string,args:Row,options?:Parameters<Database['rpc']>[2])=>{if(name!=='cockpit_publish_aggregate_state')return l.db.rpc<T>(name,args,options);const b=await measure(l);const result=await l.db.rpc<T>(name,args,options);const a=await measure(l);publishWal+=await wal(l,b.lsn,a.lsn);return result;}};
  const next={...batch,observedAt:new Date(Date.parse(batch.observedAt)+repeat*60000).toISOString()};const result=await syncKpiSource(traced,'meta',ns,from,to,async()=>next);const read=await readKpiSource(l.db,'meta',ns,from,to);
  assert.equal(read.days.get(from)?.runId,result.runId);assert.equal(read.days.get(from)?.observedAt,next.observedAt);assert.deepEqual(read.days.get(from)?.rows,rows);assert.deepEqual((await l.sql.query('SELECT id FROM source_aggregates ORDER BY id')).rows.map(r=>r.id),ids);
 }
 const after=await measure(l),finalChunks=await chunks(l);assert.equal(after.current_rows,33);assert.equal(after.staged_rows,0);
 const beforeRetirementChunks=await chunks(l);await syncKpiSource(l.db,'meta',ns,from,to,async()=>({...batch,rows:[]}));
 const beforeReappearance=await measure(l);let reappearancePublicationWal=0;
 const tracedReappearance:Database={...l.db,rpc:async<T>(name:string,args:Row,options?:Parameters<Database['rpc']>[2])=>{if(name!=='cockpit_publish_aggregate_state')return l.db.rpc<T>(name,args,options);const b=await measure(l);const result=await l.db.rpc<T>(name,args,options);const a=await measure(l);reappearancePublicationWal=await wal(l,b.lsn,a.lsn);return result;}};
 const reappeared=await syncKpiSource(tracedReappearance,'meta',ns,from,to,async()=>batch);const afterReappearance=await measure(l),reappearedChunks=await chunks(l);
 assert.deepEqual((await l.sql.query('SELECT id FROM source_aggregates ORDER BY id')).rows.map(r=>r.id),ids);
 const restored=await readKpiSource(l.db,'meta',ns,from,to);assert.deepEqual(restored.days.get(from)?.rows,rows);assert.equal(restored.days.get(from)?.runId,reappeared.runId);
 const reappearanceRetainedToastValues=beforeRetirementChunks.filter(id=>reappearedChunks.includes(id)).length;
 if(shape==='toasted')assert.equal(reappearanceRetainedToastValues,mode==='baseline022'?0:32);
 comparison.push({shape,mode,repeatedPublications:8,stableDailyRows:32,corpusSha256:hash(JSON.stringify(batch.rows)),rawDailyPayloadUtf8Bytes:Buffer.byteLength(JSON.stringify(batch.rows),'utf8'),stagedRowsSubmitted,stageWalBytes:stageWal,publicationWalBytes:publishWal,before,after,physicalGrowthBytes:Number(after.aggregate_bytes)-Number(before.aggregate_bytes),initialToastValues:initialChunks.length,retainedOriginalToastValues:initialChunks.filter(id=>finalChunks.includes(id)).length,reappearance:{publicationWalBytes:reappearancePublicationWal,retainedToastValues:reappearanceRetainedToastValues,physicalGrowthBytes:Number(afterReappearance.aggregate_bytes)-Number(beforeReappearance.aggregate_bytes)}});
 }
 assert.equal(comparison[0].corpusSha256,comparison[1].corpusSha256);assert.equal(comparison[0].stagedRowsSubmitted,comparison[1].stagedRowsSubmitted);
 if(shape==='toasted'){assert.equal(comparison[1].retainedOriginalToastValues,32);assert.equal(comparison[0].retainedOriginalToastValues,0);assert.ok(Number(comparison[1].publicationWalBytes)<Number(comparison[0].publicationWalBytes));}
 console.log(JSON.stringify({aggregatePayloadComparison:comparison,limits:'Actual KPI writer/readers, same rows/observations/schema/indexes. Each mode has a fresh disposable PG17 database. WAL intervals isolated/sequential on same server; no audit trigger in the measured schemas. Full staging still writes the same33 rows per publication; manifests observedAt intentionally change. Allocated bytes include dead tuples/index/TOAST/free pages; no production ratio or recovered-space claim.'}));
});
