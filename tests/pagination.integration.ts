import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import fs from 'node:fs';
const base=process.env.TEST_DATABASE_URL||'postgresql://localhost:55440/postgres';
const address=new URL(base);if(!['localhost','127.0.0.1','[::1]'].includes(address.hostname))throw new Error('LOCAL_DATABASE_TESTS_ONLY');
const name='cockpit_pages_'+Date.now(),admin=new Client({connectionString:base});const target=new URL(base);target.pathname='/'+name;let db:Client;
before(async()=>{await admin.connect();await admin.query(`CREATE DATABASE ${name}`);db=new Client({connectionString:target.href});await db.connect();for(const file of fs.readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort())await db.query(fs.readFileSync('supabase/migrations/'+file,'utf8'));});
after(async()=>{await db?.end();await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();});beforeEach(async()=>{await db.query('BEGIN');});afterEach(async()=>{await db.query('ROLLBACK');});
test('15005 prospects: total exact, page50, dernière page5, recherche/statuts sur tout le registre',async()=>{
 await db.query("INSERT INTO prospects(source,source_namespace,external_id,display_name,source_status,owner_label,connector_version,mapping_version) SELECT 'notion','synthetic-pages',i::text,'Prospect test '||lpad(i::text,5,'0'),CASE WHEN i%2=0 THEN 'À relancer' ELSE 'RDV prévu' END,'Test','test-v1','test-v1' FROM generate_series(1,15005)i");
 const page=(search='',stage='',index=0)=>db.query('SELECT cockpit_prospects_page($1,$2,$3,50) value',[search,stage,index]).then(r=>r.rows[0].value);
 const first=await page(),last=await page('','',300);assert.equal(first.pagination.total,15005);assert.equal(first.prospects.length,50);assert.equal(last.prospects.length,5);assert.equal(new Set([...first.prospects,...last.prospects].map(p=>p.id)).size,55);
 assert.equal((await page('15005')).pagination.total,1);assert.equal((await page('','À relancer')).pagination.total,7502);assert.deepEqual(new Set(first.stages),new Set(['À relancer','RDV prévu']));
});
test('détails de105 liens paginés sans calculer le total depuis une page',async()=>{
 await db.query("WITH input AS(SELECT gen_random_uuid() id,gen_random_uuid() revision,i FROM generate_series(1,105)i),links AS(INSERT INTO tracked_links(id,title,placement,current_version) SELECT id,'Lien test '||i,'instagram_bio',1 FROM input RETURNING id) INSERT INTO link_revisions(id,link_id,version,label,placement,tunnel,campaign,source,medium,destination_url,generated_url) SELECT input.revision,input.id,1,'Lien test '||lpad(i::text,3,'0'),'instagram_bio','quiz','Campagne test','instagram','organic_social','https://quizz.blg-studio.fr/','https://quizz.blg-studio.fr/?blg_link_id='||revision::text FROM input JOIN links USING(id)");
 const query=(page:number)=>db.query("SELECT cockpit_dashboard_lists('2026-09-01','2026-09-08','all','all','', $1,50) value",[page]).then(r=>r.rows[0].value);
 const first=await query(0),last=await query(2);assert.equal(first.pagination.total,105);assert.equal(first.details.length,50);assert.equal(last.details.length,5);assert.equal(first.details[0].leads,null);assert.equal(new Set([...first.details,...last.details].map(r=>r.id)).size,55);assert.ok(first.campaigns.some((c:{id:string})=>c.id==='link:Campagne test'));
});
test('les fonctions de lecture restent interdites aux rôles navigateur',async()=>{
 await db.query('SAVEPOINT role_check');await assert.rejects(async()=>{await db.query('SET LOCAL ROLE anon');await db.query("SELECT cockpit_prospects_page('','',0,50)");},(e:{code:string})=>e.code==='42501');await db.query('ROLLBACK TO SAVEPOINT role_check');
});
