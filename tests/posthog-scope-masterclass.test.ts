import {windowFixture} from './helpers/source-window';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {postHogAggregateQueries,postHogScopeProfile,POSTHOG_DEFAULT_CLIENT,postHogMasterclassQuery,readPostHogMasterclassAnalytics,type PostHogAnalyticsConfig} from '../src/connectors/posthog-analytics';
import {applyPostHogQuiz,applyPostHogMasterclass,postHogPeriod,postHogScopeFromFilters,readPostHogPeriod,postHogMasterclassPeriod,readPostHogMasterclassPeriod,type DashboardPostHogReport} from '../src/lib/posthog-dashboard';
import {emptyDashboard} from '../src/lib/dashboard';
import type {DashboardFilters} from '../src/lib/ui-contract';
import type {Database,Row} from '../src/lib/db';
const from='2026-01-01T23:00:00Z',to='2026-01-03T23:00:00Z';
const scope={source:'paid' as const,campaignId:'12345'},schema={sessionIdAvailable:true,questionNumberProperty:'numero' as const};
const filters:DashboardFilters={from:'2026-01-02',to:'2026-01-03',source:'paid',tunnel:'quiz',campaign:'meta:12345',compare:false};
const client={quizHost:'quiz.example.test',productionHosts:['quiz.example.test','www.example.test'],masterclassPageId:'synthetic-mc'};
const mcRows=[['mc_page_view',4,3,2,4,4,0,4,0],['mc_visibility_change',2,1,1,2,2,0,2,0]];
function mcConfig(rows:unknown[][]=mcRows):PostHogAnalyticsConfig{
 let n=0;return {host:'https://eu.posthog.com',projectId:'123',personalApiKey:'SYNTHETIC',from,to,client,now:()=> '2026-02-01T00:00:00Z',fetcher:(async()=>new Response(JSON.stringify(n++===0?{id:123}:{columns:['event','events','visitors','kit_sessions','events_with_visitor_id','events_with_kit_session_id','verified_host_events','unlocated_events','excluded_events'],results:rows}),{status:200}))as typeof fetch};
}
test('Each PostHog query uses the selected UTM scope; profile separates custom clients and scopes',()=>{
 const queries=postHogAggregateQueries(from,to,schema,scope,client);
 for(const sql of Object.values(queries)){assert.match(sql!,/utm_campaign/);assert.match(sql!,/'12345'/);assert.match(sql!,/utm_medium/);assert.match(sql!,/uniqExactIf/);assert.doesNotMatch(sql!,/blg-studio/);}
 assert.notEqual(postHogScopeProfile(scope),postHogScopeProfile());assert.notEqual(postHogScopeProfile(scope,client),postHogScopeProfile(scope,POSTHOG_DEFAULT_CLIENT));
 assert.throws(()=>postHogAggregateQueries(from,to,schema,{...scope,campaignId:"12' OR 1=1"},client),/INVALID_POSTHOG_SCOPE/);
 assert.equal(postHogScopeFromFilters({...filters,campaign:'ad:12345'}),null);assert.deepEqual(postHogScopeFromFilters(filters),scope);
});
test('Matching campaign scope can display exact period distincts; global and different scope cannot',()=>{
 const report:DashboardPostHogReport={from,to,observedAt:to,status:'complete',coverage:{queryComplete:true},scope,client,byEvent:[{event:'$pageview',events:9,visitors:3,sessions:4}],byHostEvent:[{host:client.quizHost,event:'$pageview',events:9,visitors:3,sessions:4}],questions:[]};
 assert.equal(applyPostHogQuiz(emptyDashboard(filters,'live'),report,filters).journeys.find(j=>j.id==='quiz')!.steps[0].value,3);
 for(const wrong of [{...report,scope:undefined},{...report,scope:{...scope,campaignId:'999'}}]){const data=emptyDashboard(filters,'live'),before=structuredClone(data);assert.deepEqual(applyPostHogQuiz(data,wrong,filters),before);}
});
test('A stored global report is never read as a selected campaign report',async()=>{
 const old=process.env.POSTHOG_PROJECT_ID;process.env.POSTHOG_PROJECT_ID='123';
 try{
  const db:Database={probe:async()=>{},upsert:async()=>assert.fail(),rpc:async<T>(name:string)=>{assert.equal(name,'cockpit_source_window');return {runs:[],aggregates:[],selections:[],validations:{},exactRunId:null,latestAttempt:null} as T;},select:async table=>table==='sync_runs'?[{id:'global',query_profile_key:postHogScopeProfile(),period_from:from,period_to:to,pagination_complete:true,finished_at:to}]:[{sync_run_id:'global',dimensions_key:'all',metric_key:'posthog_events',value:9}]};
  assert.equal(await readPostHogPeriod(db,'2026-01-02','2026-01-04',{scope}),null);
 }finally{if(old===undefined)delete process.env.POSTHOG_PROJECT_ID;else process.env.POSTHOG_PROJECT_ID=old;}
});
test('Masterclass observations preserve period identities and distinguish kit sessions from host coverage',async()=>{
 const query=postHogMasterclassQuery(from,to,client);assert.match(query,/properties.sid/);assert.doesNotMatch(query,/properties.\$session_id/);assert.match(query,/page_id/);assert.match(query,/GROUP BY event/);
 const report=await readPostHogMasterclassAnalytics(mcConfig());assert.equal(report.status,'complete');assert.equal(report.byEvent[0].visitors,3);assert.equal(report.byEvent[0].kitSessions,2);assert.equal(report.coverage.hostVerified,false);
 const selected={...filters,source:'all' as const,campaign:'',tunnel:'masterclass' as const},data=emptyDashboard(selected,'live');
 const result=applyPostHogMasterclass(data,report,selected),journey=result.journeys.find(j=>j.id==='masterclass')!;
 assert.match(journey.description,/6 événement.*6 sans adresse/);assert.equal(journey.steps[0].value,4);assert.equal(journey.steps[0].id,'kit_page_observations');
 assert.ok(journey.steps.slice(1).every(s=>s.value===null));assert.equal(result.metrics.find(m=>m.id==='leads')!.value,null);assert.equal(result.metrics.find(m=>m.id==='appointments')!.value,null);
});
test('Missing identities, wrong coverage and duplicate MC groups never manufacture available metrics',async()=>{
 const missing=await readPostHogMasterclassAnalytics(mcConfig([['mc_page_view',4,0,0,0,0,0,4,0]]));assert.equal(missing.byEvent[0].visitors,null);assert.equal(missing.byEvent[0].kitSessions,null);
 for(const data of [[...mcRows,mcRows[0]],[['mc_page_view',4,3,2,4,4,3,4,0]]]){const report=await readPostHogMasterclassAnalytics(mcConfig(data));assert.equal(report.status,'failed');assert.deepEqual(report.byEvent,[]);}
 const scoped=await readPostHogMasterclassAnalytics({...mcConfig(),scope});assert.equal(scoped.status,'failed');assert.equal(scoped.safeError,'POSTHOG_SCOPE_UNAVAILABLE');
});
test('Masterclass imports publish a separate stream and exact period only, retaining last good report',async()=>{
 const keys=['POSTHOG_HOST','POSTHOG_PROJECT_ID','POSTHOG_PERSONAL_API_KEY'],old=keys.map(k=>process.env[k]);Object.assign(process.env,{POSTHOG_HOST:'https://eu.posthog.com',POSTHOG_PROJECT_ID:'123',POSTHOG_PERSONAL_API_KEY:'SYNTHETIC'});
 try{
  const store:Record<string,Row[]>={sync_runs:[],source_aggregates:[]};let serial=0;
  const db:Database={probe:async()=>{},select:async(t,o)=>store[t].filter(r=>Object.entries(o?.eq??{}).every(([k,v])=>String(r[k])===v)).slice(o?.from??0,(o?.from??0)+(o?.limit??1000)),upsert:async(t,r)=>{store[t].push(...r);},rpc:async<T>(name:string,args:Row)=>{
   if(name==='cockpit_source_window')return windowFixture(store.sync_runs,store.source_aggregates,args) as T;
   if(name==='begin_sync_stream'){const id=`r${++serial}`;store.sync_runs.push({id,source:'posthog',source_namespace:'123',status:'running',stream_key:args.p_stream,query_profile_key:args.p_profile,period_from:args.p_from,period_to:args.p_to});return id as T;}
   const run=store.sync_runs.find(r=>r.id===args.p_run)!;Object.assign(run,{status:args.p_status,pagination_complete:args.p_complete,finished_at:to});return true as T;
  }};
  await postHogMasterclassPeriod('2026-01-02','2026-01-04',{db,client,reader:()=>readPostHogMasterclassAnalytics(mcConfig())});
  assert.equal(store.sync_runs[0].stream_key,'masterclass_observations');
  await postHogMasterclassPeriod('2026-01-02','2026-01-04',{db,client,reader:async()=>{throw Error('SYNTHETIC');}});
  assert.equal(store.sync_runs[1].status,'failed');assert.equal((await readPostHogMasterclassPeriod(db,'2026-01-02','2026-01-04',{client}))?.byEvent[0].events,4);
  assert.equal(await readPostHogMasterclassPeriod(db,'2026-01-03','2026-01-04',{client}),null);
 }finally{keys.forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];});}
});

test('Quiz refresh claims its dedicated stream and only coalesces matching in-flight scopes',async()=>{
 const keys=['POSTHOG_HOST','POSTHOG_PROJECT_ID','POSTHOG_PERSONAL_API_KEY'],old=keys.map(k=>process.env[k]);Object.assign(process.env,{POSTHOG_HOST:'https://eu.posthog.com',POSTHOG_PROJECT_ID:'123',POSTHOG_PERSONAL_API_KEY:'SYNTHETIC'});
 try{
  const starts:Row[]=[];let queries=0;let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
  const db:Database={probe:async()=>{},select:async()=>[],upsert:async()=>{},rpc:async<T>(name:string,args:Row)=>{if(name==='begin_sync_stream')starts.push(args);return 'run' as T;}};
  const reader:typeof import('../src/connectors/posthog-analytics').readPostHogAnalytics=async()=>{queries++;await gate;return {status:'failed',coverage:{queryComplete:false},byEvent:[],byHostEvent:[],questions:[],overview:null} as unknown as import('../src/connectors/posthog-analytics').PostHogAnalyticsReport;};
  const first=postHogPeriod('2026-01-02','2026-01-04',{db,reader,scope}),same=postHogPeriod('2026-01-02','2026-01-04',{db,reader,scope}),different=postHogPeriod('2026-01-02','2026-01-04',{db,reader});
  release();await Promise.all([first,same,different]);assert.equal(queries,2);assert.equal(starts.length,2);assert.ok(starts.every(r=>r.p_stream==='quiz_observations'));assert.notEqual(starts[0].p_profile,starts[1].p_profile);
 }finally{keys.forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];});}
});
