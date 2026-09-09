import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from 'pg';
import { makeRevision } from '../src/lib/links';

const base=process.env.TEST_DATABASE_URL||'postgresql://localhost:55440/postgres';
const address=new URL(base);
if(!['localhost','127.0.0.1','[::1]'].includes(address.hostname))throw new Error('LOCAL_DATABASE_TESTS_ONLY');
const name=`cockpit_links_verify_${Date.now()}`;
const target=new URL(base);target.pathname=`/${name}`;
const admin=new Client({connectionString:base});
let db:Client;

async function migrations(from='001',until='999'){for(const file of fs.readdirSync('supabase/migrations').filter(file=>file.endsWith('.sql')&&file.slice(0,3)>=from&&file.slice(0,3)<=until).sort())await db.query(fs.readFileSync(`supabase/migrations/${file}`,'utf8'));}
async function expectCode(action:()=>Promise<unknown>,code:string){await assert.rejects(action,(error:unknown)=>(error as {code?:string}).code===code);}

test('registre Liens : persistance SQL, versions, conflit et archivage',async()=>{
 await admin.connect();
 try{
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$");
  await admin.query(`CREATE DATABASE ${name}`);db=new Client({connectionString:target.href});await db.connect();await migrations('001','011');
  const input={placement:'instagram_bio' as const,destination:'quiz' as const,campaign:'Recette locale',label:'Bio synthétique'};
  const first=makeRevision(input);
  await db.query('SELECT save_tracked_link($1,$2::jsonb,$3)',[first.link_id,JSON.stringify(first),0]);
  await db.end();db=new Client({connectionString:target.href});await db.connect();
  const persisted=await db.query('SELECT id,version,generated_url FROM link_revisions WHERE link_id=$1 ORDER BY version',[first.link_id]);
  assert.deepEqual(persisted.rows,[{id:first.id,version:1,generated_url:first.generated_url}]);
  await expectCode(()=>db.query('SELECT save_tracked_link($1,$2::jsonb,$3)',[first.link_id,JSON.stringify(first),0]),'40001');
  const retryRows=await db.query('SELECT count(*)::int AS count FROM link_revisions WHERE link_id=$1',[first.link_id]);
  assert.equal(retryRows.rows[0].count,1);
  const second=makeRevision({...input,label:'Bio synthétique v2'},first.link_id,2);
  await expectCode(()=>db.query('SELECT save_tracked_link($1,$2::jsonb,$3)',[second.link_id,JSON.stringify(second),0]),'40001');
  await db.query('SELECT save_tracked_link($1,$2::jsonb,$3)',[second.link_id,JSON.stringify(second),1]);
  await db.query('SELECT archive_tracked_link($1,$2,$3)',[first.link_id,true,2]);
  const blocked=makeRevision({...input,label:'Doit rester bloquée'},first.link_id,3);
  await expectCode(()=>db.query('SELECT save_tracked_link($1,$2::jsonb,$3)',[blocked.link_id,JSON.stringify(blocked),2]),'55000');
  await db.query('SELECT archive_tracked_link($1,$2,$3)',[first.link_id,false,2]);
  const state=await db.query('SELECT l.archived_at,l.current_version,array_agg(r.generated_url ORDER BY r.version) AS urls FROM tracked_links l JOIN link_revisions r ON r.link_id=l.id WHERE l.id=$1 GROUP BY l.archived_at,l.current_version',[first.link_id]);
  assert.equal(state.rows[0].archived_at,null);assert.equal(state.rows[0].current_version,2);assert.deepEqual(state.rows[0].urls,[first.generated_url,second.generated_url]);
  const dynamic=makeRevision({placement:'meta_ad',destination:'masterclass',campaign:'Recette locale',label:'Masterclass synthétique'},undefined,1,undefined,undefined,{BLG_MASTERCLASS_URL:'https://www.blg-studio.fr/nouvelle-masterclass'});
  await expectCode(()=>db.query('SELECT save_tracked_link($1,$2::jsonb,$3)',[dynamic.link_id,JSON.stringify(dynamic),0]),'23514');
  await migrations('012','012');
  await db.query('SELECT save_tracked_link($1,$2::jsonb,$3)',[dynamic.link_id,JSON.stringify(dynamic),0]);
  const dynamicStored=await db.query('SELECT destination_url,generated_url FROM link_revisions WHERE id=$1',[dynamic.id]);
  assert.deepEqual(dynamicStored.rows,[{destination_url:'https://www.blg-studio.fr/nouvelle-masterclass',generated_url:dynamic.generated_url}]);
 }finally{await db?.end();await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();}
});
