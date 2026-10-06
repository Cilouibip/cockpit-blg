import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Temporal } from '@js-temporal/polyfill';
import { passwordHash } from '../src/lib/auth';
import { evaluateSyncJobHealth, readSyncHealth } from '../src/lib/sync-health';
import { jobScope, PILOT_REFRESH_JOBS, syncJobRunFilter, type SyncJob } from '../src/lib/sync-jobs';
import type { Database, Row, SelectOptions } from '../src/lib/db';

const now = Date.parse('2026-10-06T08:00:00Z');
const iso = (minutes: number) => new Date(now-minutes*60_000).toISOString();
const env: NodeJS.ProcessEnv = { NODE_ENV:'test', NOTION_DATA_SOURCE_ID:'synthetic-notion', META_AD_ACCOUNT_ID:'act_synthetic-meta', META_ACCESS_TOKEN:'synthetic-token', WIX_SITE_ID:'synthetic-site', WIX_API_KEY:'synthetic-key', IDENTITY_HMAC_SECRET:'synthetic-hmac-secret-longer-than-32-chars', WIX_LEAD_ENTRY_CONFIG:JSON.stringify({formIds:['synthetic-form']}), POSTHOG_PROJECT_ID:'1', POSTHOG_PERSONAL_API_KEY:'synthetic-token' };
function publication(job: SyncJob, changes: Row = {}): Row {
 const scope = jobScope(job,env)!;
 const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO('Europe/Paris').toPlainDate();
 const bound = (day: Temporal.PlainDate) => day.toZonedDateTime('Europe/Paris').toInstant().toString();
 const from = job==='notion'||job==='forms' ? iso(35) : bound(job==='masterclass'?today.with({day:1}).subtract({months:1}):today.subtract({days:35}));
 const to = job==='notion'||job==='forms' ? iso(5) : bound(today.add({days:1}));
 return { id:'synthetic-'+job, ...syncJobRunFilter(job,scope), status:'complete', pagination_complete:true, rows_rejected:0, error_code:null, started_at:iso(5), finished_at:iso(2), source_as_of:iso(5), period_from:from, period_to:to, covered_from:from, covered_to:to, ...changes };
}
function db(rows: Row[], calls: SelectOptions[] = []): Database {
 return {
  select:async(table, options={})=>{
   assert.equal(table,'sync_runs');calls.push(options);
   return rows.filter(row=>Object.entries(options.eq??{}).every(([key,value])=>String(row[key])===value)&&Object.entries(options.in??{}).every(([key,values])=>values.includes(String(row[key])))).sort((a,b)=>String(b[options.order??'id']).localeCompare(String(a[options.order??'id']))).slice(0,options.limit??1000);
  },
  upsert:async()=>assert.fail('health never writes'), rpc:async()=>assert.fail('health never calls RPC or tick'), probe:async()=>assert.fail('health never probes another table'),
 };
}
const evaluate = (job: SyncJob, rows: Row[]) => evaluateSyncJobHealth(job,rows,jobScope(job,env)!,now);

test('seven complete exact publications are healthy through bounded SELECT only; empty is a valid publication',async()=>{
 const calls: SelectOptions[]=[];
 const report=await readSyncHealth(db(PILOT_REFRESH_JOBS.map(job=>publication(job,{status:'empty'})),calls),env,now);
 assert.equal(report.status,'healthy');assert.equal(report.jobs.length,7);assert.equal(calls.length,14);
 assert.ok(report.jobs.every(job=>job.cutoff===iso(5)&&job.ageMinutes===5));
 for (const call of calls) { assert.ok(call.eq?.source_namespace);assert.ok(call.eq?.query_profile_key);assert.equal(call.timeoutMs,5000); }
 const rendered=JSON.stringify(report);assert.ok(!rendered.includes('synthetic-'));assert.ok(!rendered.includes('query_profile_key'));
});

test('wrong profile, namespace, source or stream never contributes a publication or blocks the exact scope',()=>{
 for(const key of ['query_profile_key','source_namespace','source','stream_key']) {
  const wrong=publication('forms',{[key]:'wrong',status:'failed',started_at:iso(1)});
  assert.equal(evaluate('forms',[wrong]).state,'unknown');
  assert.equal(evaluate('forms',[publication('forms'),wrong]).state,'healthy');
 }
});

test('failed-only and absent publications are unknown; newer failed attempt flags stale without hiding publication proof',()=>{
 assert.equal(evaluate('forms',[]).code,'PUBLICATION_ABSENT');
 assert.equal(evaluate('forms',[publication('forms',{status:'failed'})]).state,'unknown');
 const result=evaluate('forms',[publication('forms'),publication('forms',{id:'synthetic-attempt',status:'failed',started_at:iso(1),finished_at:iso(1),error_code:'upstream-detail-must-not-be-emitted'})]);
 assert.equal(result.code,'LATEST_ATTEMPT_FAILED');assert.equal(result.state,'stale');assert.equal(result.cutoff,iso(5));
 assert.ok(!JSON.stringify(result).includes('upstream-detail'));
});

test('incomplete pagination, rejection, error, absent or malformed observation timestamps cannot be healthy',()=>{
 for (const changes of [{pagination_complete:false},{pagination_complete:null},{rows_rejected:1},{rows_rejected:null},{error_code:'unsafe upstream text'},{source_as_of:null},{source_as_of:'2026-10-06'},{started_at:'invalid'},{finished_at:null},{period_to:'invalid'}]) assert.equal(evaluate('forms',[publication('forms',changes)]).state,'unknown');
});

test('future observation/start/finish, inverted dates and false coverage are unknown; current business future bound is legitimate',()=>{
 for(const field of ['source_as_of','started_at','finished_at','period_to']) assert.equal(evaluate('forms',[publication('forms',{[field]:iso(-1)})]).state,'unknown');
 assert.equal(evaluate('forms',[publication('forms',{started_at:iso(1)})]).code,'TIMESTAMP_ORDER_INVALID');
 assert.equal(evaluate('forms',[publication('forms',{covered_to:iso(10)})]).code,'COVERAGE_INVALID');
 assert.equal(evaluate('masterclass',[publication('masterclass')]).state,'healthy');
});

test('age uses conservative source cutoff, never recent finish; maximum 60 minutes, no event timestamp fallback',()=>{
 const aged = (minutes:number) => publication('forms',{started_at:iso(minutes),source_as_of:iso(minutes),period_to:iso(minutes),covered_to:iso(minutes),period_from:iso(minutes+30),covered_from:iso(minutes+30),last_event_at:iso(1)});
 assert.equal(evaluate('forms',[aged(60)]).state,'healthy');
 assert.equal(evaluate('forms',[aged(60.01)]).code,'PUBLICATION_STALE');
 assert.equal(evaluate('forms',[aged(120)]).cutoff,iso(120));
 assert.equal(evaluate('forms',[publication('forms',{source_as_of:null,last_event_at:iso(1)})]).state,'unknown');
});

test('old month with fresh source_as_of cannot prove current worker window for aggregates; lower delta bounds remain valid',()=>{
 for(const job of ['masterclass','meta_ads','kpi_meta','kpi_posthog','kpi_email'] as SyncJob[]) {
  assert.equal(evaluate(job,[publication(job,{period_from:'2026-07-01T00:00:00Z',period_to:'2026-08-01T00:00:00Z'})]).code,'CURRENT_WINDOW_MISMATCH');
 }
 assert.equal(evaluate('notion',[publication('notion',{period_from:'1970-01-01T00:00:00Z',covered_from:'1970-01-01T00:00:00Z'})]).state,'healthy');
});
test('aggregate requested window cannot hide null, malformed, old or shifted exact coverage',()=>{
 for(const job of ['masterclass','meta_ads','kpi_meta','kpi_posthog','kpi_email'] as SyncJob[]) {
  for(const field of ['covered_from','covered_to']) for(const value of [null,'invalid','2026-07-01T00:00:00Z']) {
   assert.equal(evaluate(job,[publication(job,{[field]:value})]).code,'COVERAGE_INVALID');
  }
  const row=publication(job);
  assert.equal(evaluate(job,[{...row,covered_from:String(row.covered_from).replace('Z','.000000001Z')}]).code,'COVERAGE_INVALID');
  assert.equal(evaluate(job,[row]).state,'healthy');
 }
});

test('database failure and missing configuration are unknown, never zero or success',async()=>{
 const failing={...db([]),select:async()=>{throw Error('credential-sensitive upstream failure');}};
 const report=await readSyncHealth(failing,env,now);assert.equal(report.status,'unknown');assert.ok(report.jobs.every(job=>job.code==='DATABASE_UNAVAILABLE'));assert.ok(!JSON.stringify(report).includes('credential'));
 const missing=await readSyncHealth(db([]),{NODE_ENV:'test'},now);assert.equal(missing.status,'unknown');assert.ok(missing.jobs.every(job=>job.code==='CONFIGURATION_UNKNOWN'));
});

test('health endpoint rejects absent/wrong/short bearer before any DB; correct bearer only reads DB and returns unknown on failed reads',async()=>{
 const previous={...process.env},oldFetch=globalThis.fetch;
 const secret='synthetic-cron-secret-with-more-than-32-characters';let calls=0;
 for(const key of Object.keys(process.env))if(/^(NOTION_|WIX_|META_|POSTHOG_|VERCEL|DATABASE_URL)/.test(key))delete process.env[key];
 Object.assign(process.env,env,{COCKPIT_MODE:'live',APP_ORIGIN:'http://127.0.0.1:3191',COCKPIT_SESSION_SECRET:'synthetic-session-secret-with-32-characters',COCKPIT_PASSWORD_HASH:passwordHash('synthetic-password-for-health-test'),CRON_SECRET:secret,SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SECRET_KEY:'synthetic-private-db-key'});
 globalThis.fetch=async(input,init)=>{calls++;assert.equal(new URL(String(input)).hostname,'synthetic.supabase.co');assert.equal(init?.method,'GET');throw Error('synthetic DB unavailable');};
 try {
  const {GET}=await import('../src/app/api/[...path]/route');const url='http://127.0.0.1:3191/api/jobs/health';
  assert.equal((await GET(new Request(url))).status,401);
  assert.equal((await GET(new Request(url,{headers:{Authorization:'Bearer wrong'}}))).status,401);
  process.env.CRON_SECRET='short';assert.equal((await GET(new Request(url,{headers:{Authorization:'Bearer short'}}))).status,401);process.env.CRON_SECRET=secret;assert.equal(calls,0);
  process.env.SUPABASE_SECRET_KEY='';
  const unconfigured=await GET(new Request(url,{headers:{Authorization:'Bearer '+secret}}));assert.equal(unconfigured.status,503);assert.equal((await unconfigured.json()).status,'unknown');assert.equal(calls,0);process.env.SUPABASE_SECRET_KEY='synthetic-private-db-key';
  const response=await GET(new Request(url,{headers:{Authorization:'Bearer '+secret}}));assert.equal(response.status,503);const report=await response.json();assert.equal(report.status,'unknown');assert.equal(report.jobs.length,7);assert.equal(calls,14);assert.ok(!JSON.stringify(report).includes(secret));

 } finally {globalThis.fetch=oldFetch;for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);}
});

test('monitor workflow has its own clock and group, consumes only health and emits only fixed verdict/codes',()=>{
 const workflow=fs.readFileSync(new URL('../.github/workflows/health-monitor.yml',import.meta.url),'utf8');
 assert.ok(workflow.includes("cron: '*/5 * * * *'"));assert.ok(workflow.includes('workflow_dispatch:'));assert.ok(workflow.includes('group: cockpit-health-monitor'));assert.ok(workflow.includes('contents: read'));assert.ok(workflow.includes('/api/jobs/health'));
 assert.ok(!workflow.includes('/api/jobs/tick'));assert.ok(!workflow.includes('console.log(text)'));assert.ok(!workflow.includes('console.log(report)'));
});


test('workflow execution logs anonymous verdicts only, rejects invalid HTTP200 and fails stale/missing-secret without refresh',()=>{
 const workflow=fs.readFileSync(new URL('../.github/workflows/health-monitor.yml',import.meta.url),'utf8');
 const script=workflow.split("<<'JS'\n")[1].split('          JS')[0].split('\n').map(line=>line.replace(/^          /,'')).join('\n');
 const secret='synthetic-cron-secret-with-32-characters';
 const run=(status:string, code:string, responseStatus=200, configured=true)=>{
  const at=Date.parse('2026-10-06T08:00:00Z'),stamp=(delta:number)=>new Date(at+delta).toISOString();
  const report={status,checkedAt:stamp(50),maxAgeMinutes:60,jobs:PILOT_REFRESH_JOBS.map(job=>({job,state:status,code,cutoff:stamp(-300000),publishedAt:stamp(-120000),ageMinutes:5,namespace:'private-never-log',credential:secret})),private:'private-never-log'};
  const prefix=`let clock=0;Date.now=()=>${at}+(clock++===0?0:100);globalThis.fetch=async(url,init)=>{if(!url.endsWith('/api/jobs/health')||init.method!=='GET')throw Error();return new Response(${JSON.stringify(JSON.stringify(report))},{status:${responseStatus}});};\n`;
  return spawnSync(process.execPath,['--input-type=module','-e',prefix+script],{env:{...process.env,CRON_SECRET:configured?secret:''},encoding:'utf8'});
 };
 const healthy=run('healthy','PUBLICATION_CURRENT');assert.equal(healthy.status,0);assert.deepEqual(JSON.parse(healthy.stdout),{status:'healthy',codes:['PUBLICATION_CURRENT']});
 const stale=run('stale','PUBLICATION_STALE',503);assert.equal(stale.status,1);assert.deepEqual(JSON.parse(stale.stdout),{status:'stale',codes:['PUBLICATION_STALE']});
 const invalid=run('healthy',secret);assert.equal(invalid.status,1);assert.deepEqual(JSON.parse(invalid.stdout),{status:'unknown',codes:['HEALTH_ENDPOINT_UNAVAILABLE_OR_INVALID']});
 const absent=run('healthy','PUBLICATION_CURRENT',200,false);assert.equal(absent.status,1);assert.deepEqual(JSON.parse(absent.stdout),{status:'unknown',codes:['HEALTH_CONFIG_MISSING']});
 for(const execution of [healthy,stale,invalid,absent]) {assert.equal(execution.stderr,'');assert.ok(!execution.stdout.includes(secret));assert.ok(!execution.stdout.includes('private-never-log'));}
});

test('monitor clock rejects cached or future reports and recomputes healthy cutoff age without trusting ageMinutes',()=>{
 const workflow=fs.readFileSync(new URL('../.github/workflows/health-monitor.yml',import.meta.url),'utf8');
 const script=workflow.split("<<'JS'\n")[1].split('          JS')[0].split('\n').map(line=>line.replace(/^          /,'')).join('\n');
 const at=Date.parse('2026-10-06T08:00:00Z'),stamp=(delta:number)=>new Date(at+delta).toISOString();
 const secret='synthetic-cron-secret-with-32-characters';
 const run=(reportChanges:Row={},jobChanges:Row={},elapsed=100)=>{
  const report={status:'healthy',checkedAt:stamp(50),maxAgeMinutes:60,jobs:PILOT_REFRESH_JOBS.map(job=>({job,state:'healthy',code:'PUBLICATION_CURRENT',cutoff:stamp(-300000),publishedAt:stamp(-120000),ageMinutes:5,...jobChanges})),private:secret,...reportChanges};
  const prefix=`let clock=0;Date.now=()=>${at}+(clock++===0?0:${elapsed});globalThis.fetch=async()=>Response.json(${JSON.stringify(report)});\n`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',prefix+script],{env:{...process.env,CRON_SECRET:secret},encoding:'utf8'});
  assert.equal(result.stderr,'');assert.ok(!result.stdout.includes(secret));
  return result;
 };
 const recent=run();assert.equal(recent.status,0);
 const inconsistentRecentAge=run({}, {ageMinutes:999});assert.equal(inconsistentRecentAge.status,0,'actual cutoff age is used independently');
 for(const [report,job,elapsed] of [
  [{checkedAt:stamp(-60001)},{},100],
  [{checkedAt:stamp(-1)},{},100],
  [{checkedAt:stamp(101)},{},100],
  [{checkedAt:null},{},100],
  [{},{},90000],
  [{},{cutoff:stamp(-3600001),ageMinutes:0},100],
  [{},{cutoff:stamp(101),ageMinutes:0},100],
  [{},{publishedAt:stamp(101)},100],
  [{},{cutoff:null,ageMinutes:0},100],
  [{},{cutoff:'2026-10-06T08:00:00.000000001Z',ageMinutes:0},100],
  [{},{cutoff:stamp(-60000),publishedAt:stamp(-120000)},100],
 ] as [Row,Row,number][]) {
  const rejected=run(report,job,elapsed);assert.equal(rejected.status,1);
  assert.deepEqual(JSON.parse(rejected.stdout),{status:'unknown',codes:['HEALTH_ENDPOINT_UNAVAILABLE_OR_INVALID']});
 }
});


test('current aggregate window is Paris calendar, including the UTC day before midnight and month boundary',()=>{
 const at=Date.parse('2026-10-31T23:05:00Z'); // 1 November 00:05 Paris, after DST transition.
 const row=publication('masterclass',{started_at:'2026-10-31T23:01:00Z',finished_at:'2026-10-31T23:04:00Z',source_as_of:'2026-10-31T23:01:00Z',period_from:'2026-09-30T22:00:00Z',covered_from:'2026-09-30T22:00:00Z',period_to:'2026-11-01T23:00:00Z',covered_to:'2026-11-01T23:00:00Z'});
 assert.equal(evaluateSyncJobHealth('masterclass',[row],jobScope('masterclass',env)!,at).state,'healthy');
 assert.equal(evaluateSyncJobHealth('masterclass',[{...row,period_from:'2026-09-01T00:00:00Z'}],jobScope('masterclass',env)!,at).code,'CURRENT_WINDOW_MISMATCH');
});

test('invalid clock and future complete publication cannot produce a healthy fallback',async()=>{
 const report=await readSyncHealth(db([]),env,Number.MAX_SAFE_INTEGER);assert.equal(report.status,'unknown');assert.equal(report.checkedAt,null);assert.ok(report.jobs.every(job=>job.code==='CLOCK_INVALID'));
 const future=publication('forms',{id:'synthetic-future',started_at:iso(-1),finished_at:iso(-2),source_as_of:iso(-1)});
 assert.equal(evaluate('forms',[publication('forms'),future]).state,'unknown');
});


test('sub-millisecond future timestamps and shifted bounds never pass through truncation',()=>{
 assert.equal(evaluate('forms',[publication('forms',{source_as_of:'2026-10-06T08:00:00.000000001Z'})]).code,'TIMESTAMP_FUTURE');
 const row=publication('masterclass');
 assert.equal(evaluate('masterclass',[{...row,period_from:'2026-08-31T22:00:00.000000001Z'}]).code,'CURRENT_WINDOW_MISMATCH');
 assert.equal(evaluate('forms',[publication('forms',{covered_to:'2026-10-06T07:55:00.000000001Z'})]).code,'COVERAGE_INVALID');
});


test('Forms transaction timestamps precede clock_timestamp cutoff; exact coverage remains healthy without tolerance',()=>{
 const row=publication('forms',{started_at:'2026-10-06T07:55:00.920117Z',source_as_of:'2026-10-06T07:55:00.920117Z',period_from:'2026-10-04T06:49:00.532723Z',covered_from:'2026-10-04T06:49:00.532723Z',period_to:'2026-10-06T07:55:00.923566Z',covered_to:'2026-10-06T07:55:00.923566Z',finished_at:'2026-10-06T07:55:01.564957Z'});
 const received=evaluate('forms',[row]);assert.equal(received.state,'healthy');assert.equal(received.code,'PUBLICATION_CURRENT');
 assert.equal(received.cutoff,'2026-10-06T07:55:00.920Z','transaction observation remains oldest cutoff conservatively rounded down');
 assert.equal(evaluate('forms',[{...row,covered_to:'2026-10-06T07:55:00.923567Z'}]).code,'COVERAGE_INVALID');
 assert.equal(evaluate('forms',[{...row,period_to:row.finished_at,covered_to:row.finished_at}]).state,'healthy','cutoff at publication is the proved upper bound, not an invented tolerance');
 assert.equal(evaluate('forms',[{...row,period_to:'2026-10-06T07:55:01.564958Z',covered_to:'2026-10-06T07:55:01.564958Z'}]).state,'unknown');
 assert.equal(evaluate('forms',[{...row,started_at:'2026-10-06T05:55:00Z',source_as_of:'2026-10-06T05:55:00Z'}]).code,'PUBLICATION_STALE','fresh finish/cutoff cannot hide old observation');
 assert.equal(evaluate('notion',[{...publication('notion'),source_as_of:'2026-10-06T07:54:59Z'}]).code,'COVERAGE_INVALID','Notion explicit source_as_of=period_to publication invariant retained');
});
