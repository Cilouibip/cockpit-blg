import fs from 'node:fs';
import {Client} from 'pg';
process.loadEnvFile('.env.local');
const url=new URL(process.env.DATABASE_URL||'');
if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!url.pathname.endsWith('_demo'))throw new Error('LOCAL_DEMO_DATABASE_ONLY');
const db=new Client({connectionString:url.href});await db.connect();
try{
 const version=Number((await db.query('SHOW server_version_num')).rows[0].server_version_num);
 if(version<150000)throw new Error('POSTGRESQL_15_OR_NEWER_REQUIRED');
 // These local roles mirror Supabase. No login and no credentials are created.
 await db.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$");
 for(const file of fs.readdirSync('supabase/migrations').filter(f=>/^\d+_.+\.sql$/.test(f)).sort()){
  const version=Number(file.split('_')[0]);
  const exists=(await db.query("SELECT to_regclass('public.cockpit_migrations') AS value")).rows[0].value;
  if(exists&&(await db.query('SELECT 1 FROM cockpit_migrations WHERE version=$1',[version])).rowCount){console.log(`Migration ${version} déjà appliquée.`);continue;}
  await db.query(fs.readFileSync('supabase/migrations/'+file,'utf8'));console.log(`Migration ${version} appliquée localement.`);
 }
}finally{await db.end();}
