import test from 'node:test';
import assert from 'node:assert/strict';
import { latestConnectionRun, connectionFreshness, readConnectionRuns } from '../src/lib/connections';
import type { Database, Row } from '../src/lib/db';

const run=(source:string,stream:string,startedAt:string)=>({source,stream_key:stream,started_at:startedAt,status:'complete'});
test('chaque carte Connexions ignore les imports d’un autre flux',()=>{
 const runs=[
  run('meta','ad_daily','2026-09-08T08:00:00Z'),run('meta','ad_creative_metadata','2026-09-09T08:00:00Z'),
  run('notion','prospects_business','2026-09-07T08:00:00Z'),run('notion','lead_entries_client_history','2026-09-09T08:00:00Z'),
  run('wix','payments_analytics','2026-09-06T08:00:00Z'),run('wix','lead_entries_quiz','2026-09-09T08:00:00Z'),
  run('posthog','quiz_observations','2026-09-07T08:00:00Z'),run('posthog','masterclass_observations','2026-09-08T08:00:00Z'),
 ];
 assert.equal(latestConnectionRun(runs,'meta',['ad_daily'])?.stream_key,'ad_daily');
 assert.equal(latestConnectionRun(runs,'notion',['prospects_business'])?.stream_key,'prospects_business');
 assert.equal(latestConnectionRun(runs,'wix',['payments_analytics'])?.stream_key,'payments_analytics');
 assert.equal(latestConnectionRun(runs,'posthog',['quiz_observations','masterclass_observations'])?.stream_key,'masterclass_observations');
 assert.equal(latestConnectionRun(runs,'wix',['receipt_observations']),undefined);
});

const checkedAt=Date.parse('2026-09-18T15:00:00Z');
const publication=(stream:string,startedAt:string,finishedAt:string):Row=>({source:'wix',stream_key:stream,status:'complete',started_at:startedAt,finished_at:finishedAt,pagination_complete:true});
test('une tentative échouée ne remplace pas la date de dernière publication',()=>{
 const completed=publication('lead_entries_forms','2026-09-18T14:20:00Z','2026-09-18T14:25:00Z');
 const failed={...publication('lead_entries_forms','2026-09-18T14:50:00Z','2026-09-18T14:51:00Z'),status:'failed'};
 const state=connectionFreshness([failed,completed],'wix',['lead_entries_forms'],checkedAt);
 assert.equal(state.lastSyncAt,'2026-09-18T14:25:00.000Z');
 assert.equal(state.lastAttemptAt,'2026-09-18T14:50:00Z');assert.equal(state.failed,true);assert.equal(state.fresh,true);
});
test('un scan ancien terminé maintenant ne rend pas ses données récentes',()=>{
 const row={...publication('lead_entries_forms','2026-09-18T06:00:00Z','2026-09-18T14:59:00Z'),period_to:'2026-09-18T06:00:00Z'};
 const state=connectionFreshness([row],'wix',['lead_entries_forms'],checkedAt);
 assert.equal(state.lastSyncAt,'2026-09-18T14:59:00.000Z');assert.equal(state.dataAsOf,'2026-09-18T06:00:00.000Z');assert.equal(state.fresh,false);
});
test('la carte des inscriptions attend Forms et Quiz et expose le plus ancien',()=>{
 const forms=publication('lead_entries_forms','2026-09-18T14:50:00Z','2026-09-18T14:51:00Z');
 const streams=['lead_entries_forms','lead_entries_quiz'];
 const missing=connectionFreshness([forms],'wix',streams,checkedAt);assert.equal(missing.allPublished,false);assert.equal(missing.lastSyncAt,null);assert.equal(missing.fresh,false);
 const quiz=publication('lead_entries_quiz','2026-09-18T12:00:00Z','2026-09-18T12:01:00Z');
 const old=connectionFreshness([forms,quiz],'wix',streams,checkedAt);assert.equal(old.lastSyncAt,'2026-09-18T12:01:00.000Z');assert.equal(old.fresh,false);
 const failure={...quiz,started_at:'2026-09-18T14:40:00Z',status:'failed'};
 assert.equal(connectionFreshness([forms,quiz,failure],'wix',streams,checkedAt).failed,true);
});
test('une lecture partielle et une date future ne deviennent jamais une publication récente',()=>{
 const row=publication('lead_entries_forms','2026-09-18T15:20:00Z','2026-09-18T15:21:00Z');
 assert.equal(connectionFreshness([row],'wix',['lead_entries_forms'],checkedAt).fresh,false);
 assert.equal(connectionFreshness([{...row,pagination_complete:false}],'wix',['lead_entries_forms'],checkedAt).lastSyncAt,null);
});
test('les dates de connexion recherchent le succès du profil courant indépendamment des tentatives',async()=>{
 let reads=0;
 const db:Database={select:async(_table,options)=>{
   reads++;assert.equal(options?.eq?.source_namespace,'synthetic-notion');assert.equal(options?.eq?.stream_key,'prospects_business');assert.ok(options?.eq?.query_profile_key);
   if(options?.in?.status){assert.equal(options.eq.pagination_complete,'true');assert.equal(options.limit,1);return [{source:'notion',stream_key:'prospects_business',status:'complete',finished_at:'2026-09-18T01:35:00Z'}];}
   return [{source:'notion',stream_key:'prospects_business',status:'failed',started_at:'2026-09-18T14:50:00Z'}];
 },rpc:async()=>{throw Error('unexpected');},upsert:async()=>{throw Error('write forbidden');},probe:async()=>{}};
 const rows=await readConnectionRuns(db,{NODE_ENV:'test',NOTION_DATA_SOURCE_ID:'synthetic-notion'} as NodeJS.ProcessEnv);
 assert.equal(reads,2);assert.equal(rows.length,2);assert.ok(rows.some(row=>row.status==='complete'));
});
test('une source inaccessible conserve les dates des autres connexions',async()=>{
 const db:Database={select:async(_table,options)=>{
   if(options?.eq?.source==='notion')throw Error('synthetic unavailable');
   return [{source:'posthog',stream_key:options?.eq?.stream_key,status:'complete'}];
 },rpc:async()=>{throw Error('unexpected');},upsert:async()=>{throw Error('write forbidden');},probe:async()=>{}};
 const rows=await readConnectionRuns(db,{NODE_ENV:'test',NOTION_DATA_SOURCE_ID:'synthetic-notion',POSTHOG_PROJECT_ID:'123'} as NodeJS.ProcessEnv);
 assert.ok(rows.length>0);assert.ok(rows.every(row=>row.source==='posthog'));
});
