import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {startOfParisDay} from '../src/domain/dates';
const base=new URL(process.env.TEST_DATABASE_URL||'postgresql://localhost:55440/postgres');if(!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw Error('LOCAL_ONLY');
const name='window_test_'+Date.now(),admin=new Client({connectionString:base.href});const target=new URL(base);target.pathname='/'+name;let db:Client;
before(async()=>{await admin.connect();await admin.query(`CREATE DATABASE ${name}`);db=new Client({connectionString:target.href});await db.connect();for(const f of fs.readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort())await db.query(fs.readFileSync('supabase/migrations/'+f,'utf8'));});
after(async()=>{await db?.end();await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();});beforeEach(()=>db.query('BEGIN'));afterEach(()=>db.query('ROLLBACK'));
const from='2026-08-01',to='2026-08-04',day=(d:string)=>startOfParisDay(d);
async function run(source:string,stream:string,observed:string,status='complete',f=from,t=to){const id=randomUUID();await db.query("INSERT INTO sync_runs(id,source,source_namespace,stream_key,query_profile_key,partition_key,job_key,connector_version,coverage_kind,period_from,period_to,source_as_of,started_at,finished_at,status,pagination_complete) VALUES($1,$2,'synthetic',$3,'synthetic-v1',$8,$8,'synthetic','aggregate_period',$4,$5,$6,$6,$6,$7,true)",[id,source,stream,day(f),day(t),observed,status,id]);return id;}
async function value(id:string,metric:string,value:number|null,date?:string,currency='EUR',dimensions:object={}){const run=(await db.query('SELECT * FROM sync_runs WHERE id=$1',[id])).rows[0];const daily=run.stream_key!=='payments_analytics';const count=metric!=='meta_spend_minor'&&!metric.startsWith('wix_total')&&!metric.startsWith('wix_daily');await db.query("INSERT INTO source_aggregates(source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id,timezone,coverage_state,value,unit,currency,currency_exponent,tax_basis,dimensions,definition_version,source_locator) VALUES($1,'synthetic',$2,$3,$4,$5,'synthetic-v1',$6,'Europe/Paris','complete',$7,$8,$9,$10,$11,$12,'synthetic-v1','synthetic')",[run.source,metric,daily&&date?day(date):run.period_from,daily&&date?day(new Date(Date.parse(date)+86400000).toISOString().slice(0,10)):run.period_to,run.source==='meta'?'account':date&&!daily?'day:'+date:'all',id,value,count?'count':'minor',count?null:currency,count?null:2,daily?'unknown':'tax_inclusive',JSON.stringify(date?{date,scope:'account',...dimensions}:dimensions)]);}
async function window(source:string,stream:string,kind:string,f=from,t=to){return (await db.query('SELECT cockpit_source_window($1,\'synthetic\',$2,\'synthetic-v1\',$3,$4,\'Europe/Paris\',\'EUR\',2,$5) AS value',[source,stream,f,t,kind])).rows[0].value;}
async function meta(id:string,clicks:number|null=4,date=from){for(const [m,v] of [['meta_spend_minor',1000],['meta_impressions',100],['meta_outbound_clicks',clicks]] as const)await value(id,m,v,date);}
test('daily bundles preserve a latest unknown click, ignore failed and malformed publications and keep last attempt separate',async()=>{
 const old=await run('meta','meta_account_daily','2026-08-05T10:00Z');await meta(old);
 const current=await run('meta','meta_account_daily','2026-08-05T11:00Z');await meta(current,null);
 const failed=await run('meta','meta_account_daily','2026-08-05T12:00Z','failed');await meta(failed,8);
 const bad=await run('meta','meta_account_daily','2026-08-05T13:00Z');await value(bad,'meta_spend_minor',2000,from,'USD');await value(bad,'meta_impressions',100,from);await value(bad,'meta_outbound_clicks',10,from);
 const r=await window('meta','meta_account_daily','daily_bundle');assert.equal(r.aggregates.length,3);assert.equal(r.selections[0].runId,current);assert.equal(r.aggregates.find((a:any)=>a.metric_key==='meta_outbound_clicks').value,null);assert.equal(r.latestAttempt.id,bad);
 await db.query("UPDATE sync_runs SET finished_at='2026-08-08T10:00Z' WHERE id=$1",[old]);assert.equal((await window('meta','meta_account_daily','daily_bundle')).selections[0].runId,current);
});
test('receipts require both numeric measurements and never substitute missing or null refunds by zero',async()=>{
 const id=await run('wix','receipt_observations','2026-08-05T10:00Z');await value(id,'wix_receipts_created',3,from);assert.equal((await window('wix','receipt_observations','daily_bundle')).aggregates.length,0);
 await value(id,'wix_refunds_requested',null,from);assert.equal((await window('wix','receipt_observations','daily_bundle')).aggregates.length,0);
 await db.query("UPDATE source_aggregates SET value=0 WHERE sync_run_id=$1 AND metric_key='wix_refunds_requested'",[id]);assert.equal((await window('wix','receipt_observations','daily_bundle')).aggregates.length,2);
});
test('an exact PostHog empty report replaces its previous groups and different bounds never compose distincts',async()=>{
 const old=await run('posthog','quiz_observations','2026-08-05T10:00Z');await value(old,'posthog_events',10);await value(old,'posthog_visitors',7);
 const empty=await run('posthog','quiz_observations','2026-08-05T11:00Z','empty');await value(empty,'posthog_events',0);
 const r=await window('posthog','quiz_observations','exact_report');assert.equal(r.exactRunId,empty);assert.equal(r.aggregates.length,1);assert.equal(r.aggregates[0].value,0);
 assert.equal((await window('posthog','quiz_observations','exact_report','2026-08-02',to)).exactRunId,null);
});
test('Wix validates a whole report before returning one requested day and malformed dates cannot break other reports',async()=>{
 const id=await run('wix','payments_analytics','2026-08-05T10:00Z');await value(id,'wix_total_revenue',300);await value(id,'wix_daily_revenue',100,from);await value(id,'wix_daily_revenue',200,'2026-08-02');
 const newer=await run('wix','payments_analytics','2026-08-05T11:00Z');await value(newer,'wix_total_revenue',400);await value(newer,'wix_daily_revenue',400,from,'EUR',{date:'2026-02-30'});
 const r=await window('wix','payments_analytics','wix_report_daily','2026-08-02','2026-08-03');assert.equal(r.selections[0].runId,id);assert.equal(r.validations[id].totalMinor,300);assert.equal(r.validations[id].hasBreakdown,true);assert.equal(r.aggregates.length,2);assert.equal(r.aggregates.find((a:any)=>a.metric_key==='wix_daily_revenue').value,200);
 const zero=await window('wix','payments_analytics','wix_report_daily','2026-08-03',to);assert.equal(zero.selections.length,1);assert.equal(zero.aggregates.filter((a:any)=>a.metric_key==='wix_daily_revenue').length,0);
});
test('source window is stable, invoker and server only, and rejects unbounded requests',async()=>{
 const functionInfo=(await db.query("SELECT provolatile,prosecdef,has_function_privilege('anon',oid,'execute') AS anon,has_function_privilege('authenticated',oid,'execute') AS authenticated,has_function_privilege('service_role',oid,'execute') AS server FROM pg_proc WHERE proname='cockpit_source_window'")).rows[0];assert.deepEqual(functionInfo,{provolatile:'s',prosecdef:false,anon:false,authenticated:false,server:true});await assert.rejects(()=>window('meta','meta_account_daily','daily_bundle','2000-01-01','2030-01-01'),{code:'22023'});
});
