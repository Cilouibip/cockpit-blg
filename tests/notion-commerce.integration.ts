import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import fs from 'node:fs';
import {postgresDatabase,type Database} from '../src/lib/db';
import {buildNotionCommerceReport} from '../src/lib/notion-commerce-report';
import {commerceReadMemo,publishNotionCommerceReport,readNotionCommerceReport} from '../src/lib/notion-commerce-storage';
import {snapshot,parcours,payment,commerceConfig,commerceEnv,filters} from './commerce-fixtures';
const base=new URL(process.env.TEST_DATABASE_URL||'postgresql://localhost:55440/postgres');if(!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw Error('LOCAL_ONLY');
const name='commerce_test_'+Date.now(),admin=new Client({connectionString:base.href}),target=new URL(base);target.pathname='/'+name;let sql:Client,db:Database;
before(async()=>{await admin.connect();await admin.query(`CREATE DATABASE ${name}`);sql=new Client({connectionString:target.href});await sql.connect();for(const f of fs.readdirSync('supabase/migrations').filter(f=>/^00[1-8]_.*\.sql$/.test(f)).sort())await sql.query(fs.readFileSync('supabase/migrations/'+f,'utf8'));await sql.query(`ALTER DATABASE ${name} SET statement_timeout='8s'`);db=postgresDatabase(target.href);});
after(async()=>{await sql?.end();await new Promise(resolve=>setTimeout(resolve,5200));await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();});
const read=(f=filters)=>readNotionCommerceReport(db,f,commerceEnv);
const make=(day:string,observedAt:string)=>buildNotionCommerceReport(snapshot({observedAt,parcours:[parcours('parcours-a',{startDay:day})],payments:[payment('payment-a',{day})]}));
test('one immutable complete publication survives partial write/failure and a corrected date replaces the old day',async()=>{
 assert.equal((await read())!.available,false);assert.equal((await read())!.counts,null);
 const old=await publishNotionCommerceReport(db,commerceConfig,make('2024-02-03','2024-03-01T12:00:00Z'));assert.equal((await read())!.counts!.firstClientsDeclared,1);
 let midPublication=0;const failing={...db,upsert:async(...args:Parameters<Database['upsert']>)=>{await db.upsert(...args);midPublication=(await read())!.counts!.firstClientsDeclared;throw Error('simulated interrupted transport');}};
 await assert.rejects(()=>publishNotionCommerceReport(failing,commerceConfig,make('2024-01-03','2024-03-02T12:00:00Z')),/interrupted/);assert.equal(midPublication,1);assert.equal((await read())!.runId,old.runId);
 const current=await publishNotionCommerceReport(db,commerceConfig,make('2024-01-03','2024-03-03T12:00:00Z'));assert.equal((await read())!.counts!.firstClientsDeclared,0);assert.equal((await read({...filters,from:'2024-01-01',to:'2024-01-31'}))!.counts!.firstClientsDeclared,1);assert.equal((await read())!.runId,current.runId);
 await publishNotionCommerceReport(db,commerceConfig,make('2024-01-03','2024-03-03T12:00:00Z'));assert.equal((await read({...filters,from:'2024-01-01',to:'2024-01-31'}))!.counts!.firstClientsDeclared,1);
 assert.equal((await sql.query('SELECT count(*) FROM payments')).rows[0].count,'0');assert.equal((await sql.query('SELECT count(*) FROM people')).rows[0].count,'0');assert.equal((await sql.query('SELECT count(*) FROM events')).rows[0].count,'0');
});
test('a lost local publication result is recognized only after the exact stored report is verified',async()=>{
 const report=make('2024-01-04','2024-03-09T12:00:00Z'),first=await publishNotionCommerceReport(db,commerceConfig,report);
 const before=await sql.query("SELECT count(*) FROM source_aggregates WHERE sync_run_id=$1",[first.runId]);
 const retry=await publishNotionCommerceReport(db,commerceConfig,structuredClone(report));
 const after=await sql.query("SELECT count(*) FROM source_aggregates WHERE sync_run_id=$1",[first.runId]);
 assert.equal(retry.runId,first.runId);assert.equal(after.rows[0].count,before.rows[0].count);
});
test('an older lost result remains findable after six newer reports',async()=>{
 const original=make('2024-01-05','2024-03-10T12:00:00Z'),first=await publishNotionCommerceReport(db,commerceConfig,original);
 for(let day=11;day<=16;day++)await publishNotionCommerceReport(db,commerceConfig,make('2024-01-05',`2024-03-${day}T12:00:00Z`));
 const retry=await publishNotionCommerceReport(db,commerceConfig,structuredClone(original));
 assert.equal(retry.runId,first.runId);
});
test('omission cannot erase prior source members; changed profile cannot hide an old member during publishing',async()=>{
 const empty=buildNotionCommerceReport(snapshot({parcours:[],observedAt:'2024-03-04T12:00:00Z'}));await assert.rejects(()=>publishNotionCommerceReport(db,commerceConfig,empty),/COMMERCE_HISTORICAL_SOURCE_MEMBER_MISSING/);
 const changed=structuredClone(commerceConfig);changed.parcours.fields.start='Corrected source field';await assert.rejects(()=>publishNotionCommerceReport(db,changed,empty),/COMMERCE_HISTORICAL_SOURCE_MEMBER_MISSING/);assert.equal((await read())!.available,true);
});
test('attribution filters and absent profile are unavailable; malformed latest report falls back to the last valid report',async()=>{
 assert.equal((await read({...filters,source:'paid'}))!.counts,null);
 const changed=structuredClone(commerceConfig);changed.parcours.fields.start='Changed field';assert.equal((await readNotionCommerceReport(db,filters,{NOTION_COMMERCE_CONFIG:JSON.stringify(changed)}))!.available,false);
 const published=await publishNotionCommerceReport(db,commerceConfig,make('2024-01-03','2024-03-05T12:00:00Z'));await sql.query("UPDATE source_aggregates SET dimensions=jsonb_set(dimensions,'{dailyHash}','\"invalid\"') WHERE sync_run_id=$1 AND metric_key='notion_commerce_overview'",[published.runId]);assert.notEqual((await read())!.runId,published.runId);assert.equal((await read())!.counts!.firstClientsDeclared,0);
});
test('partial historical zero is explicit and report reads are bounded to one selected run before days',async()=>{
 const calls:{table:string;options:unknown}[]=[];const observed={...db,select:async(...args:Parameters<Database['select']>)=>{calls.push({table:args[0],options:args[1]});return db.select(...args);}};
 const result=await readNotionCommerceReport(observed,{...filters,from:'2024-02-10',to:'2024-02-12'},commerceEnv);assert.equal(result!.counts!.firstClientsDeclared,0);assert.equal(result!.coverage!.historicalExhaustivity,false);assert.equal(result!.definitionState,'pending_business_choice');
 assert.ok(calls.every(c=>c.table==='sync_runs'||(c.options as {eq?:{sync_run_id?:string}}).eq?.sync_run_id));assert.ok(calls.every(c=>(c.options as {limit:number}).limit<=1000));assert.equal((await sql.query("SELECT to_regclass('public.lead_source_observations') t")).rows[0].t,null);
});

test('missing historical payment or Client refuses publication and preserves prior acquisition evidence',async()=>{
 const config={...commerceConfig,parcours:{...commerceConfig.parcours,dataSourceId:'history-guard-synthetic'}};
 const env={NOTION_COMMERCE_CONFIG:JSON.stringify(config)};
 const initial=buildNotionCommerceReport(snapshot({payments:[payment('prior',{day:'2023-02-03'}),payment('recent')],observedAt:'2024-03-06T12:00:00Z'}));await publishNotionCommerceReport(db,config,initial);
 const prior=await readNotionCommerceReport(db,filters,env);assert.equal(prior!.counts!.firstPurchaseEvidenceConcordant,0);assert.equal(prior!.counts!.firstClientsDeclared,1);
 const missingPayment=buildNotionCommerceReport(snapshot({payments:[payment('recent')],observedAt:'2024-03-07T12:00:00Z'}));assert.equal(missingPayment.totals.firstPurchaseEvidenceConcordant,1);await assert.rejects(()=>publishNotionCommerceReport(db,config,missingPayment),/COMMERCE_HISTORICAL_SOURCE_MEMBER_MISSING/);
 const missingClient=buildNotionCommerceReport(snapshot({clients:[],payments:[payment('prior',{day:'2023-02-03'}),payment('recent')],observedAt:'2024-03-08T12:00:00Z'}));assert.equal(missingClient.totals.firstClientsDeclared,0);await assert.rejects(()=>publishNotionCommerceReport(db,config,missingClient),/COMMERCE_HISTORICAL_SOURCE_MEMBER_MISSING/);
 assert.equal((await readNotionCommerceReport(db,filters,env))!.runId,prior!.runId);assert.equal((await readNotionCommerceReport(db,filters,env))!.counts!.firstPurchaseEvidenceConcordant,0);
});
test('paid-sales details are byte-bounded, paginated beyond 1000 chunks, corruption falls back, and exact retry is idempotent',async()=>{
 const config={...commerceConfig,parcours:{...commerceConfig.parcours,dataSourceId:'paid-sales-chunks-synthetic'}};
 const report=make('2024-02-03','2024-03-20T12:00:00Z');
 const long='https://www.notion.so/'+('x'.repeat(780));
 report.paidSales.details=Array.from({length:1101},(_,index)=>({paymentId:'payment-'+index,paymentUrl:long,clientIds:['client-a'],clientName:'Synthetic '+index,clientUrl:long,scheduleIds:['schedule-'+index],scheduleUrls:[long],parcoursIds:['parcours-a'],day:'2024-02-03',amountMinor:39000,state:'pending' as const,reasons:['synthetic_reason_'+('r'.repeat(60))]}));
 report.paidSales.pendingInitialPaymentCases=report.paidSales.details.length;
 const first=await publishNotionCommerceReport(db,config,report);
 const chunks=await sql.query("SELECT dimensions_key,octet_length(dimensions::text) bytes FROM source_aggregates WHERE sync_run_id=$1 AND metric_key='notion_commerce_paid_sales' ORDER BY dimensions_key",[first.runId]);
 assert.ok(chunks.rows.length>1000);assert.ok(chunks.rows.every(row=>Number(row.bytes)<4000));
 const env={NOTION_COMMERCE_CONFIG:JSON.stringify(config)},readBack=await readNotionCommerceReport(db,filters,env);assert.equal(readBack!.paidSales!.details.length,1101);assert.equal(readBack!.paidSales!.pendingInitialPaymentCases,1101);
 const retry=await publishNotionCommerceReport(db,config,structuredClone(report));assert.equal(retry.runId,first.runId);
 await sql.query("DELETE FROM source_aggregates WHERE sync_run_id=$1 AND metric_key='notion_commerce_paid_sales' AND dimensions_key=(SELECT dimensions_key FROM source_aggregates WHERE sync_run_id=$1 AND metric_key='notion_commerce_paid_sales' ORDER BY dimensions_key LIMIT 1)",[first.runId]);
 assert.equal((await readNotionCommerceReport(db,filters,env))!.available,false);
 const repaired=await publishNotionCommerceReport(db,config,structuredClone(report));assert.notEqual(repaired.runId,first.runId);assert.equal((await readNotionCommerceReport(db,filters,env))!.paidSales!.details.length,1101);
});

test('la comparaison de période relit chaque famille de lignes une seule fois par requête',async()=>{
 const calls:{table:string;metric?:string}[]=[];const observed={...db,select:async(...args:Parameters<Database['select']>)=>{calls.push({table:args[0],metric:(args[1] as {eq?:{metric_key?:string}}|undefined)?.eq?.metric_key});return db.select(...args);}};
 const single=await readNotionCommerceReport(observed,filters,commerceEnv,commerceReadMemo());assert.equal(single!.available,true);const expected=calls.length;calls.length=0;
 const memo=commerceReadMemo(),previous={...filters,from:'2024-01-01',to:'2024-01-31'};
 const [current,prior]=await Promise.all([readNotionCommerceReport(observed,filters,commerceEnv,memo),readNotionCommerceReport(observed,previous,commerceEnv,memo)]);
 assert.equal(current!.runId,single!.runId);assert.equal(prior!.runId,single!.runId);assert.deepEqual(current!.counts,single!.counts);assert.equal(current!.paidSales!.details.length,single!.paidSales!.details.length);
 assert.equal(calls.length,expected);assert.equal(calls.filter(c=>c.table==='sync_runs').length,1);assert.equal(calls.filter(c=>c.metric==='notion_commerce_paid_sales').length,calls.filter(c=>c.metric==='notion_commerce_overview').length);
 assert.equal((await readNotionCommerceReport(observed,filters,commerceEnv))!.runId,single!.runId);
});
