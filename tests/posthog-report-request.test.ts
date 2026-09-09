import {test}from'node:test';import assert from'node:assert/strict';
import {requestPostHogReport,postHogReportRequest}from'../src/lib/posthog-report-request';
import type{Database,Row}from'../src/lib/db';import type{DashboardFilters}from'../src/lib/ui-contract';
const filters:DashboardFilters={from:'2026-08-20',to:'2026-09-02',source:'paid',campaign:'meta:12345',tunnel:'quiz',compare:true};
const report={status:'complete',observedAt:'2026-09-08T12:00:00Z',coverage:{queryComplete:true}};
function database(running:()=>Row[]=()=>[]):Database{return{select:async(table,o)=>{assert.equal(table,'sync_runs');assert.equal(o?.limit,1);assert.equal(o?.eq?.source,'posthog');return running();},upsert:async()=>assert.fail('not part of preparation'),rpc:async()=>{throw Error('not part of preparation');},probe:async()=>{}};}
test('Source response alone is insufficient; only an exact published report makes preparation ready',async()=>{
 let stored:typeof report|null=null,starts=0;const db=database();const read=async()=>stored;
 const failed=await requestPostHogReport(filters,'quiz',{db,namespace:'synthetic',read,start:async()=>{starts++;return report;}});
 assert.equal(failed.state,'failed');assert.equal(starts,1);
 const ready=await requestPostHogReport(filters,'quiz',{db,namespace:'synthetic',read,start:async()=>{stored=report;return report;}});
 assert.equal(ready.state,'ready');assert.equal(ready.empty,false);
});
test('Finish failure and a missing comparison never reuse a report from another period',async()=>{
 const seen:string[]=[];const read=async(request:{from:string})=>{seen.push(request.from);return request.from==='2026-08-20'?report:null;};
 const previous={...filters,from:'2026-08-06',to:'2026-08-19'};
 const result=await requestPostHogReport(previous,'quiz',{db:database(),namespace:'synthetic',read,start:async()=>{throw Error('finish_sync failed');}});
 assert.equal(result.state,'failed');assert.ok(seen.every(from=>from===previous.from));assert.equal(result.empty,undefined);
});
test('Identical preparations share one import and release the in-flight entry afterwards',async()=>{
 let complete:()=>void=()=>{},stored:typeof report|null=null,starts=0;const gate=new Promise<void>(r=>{complete=r;}),db=database();
 const options={db,namespace:'synthetic',read:async()=>stored,start:async()=>{starts++;await gate;stored=report;return report;}};
 const first=requestPostHogReport(filters,'quiz',options),second=requestPostHogReport(filters,'quiz',options);await new Promise(r=>setImmediate(r));assert.equal(starts,1);complete();
 assert.deepEqual(await first,await second);assert.equal((await requestPostHogReport(filters,'quiz',options)).state,'ready');assert.equal(starts,1);
});
test('An occupied stream returns waiting then resumes; an expired lease does not block forever',async()=>{
 let busy=true,stored:typeof report|null=null,starts=0;const now=Date.parse('2026-09-08T12:00:00Z');const db=database(()=>busy?[{started_at:'2026-09-08T11:59:00Z'}]:[]);
 const options={db,namespace:'synthetic',now:()=>now,read:async()=>stored,start:async()=>{starts++;stored=report;return report;}};
 assert.equal((await requestPostHogReport(filters,'quiz',options)).state,'waiting');assert.equal(starts,0);busy=false;
 assert.equal((await requestPostHogReport(filters,'quiz',options)).state,'ready');assert.equal(starts,1);
 stored=null;assert.equal((await requestPostHogReport(filters,'quiz',{...options,db:database(()=>[{started_at:'2026-09-08T11:00:00Z'}])})).state,'ready');
});
test('Measured empty reports are ready; unsupported masterclass filters never fall back to global',async()=>{
 assert.equal((await requestPostHogReport(filters,'quiz',{db:database(),namespace:'synthetic',read:async()=>({...report,status:'empty'})})).empty,true);
 const result=await requestPostHogReport(filters,'masterclass',{db:database(()=>assert.fail()),namespace:'synthetic',read:async()=>assert.fail(),start:async()=>assert.fail()});assert.equal(result.state,'unsupported');
 const request=postHogReportRequest({...filters,from:'2026-03-28',to:'2026-03-30'},'quiz')!;assert.equal(request.from,'2026-03-28');assert.equal(request.to,'2026-03-31');assert.match(request.profile,/aggregates-v2/);
});
test('A waiting retry refreshes a cached absence after another worker publishes',async()=>{
 const old=process.env.POSTHOG_PROJECT_ID;process.env.POSTHOG_PROJECT_ID='synthetic';
 try{
  let available=false,reads=0;const request=postHogReportRequest(filters,'quiz')!;
  const run={id:'published',status:'empty',query_profile_key:request.profile,period_from:'2026-08-19T22:00:00Z',period_to:'2026-09-02T22:00:00Z',pagination_complete:true,finished_at:report.observedAt,source_as_of:report.observedAt};
  const db=database(()=>[{started_at:'2026-09-08T11:59:00Z'}]);
  db.rpc=async<T>(name:string)=>{assert.equal(name,'cockpit_source_window');reads++;return {runs:available?[run]:[],aggregates:available?[{sync_run_id:run.id,report_profile_key:request.profile,period_from:run.period_from,period_to:run.period_to,dimensions_key:'all',dimensions:{},metric_key:'posthog_events',value:0,unit:'count',timezone:'Europe/Paris'}]:[],selections:[],validations:{},exactRunId:available?run.id:null,latestAttempt:null} as T;};
  const options={db,namespace:'synthetic',now:()=>Date.parse('2026-09-08T12:00:00Z'),start:async()=>assert.fail('other worker owns the stream')};
  assert.equal((await requestPostHogReport(filters,'quiz',options)).state,'waiting');available=true;
  assert.equal((await requestPostHogReport(filters,'quiz',options)).state,'ready');assert.equal(reads,2);
 }finally{if(old===undefined)delete process.env.POSTHOG_PROJECT_ID;else process.env.POSTHOG_PROJECT_ID=old;}
});
test('Distinct masterclass pages and projects have distinct selection identities',()=>{
 const selected={...filters,source:'all' as const,campaign:'',tunnel:'masterclass' as const};
 const first={quizHost:'quiz.example.test',productionHosts:['quiz.example.test','www.example.test'],masterclassPageId:'first'};
 const a=postHogReportRequest(selected,'masterclass',first,'project-A')!;
 const b=postHogReportRequest(selected,'masterclass',{...first,masterclassPageId:'second'},'project-A')!;
 const c=postHogReportRequest(selected,'masterclass',first,'project-B')!;
 assert.notEqual(a.key,b.key);assert.notEqual(a.key,c.key);assert.notEqual(a.profile,b.profile);
});
test('Default dependencies reject a namespace mismatch before reading the environment project',async()=>{
 const old=process.env.POSTHOG_PROJECT_ID;process.env.POSTHOG_PROJECT_ID='project-A';
 try{let calls=0;const db=database(()=>{calls++;return[];});db.rpc=async()=>{calls++;throw Error('must not query');};
  const result=await requestPostHogReport(filters,'quiz',{db,namespace:'project-B'});assert.equal(result.state,'failed');assert.equal(calls,0);
 }finally{if(old===undefined)delete process.env.POSTHOG_PROJECT_ID;else process.env.POSTHOG_PROJECT_ID=old;}
});
test('Open free windows refresh after fifteen minutes in Paris; failed renewal cannot validate the old report',async()=>{
 const now=Date.parse('2026-09-08T22:05:00Z'),selected={...filters,from:'2026-09-01',to:'2026-09-09'};
 const old={...report,observedAt:'2026-09-08T21:00:00Z'};let stored=old,starts=0;
 const options={db:database(),namespace:'synthetic',now:()=>now,read:async()=>stored,start:async()=>{starts++;return {...report,observedAt:'2026-09-08T22:04:00Z'};}};
 assert.equal((await requestPostHogReport(selected,'quiz',options)).state,'failed');assert.equal(starts,1);
 const renewed=await requestPostHogReport(selected,'quiz',{...options,start:async()=>{starts++;stored={...report,observedAt:'2026-09-08T22:04:00Z'};return stored;}});
 assert.equal(renewed.state,'ready');assert.equal(starts,2);
 assert.equal((await requestPostHogReport(selected,'quiz',options)).state,'ready');assert.equal(starts,2);
});
test('Missing timestamps refresh; a report observed before closure gets a final read, while closed history is reused',async()=>{
 const now=Date.parse('2026-09-08T22:05:00Z');
 for(const [from,to,observedAt,refresh] of [
  ['2026-09-09','2026-09-09',null,true],['2026-09-09','2026-09-09','invalid',true],
  ['2026-09-01','2026-09-08','2026-09-08T21:58:00Z',true],
  ['2026-08-01','2026-08-31','2026-09-01T12:00:00Z',false],
 ] as const){let starts=0;const result=await requestPostHogReport({...filters,from,to},'quiz',{db:database(),namespace:'synthetic',now:()=>now,read:async()=>({...report,observedAt}),start:async()=>{starts++;return null;}});
 assert.equal(starts,refresh?1:0);assert.equal(result.state,refresh?'failed':'ready');}
});
