import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
const base=new URL(process.env.TEST_DATABASE_URL||'postgresql://localhost:55440/postgres');
if(!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw Error('LOCAL_ONLY');
const name='creative_test_'+Date.now(),admin=new Client({connectionString:base.href}),target=new URL(base);target.pathname='/'+name;let db:Client;
before(async()=>{await admin.connect();await admin.query(`CREATE DATABASE ${name}`);db=new Client({connectionString:target.href});await db.connect();for(const f of fs.readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')&&!f.startsWith('009_')).sort())await db.query(fs.readFileSync('supabase/migrations/'+f,'utf8'));await db.query("SET statement_timeout='8s'");});
after(async()=>{await db?.end();await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();});beforeEach(()=>db.query('BEGIN'));afterEach(()=>db.query('ROLLBACK'));
async function run(stream='ad_creative_metadata',profile='meta-creative-id-v1'){
 return (await db.query("INSERT INTO sync_runs(source,source_namespace,stream_key,query_profile_key,partition_key,job_key,connector_version,period_from,period_to,coverage_kind) VALUES('meta','123456',$1,$2,$3,$3,'synthetic','2024-08-01','2024-09-01','source_snapshot') RETURNING id",[stream,profile,randomUUID()])).rows[0].id;
}
async function ads(){await db.query("INSERT INTO ads(source,source_namespace,external_id,campaign_id,ad_name,connector_version) VALUES('meta','123456','100','campaign','synthetic a','synthetic'),('meta','123456','101','campaign','synthetic b','synthetic')");}
const record=(adId='100',creativeId='200',previousCreativeId:string|null=null)=>({accountId:'123456',adId,creativeId,previousCreativeId,observedAt:'2024-08-10T12:00:00Z'});
const publish=(id:string,records:unknown[])=>db.query('SELECT import_meta_creative_metadata($1,$2) n',[id,JSON.stringify(records)]);
test('metadata publication changes only creative_id, publishes its own stream atomically and exact retry is idempotent',async()=>{
 await ads();const before=(await db.query('SELECT * FROM ads ORDER BY external_id')).rows,id=await run();assert.equal((await publish(id,[record(),record('101','201')])).rows[0].n,2);
 const after=(await db.query('SELECT * FROM ads ORDER BY external_id')).rows;assert.deepEqual(after.map(({creative_id,...rest})=>rest),before.map(({creative_id,...rest})=>rest));assert.deepEqual(after.map(r=>r.creative_id),['200','201']);assert.equal((await publish(id,[record(),record('101','201')])).rows[0].n,2);
 const r=(await db.query('SELECT status,rows_read,rows_written,rows_rejected,pagination_complete FROM sync_runs WHERE id=$1',[id])).rows[0];assert.deepEqual(r,{status:'complete',rows_read:2,rows_written:2,rows_rejected:0,pagination_complete:true});assert.equal((await db.query('SELECT count(*) FROM ad_daily')).rows[0].count,'0');
});
test('a conflict on a later ad rolls back the whole metadata batch',async()=>{
 await ads();const id=await run();await db.query('SAVEPOINT invalid');await assert.rejects(()=>publish(id,[record(),record('101','201','999')]),{code:'40001'});await db.query('ROLLBACK TO invalid');assert.equal((await db.query('SELECT count(*) FROM ads WHERE creative_id IS NOT NULL')).rows[0].count,'0');assert.equal((await db.query('SELECT status FROM sync_runs WHERE id=$1',[id])).rows[0].status,'running');
});
test('wrong stream, account, extra content, duplicate ids and missing ads fail without changing measures',async()=>{
 await ads();
 for(const [stream,records,code]of [['ad_daily',[record()],'55000'],['ad_creative_metadata',[{...record(),accountId:'654321'}],'23514'],['ad_creative_metadata',[{...record(),extra:'forbidden'}],'23514'],['ad_creative_metadata',[record(),record()],'23514'],['ad_creative_metadata',[record('999')],'P0002']] as const){
  const id=await run(stream);await db.query('SAVEPOINT invalid');await assert.rejects(()=>publish(id,[...records]),{code});await db.query('ROLLBACK TO invalid');
 }
 assert.equal((await db.query('SELECT count(*) FROM ads WHERE creative_id IS NOT NULL')).rows[0].count,'0');
});
test('migration is independent of business observations and restricts function execution to server role',async()=>{
 assert.equal((await db.query("SELECT to_regclass('public.lead_source_observations') t")).rows[0].t,null);
 const r=(await db.query("SELECT has_function_privilege('anon','import_meta_creative_metadata(uuid,jsonb)','EXECUTE') anon,has_function_privilege('authenticated','import_meta_creative_metadata(uuid,jsonb)','EXECUTE') authenticated,has_function_privilege('service_role','import_meta_creative_metadata(uuid,jsonb)','EXECUTE') server,prosecdef FROM pg_proc WHERE proname='import_meta_creative_metadata'")).rows[0];assert.deepEqual(r,{anon:false,authenticated:false,server:true,prosecdef:false});
 assert.equal((await db.query('SELECT count(*) FROM cockpit_migrations WHERE version=10')).rows[0].count,'1');
});
