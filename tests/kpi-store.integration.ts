import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from 'pg';
import { postgresDatabase } from '../src/lib/db';
import { syncKpiSource,readKpiSource } from '../src/lib/kpi-source-store';
import { ConnectorError } from '../src/connectors/http';

test('KPI publication persists through PostgreSQL JSONB and failed cycles preserve history',async()=>{
 const base=process.env.TEST_DATABASE_URL??'postgresql://127.0.0.1:55440/postgres';
 const target=new URL(base);assert.ok(['localhost','127.0.0.1'].includes(target.hostname));
 const name='cockpit_kpi_test_'+Date.now();const admin=new Client({connectionString:base});await admin.connect();
 await admin.query(`CREATE DATABASE ${name}`);target.pathname='/'+name;
 const setup=new Client({connectionString:target.href});await setup.connect();
 try{
  for(const file of fs.readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort())await setup.query(fs.readFileSync('supabase/migrations/'+file,'utf8'));
  const db=postgresDatabase(target.href),from='2026-09-20',to='2026-09-22';
  for(const value of [10,12])await syncKpiSource(db,'meta','synthetic-only',from,to,async()=>({from,to,observedAt:`2026-09-22T${value}:00:00Z`,rows:[{day:from,key:'campaign',data:{spend_eur:value,campaignId:'campaign',nested:{z:1,a:2}}}]}));
  let read=await readKpiSource(db,'meta','synthetic-only',from,to);assert.equal(read.days.get(from)?.rows[0].data.spend_eur,12);assert.equal(read.days.size,2);
  await assert.rejects(()=>syncKpiSource(db,'meta','synthetic-only',from,to,async()=>{throw new ConnectorError('UPSTREAM_HTTP_ERROR',503);}));
  read=await readKpiSource(db,'meta','synthetic-only',from,to);assert.equal(read.days.get(from)?.rows[0].data.spend_eur,12);assert.equal(read.latestAttempt?.status,'failed');assert.equal(read.latestAttempt?.error_code,'UPSTREAM_HTTP_ERROR HTTP 503');
  assert.equal((await setup.query('SELECT count(*)::int AS n FROM sync_runs')).rows[0].n,3);
  // État courant (migration 018) : la valeur modifiée met à jour la même ligne, aucune version par passage.
  assert.equal((await setup.query("SELECT count(*)::int AS n FROM source_aggregates WHERE metric_key='kpi_daily_row'")).rows[0].n,1);
  assert.equal((await setup.query("SELECT count(*)::int AS n FROM source_aggregates WHERE is_current")).rows[0].n,3,'une ligne et deux manifestes courants');
 }finally{await setup.end();await new Promise(resolve=>setTimeout(resolve,5500));await admin.query(`DROP DATABASE ${name}`);await admin.end();}
});
