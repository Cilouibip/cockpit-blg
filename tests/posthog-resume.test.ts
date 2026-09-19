import {test} from 'node:test';
import assert from 'node:assert/strict';
import {synchronizePostHogReport} from '../src/lib/sync-posthog-reports';
import {readPostHogMasterclassAnalytics,type PostHogAnalyticsConfig,type PreparedPostHogAnalytics,type PostHogAnalyticsReport,type PostHogMasterclassReport} from '../src/connectors/posthog-analytics';
import type {Row} from '../src/lib/db';
import {postHogSyncMemory,syntheticPostHogEnv} from './helpers/posthog-sync';

const from='2026-01-02',to='2026-01-04';
const prepared=(names:string[],deadline=Date.now()+20_000):PreparedPostHogAnalytics=>({endpoint:new URL('https://eu.posthog.com'),headers:{Authorization:'Bearer synthetic'},schema:{sessionIdAvailable:true,questionNumberProperty:null},queries:Object.fromEntries(names.map(name=>[name,'SELECT synthetic'])),deadline,signal:new AbortController().signal});
const quizReport=():PostHogAnalyticsReport=>({source:'posthog',connectorVersion:'posthog-production-aggregates-v2',projectId:'123',from:'2026-01-01T23:00:00Z',to:'2026-01-03T23:00:00Z',timezone:'Europe/Paris',observedAt:null,status:'complete',overview:{events:7,visitors:4,sessions:4,eventsWithVisitorId:7,eventsWithSessionId:7},daily:[],byEvent:[],byHostEvent:[],questions:[],schema:{sessionIdAvailable:true,questionNumberProperty:null},scope:{source:'all',campaignId:null},client:{quizHost:'quizz.blg-studio.fr',productionHosts:['quizz.blg-studio.fr','www.blg-studio.fr'],masterclassPageId:'blg-rugby-mc'},coverage:{queryComplete:true,allTrafficComplete:false,firstObservedAt:null,lastObservedAt:null,observedTrackedEvents:7,excludedHostEvents:0,missingHostEvents:0,conflictingHostEvents:0,identifiableTestEvents:0,reason:'synthetic'},semantics:{visitorIdentity:'distinct_id',sessionIdentity:'$session_id',verifiedBackendLeads:false,sequentialFunnel:false}});
const mcReport=():PostHogMasterclassReport=>({source:'posthog',profile:'synthetic',from:'2026-01-01T23:00:00Z',to:'2026-01-03T23:00:00Z',observedAt:null,status:'complete',byEvent:[{event:'mc_page_view',events:4,visitors:3,kitSessions:2,eventsWithVisitorId:4,eventsWithKitSessionId:4,verifiedHostEvents:4,unlocatedEvents:0,excludedEvents:0}],coverage:{queryComplete:true,hostVerified:true,reason:'synthetic'}});

test('quiz four- and five-query plans checkpoint every query before one atomic publication',async()=>{
 for(const names of [['overview','byEvent','byHostEvent','daily'],['overview','byEvent','byHostEvent','daily','questions']]){
  const memory=postHogSyncMemory();const seen:string[]=[];
  const report=await synchronizePostHogReport('quiz',from,to,{db:memory.db,env:syntheticPostHogEnv,prepare:async()=>prepared(names),reader:async config=>{
   for(const name of names){await config.execution!.save(name as never,{version:1,id:`id-${name}`,origin:'https://eu.posthog.com',projectId:'123',queryHash:name,startedAt:Date.now()},true);seen.push(name);}
   return quizReport();
  }});
  assert.equal(report?.status,'complete');assert.deepEqual(seen,names);assert.equal(memory.receivedRPCcounts('cockpit_save_posthog_query'),names.length);assert.equal(memory.receivedRPCcounts('cockpit_publish_posthog'),1);assert.equal(memory.runs[0].status,'complete');
 }
});

test('real masterclass driver saves its query id before POST and publishes only after completion',async()=>{
 const memory=postHogSyncMemory();let postBody:Record<string,unknown>|undefined;const order:string[]=[];
 const report=await synchronizePostHogReport('masterclass',from,to,{db:memory.db,env:syntheticPostHogEnv,fetcher:async(input,init)=>{
  const url=new URL(String(input));
  if(url.pathname==='/api/projects/123/') {order.push('preflight');return Response.json({id:123});}
  if(init?.method==='POST') {order.push('post');assert.equal(memory.receivedRPCcounts('cockpit_save_posthog_query'),1);const body=JSON.parse(String(init.body)) as Record<string,unknown>;postBody=body;const id=String(body.client_query_id);return Response.json({query_status:{id,team_id:123,complete:true,results:{columns:['event','events','visitors','kit_sessions','events_with_visitor_id','events_with_kit_session_id','verified_host_events','unlocated_events','excluded_events'],results:[['mc_page_view',4,3,2,4,4,4,0,0]]}}});}
  throw Error(`unexpected synthetic request ${url}`);
 }});
 assert.equal(report?.status,'complete');assert.deepEqual(order,['preflight','post']);assert.equal(memory.receivedRPCcounts('cockpit_save_posthog_query'),3);assert.equal(memory.receivedRPCcounts('cockpit_publish_posthog'),1);if(!postBody)assert.fail('missing synthetic POST body');assert.equal(typeof postBody.client_query_id,'string');assert.equal(memory.storedRows().length,2);
});

test('a pending masterclass reuses its durable query id without a second POST',async()=>{
 const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
 try{
  const memory=postHogSyncMemory();let posts=0,gets=0;const first=await synchronizePostHogReport('masterclass',from,to,{db:memory.db,env:syntheticPostHogEnv,prepare:async()=>prepared(['masterclass']),fetcher:async(_input,init)=>{
   if(init?.method==='POST'){posts++;const id=String(JSON.parse(String(init.body)).client_query_id);now+=19_000;return Response.json({query_status:{id,team_id:123,complete:false}},{status:202});}throw Error('first run must leave before a GET');
  }});
  assert.equal(first?.status,'pending');assert.equal(memory.runs[0].status,'pending');assert.equal(memory.receivedRPCcounts('cockpit_release_posthog'),1);
  const second=await synchronizePostHogReport('masterclass',from,to,{db:memory.db,env:syntheticPostHogEnv,prepare:async()=>prepared(['masterclass']),fetcher:async(_input,init)=>{
   assert.equal(init?.method,'GET');gets++;const id=String((memory.runs[0].checkpoint.masterclass.continuation as Row).id);return Response.json({query_status:{id,team_id:123,complete:true,results:{columns:['event','events','visitors','kit_sessions','events_with_visitor_id','events_with_kit_session_id','verified_host_events','unlocated_events','excluded_events'],results:[['mc_page_view',1,1,1,1,1,1,0,0]]}}});
  }});
  assert.equal(second?.status,'complete',JSON.stringify(second));assert.equal(posts,1);assert.equal(gets,1);assert.equal(memory.runs.length,1);assert.equal(memory.runs[0].checkpoint.masterclass.complete,true);
 }finally{Date.now=originalNow;}
});

test('three missing query reads fail cleanly without resubmitting and retain the prior publication',async()=>{
 const memory=postHogSyncMemory();let posts=0,gets=0;const firstPrepared=prepared(['masterclass']);
 await synchronizePostHogReport('masterclass',from,to,{db:memory.db,env:syntheticPostHogEnv,prepare:async()=>firstPrepared,fetcher:async(_input,init)=>{
  if(init?.method==='POST'){posts++;const id=String(JSON.parse(String(init.body)).client_query_id);firstPrepared.deadline=Date.now()+1_700;return Response.json({query_status:{id,team_id:123,complete:false}},{status:202});}
  throw Error('first run must not poll');
 }});
 const report=await synchronizePostHogReport('masterclass',from,to,{db:memory.db,env:syntheticPostHogEnv,prepare:async()=>prepared(['masterclass']),fetcher:async(_input,init)=>{
  assert.equal(init?.method,'GET');
  gets++;return Response.json({detail:'missing'},{status:404});
 }});
 assert.equal(report?.status,'failed');assert.equal(posts,1);assert.equal(gets,3);assert.equal(memory.receivedRPCcounts('cockpit_publish_posthog'),0);assert.equal(memory.runs[0].status,'failed');
});

test('forbidden, truncated and oversized results fail without publication; a lost publication acknowledgement stays visible',async()=>{
 for(const code of ['ACCESS_DENIED_HTTP_403','POSTHOG_RESULT_LIMIT','RESPONSE_TOO_LARGE']){
  const memory=postHogSyncMemory();const report=await synchronizePostHogReport('masterclass',from,to,{db:memory.db,env:syntheticPostHogEnv,prepare:async()=>prepared(['masterclass']),reader:async()=>({...mcReport(),status:'failed',safeError:code,coverage:{...mcReport().coverage,queryComplete:false}})});
  assert.equal(report?.status,'failed');assert.equal(memory.receivedRPCcounts('cockpit_publish_posthog'),0);assert.equal(memory.runs[0].status,'failed');
 }
 const ambiguous=postHogSyncMemory({failPublishAck:true});const report=await synchronizePostHogReport('masterclass',from,to,{db:ambiguous.db,env:syntheticPostHogEnv,prepare:async()=>prepared(['masterclass']),reader:async config=>{await config.execution!.save('masterclass',{version:1,id:'mc-final',origin:'https://eu.posthog.com',projectId:'123',queryHash:'mc',startedAt:Date.now()},true);return mcReport();}});
 assert.equal(report?.status,'complete');assert.equal(ambiguous.receivedRPCcounts('cockpit_publish_posthog'),2);assert.equal(ambiguous.receivedRPCcounts('cockpit_release_posthog'),0);assert.equal(ambiguous.runs[0].status,'complete');
});
