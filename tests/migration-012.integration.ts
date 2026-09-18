import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {makeRevision} from '../src/lib/links';

// Migration 12 sur une base locale jetable : rejouable, précontrôle, liens /masterclass26 acceptés (et /blank-1 historique), retour arrière sans perte.
const base=process.env.TEST_DATABASE_URL||'postgresql://localhost:55440/postgres';
const address=new URL(base);if(!['localhost','127.0.0.1','[::1]'].includes(address.hostname))throw new Error('LOCAL_DATABASE_TESTS_ONLY');
const name='cockpit_m12_'+Date.now();const admin=new Client({connectionString:base});
const target=new URL(base);target.pathname='/'+name;let db:Client;
const migrations=fs.readdirSync('supabase/migrations').filter(f=>/^\d{3}_.+\.sql$/.test(f)).sort();
const sql=(file:string)=>fs.readFileSync(file,'utf8');
const constraint=async()=>(await db.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='link_revisions_destination_url_check'")).rows[0]?.def as string;
const versions=async()=>(await db.query('SELECT version FROM cockpit_migrations ORDER BY version')).rows.map(r=>Number(r.version));
async function save(destination:'quiz'|'masterclass',env?:{BLG_MASTERCLASS_URL?:string}){const revision=makeRevision({placement:'meta_ad',destination,campaign:'SQL test 012',label:'Synthétique '+randomUUID().slice(0,8)},undefined,1,undefined,undefined,env);await db.query('SELECT save_tracked_link($1,$2,0)',[revision.link_id,JSON.stringify(revision)]);return revision;}

before(async()=>{await admin.connect();await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$");await admin.query(`CREATE DATABASE ${name}`);db=new Client({connectionString:target.href});await db.connect();
 for(const file of migrations.filter(f=>Number(f.split('_')[0])<12))await db.query(sql('supabase/migrations/'+file));});
after(async()=>{await db?.end();await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();});

test('état avant : versions 1–11, règle historique à deux adresses ; un lien /masterclass26 est refusé',async()=>{
 assert.deepEqual(await versions(),[1,2,3,4,5,6,7,8,9,10,11]);
 assert.match(await constraint(),/blg-rugby-mc/);
 await save('quiz');
 await assert.rejects(()=>save('masterclass'),(e:unknown)=>(e as {code:string}).code==='23514','la destination /masterclass26 est refusée avant la migration');
});

test('application puis rejeu : version 12 inscrite une seule fois, liens /masterclass26 et /blank-1 acceptés, liens historiques conservés',async()=>{
 const before=(await db.query('SELECT count(*)::int AS n FROM link_revisions')).rows[0].n as number;
 await db.query(sql('supabase/migrations/012_masterclass_destination_constraint.sql'));
 assert.deepEqual(await versions(),[1,2,3,4,5,6,7,8,9,10,11,12]);
 assert.match(await constraint(),/blg-studio\[\.\]fr/);
 const revision=await save('masterclass');assert.equal(revision.destination_url,'https://www.blg-studio.fr/masterclass26');
 await save('masterclass',{BLG_MASTERCLASS_URL:'https://www.blg-studio.fr/blank-1'});
 await assert.rejects(()=>db.query("INSERT INTO link_revisions(link_id,version,label,placement,tunnel,campaign,source,medium,destination_url,generated_url) SELECT link_id,99,label,placement,tunnel,campaign,source,medium,'https://evil.example/blank-1',generated_url FROM link_revisions LIMIT 1"),(e:unknown)=>(e as {code:string}).code==='23514','un autre domaine reste refusé');
 await db.query(sql('supabase/migrations/012_masterclass_destination_constraint.sql'));
 assert.deepEqual(await versions(),[1,2,3,4,5,6,7,8,9,10,11,12],'rejouer ne duplique pas la version');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM link_revisions')).rows[0].n,before+2,'aucune ligne perdue ni ajoutée par le rejeu');
});

test('retour arrière : la règle redevient une liste fermée qui conserve les liens /masterclass26 et /blank-1 déjà créés ; une adresse hors liste est refusée',async()=>{
 await db.query(sql('tests/fixtures/migration-012-rollback.sql'));
 assert.deepEqual(await versions(),[1,2,3,4,5,6,7,8,9,10,11]);
 assert.match(await constraint(),/masterclass26/);assert.match(await constraint(),/blank-1/);assert.match(await constraint(),/blg-rugby-mc/);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM link_revisions WHERE destination_url='https://www.blg-studio.fr/masterclass26'")).rows[0].n,1,'le lien /masterclass26 est conservé');
 assert.equal((await db.query("SELECT count(*)::int AS n FROM link_revisions WHERE destination_url='https://www.blg-studio.fr/blank-1'")).rows[0].n,1,'le lien historique /blank-1 est conservé aussi');
 await assert.rejects(()=>save('masterclass',{BLG_MASTERCLASS_URL:'https://www.blg-studio.fr/autre-page'}),(e:unknown)=>(e as {code:string}).code==='23514','après retour arrière, seules les adresses déjà présentes restent possibles');
 await db.query(sql('supabase/migrations/012_masterclass_destination_constraint.sql'));
 assert.deepEqual(await versions(),[1,2,3,4,5,6,7,8,9,10,11,12],'la migration se réapplique après le retour arrière');
});
