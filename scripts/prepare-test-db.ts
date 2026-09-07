import {Client} from 'pg';
const url=new URL(process.env.TEST_DATABASE_URL||'postgresql://localhost:55440/postgres');
if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('LOCAL_DATABASE_TESTS_ONLY');
const db=new Client({connectionString:url.href});await db.connect();
try{await db.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$");}finally{await db.end();}
