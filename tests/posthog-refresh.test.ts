import {test} from 'node:test';
import assert from 'node:assert/strict';
import {postHogPeriod} from '../src/lib/posthog-dashboard';
import type {PostHogAnalyticsConfig,PostHogAnalyticsReport,PreparedPostHogAnalytics} from '../src/connectors/posthog-analytics';
import {postHogSyncMemory,syntheticPostHogEnv} from './helpers/posthog-sync';

const plan=():PreparedPostHogAnalytics=>({endpoint:new URL('https://eu.posthog.com'),headers:{},schema:{sessionIdAvailable:true,questionNumberProperty:null},queries:{overview:'synthetic',byEvent:'synthetic',byHostEvent:'synthetic',daily:'synthetic'},deadline:Date.now()+20_000,signal:new AbortController().signal});
const empty=():PostHogAnalyticsReport=>({source:'posthog',connectorVersion:'posthog-production-aggregates-v2',projectId:'123',from:'2026-09-06T22:00:00Z',to:'2026-09-07T22:00:00Z',timezone:'Europe/Paris',observedAt:null,status:'empty',overview:{events:0,visitors:0,sessions:0,eventsWithVisitorId:0,eventsWithSessionId:0},daily:[],byEvent:[],byHostEvent:[],questions:[],schema:{sessionIdAvailable:true,questionNumberProperty:null},scope:{source:'all',campaignId:null},coverage:{queryComplete:true,allTrafficComplete:false,firstObservedAt:null,lastObservedAt:null,observedTrackedEvents:0,excludedHostEvents:0,missingHostEvents:0,conflictingHostEvents:0,identifiableTestEvents:0,reason:'synthetic'},semantics:{visitorIdentity:'distinct_id',sessionIdentity:'$session_id',verifiedBackendLeads:false,sequentialFunnel:false}});

test('explicit PostHog refresh retries after a failed durable attempt and does not cache the result',async()=>{
 const memory=postHogSyncMemory();let calls=0;
 const reader=async(config:PostHogAnalyticsConfig)=>{
  if(++calls===1)throw Error('synthetic source failure');
  for(const name of Object.keys(config.prepared!.queries))await config.execution!.save(name as never,{version:1,id:`retry-${name}`,origin:'https://eu.posthog.com',projectId:'123',queryHash:name,startedAt:Date.now()},true);
  return empty();
 };
 const first=await postHogPeriod('2026-09-07','2026-09-08',{db:memory.db,env:syntheticPostHogEnv,prepare:async()=>plan(),reader});
 const second=await postHogPeriod('2026-09-07','2026-09-08',{db:memory.db,env:syntheticPostHogEnv,prepare:async()=>plan(),reader});
 const third=await postHogPeriod('2026-09-07','2026-09-08',{db:memory.db,env:syntheticPostHogEnv,prepare:async()=>plan(),reader});
 assert.equal(first?.status,'failed');assert.equal(second?.status,'empty');assert.equal(third?.status,'empty');assert.equal(calls,3);assert.deepEqual(memory.runs.map(run=>run.status),['failed','complete','complete']);
});
