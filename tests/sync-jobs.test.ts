import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseSyncJob,tickSyncJobs,type SyncJob} from '../src/lib/sync-jobs';
import type {Database,Row} from '../src/lib/db';

const now=1_000_000;
const run=(source:string,stream:string,finishedAt:number,status='complete'):Row=>({source,source_namespace:source,stream_key:stream,status,finished_at:new Date(finishedAt).toISOString(),started_at:new Date(finishedAt).toISOString()});

test('the oldest due stream wins again after another stream has completed',()=>{
 const enabled=['notion','meta'] as const;
 const first=[run('notion','prospects_business',now-7_200_000),run('meta','meta_account_daily',now-3_600_000)];
 assert.equal(chooseSyncJob(first,now,[...enabled]),'notion');
 const second=[...first,run('notion','prospects_business',now)];
 assert.equal(chooseSyncJob(second,now,[...enabled]),'meta');
});

test('an active lease and a failed backoff defer only their own stream',()=>{
 const enabled=['notion','meta','wix'] as const;
 const rows=[
  {...run('notion','prospects_business',now-7_200_000,'running'),lease_until:new Date(now+60_000).toISOString()},
  run('meta','meta_account_daily',now-60_000,'failed'),
  run('wix','payments_analytics',now-7_200_000),
 ];
 assert.equal(chooseSyncJob(rows,now,[...enabled]),'wix');
});

const environment={COCKPIT_MODE:'live',NOTION_DATA_SOURCE_ID:'notion',META_AD_ACCOUNT_ID:'meta'} as unknown as NodeJS.ProcessEnv;
const stream:Record<SyncJob,[string,string]>={notion:['notion','prospects_business'],meta:['meta','meta_account_daily'],wix:['wix','payments_analytics'],receipts:['wix','receipt_observations'],meta_ads:['meta','ad_daily'],quiz:['posthog','quiz_observations'],masterclass:['posthog','masterclass_observations']};
function tickDatabase(rows:Row[]):Database{return {select:async(_table,options)=>rows.filter(row=>Object.entries(options?.eq??{}).every(([key,value])=>key==='query_profile_key'||String(row[key])===value)),upsert:async()=>assert.fail('no aggregate write in scheduler test'),rpc:async()=>assert.fail('no rpc in scheduler test'),probe:async()=>{}};}
function budget(canStart:(max:number)=>boolean){return {sourceFetch:async()=>new Response('{}'),canStart,dispose:()=>{}};}

test('one budgeted tick progresses several Notion chunks and serves another due stream',async()=>{
 const rows:Row[]=[{...run('notion','prospects_business',now-7_200_000,'running'),lease_until:new Date(now-7_200_000).toISOString()},{...run('meta','meta_account_daily',now-3_600_000)},{...run('meta','ad_daily',now)}],db=tickDatabase(rows),jobs:SyncJob[]=[];
 const result=await tickSyncJobs(db,environment,{now:()=>now,budget:budget(()=>true),execute:async job=>{jobs.push(job);const [source,key]=stream[job],row=rows.find(r=>r.source===source&&r.stream_key===key)!;Object.assign(row,job==='notion'?{status:'running',lease_until:new Date(now-1).toISOString(),started_at:new Date(now).toISOString()}:{status:'complete',finished_at:new Date(now).toISOString(),started_at:new Date(now).toISOString()});return {status:job==='notion'?'partial':'complete'};}});
 assert.deepEqual(jobs,['notion','meta','notion','notion','notion']);assert.equal('units' in result&&result.units,5);
});

test('a spent budget starts no further unit',async()=>{
 const rows=[{...run('notion','prospects_business',now-7_200_000,'running'),lease_until:new Date(now-1).toISOString()}],jobs:SyncJob[]=[];let checks=0;
 await tickSyncJobs(tickDatabase(rows),{COCKPIT_MODE:'live',NOTION_DATA_SOURCE_ID:'notion'} as unknown as NodeJS.ProcessEnv,{now:()=>now,budget:budget(()=>checks++===0),execute:async job=>{jobs.push(job);return {status:'partial'};}});
 assert.deepEqual(jobs,['notion']);assert.equal(checks,2);
});

test('a due unit that does not fit returns partial without claiming the tick is current',async()=>{
 const rows=[{...run('notion','prospects_business',now-7_200_000,'running'),lease_until:new Date(now-1).toISOString()}],jobs:SyncJob[]=[];
 const result=await tickSyncJobs(tickDatabase(rows),{COCKPIT_MODE:'live',NOTION_DATA_SOURCE_ID:'notion'} as unknown as NodeJS.ProcessEnv,{now:()=>now,budget:budget(()=>false),execute:async job=>{jobs.push(job);return {status:'partial'};}});
 assert.equal(result.status,'partial');assert.equal(result.units,0);assert.deepEqual(jobs,[]);
});

test('a smaller admissible unit runs when the oldest due stream no longer fits',async()=>{
 const rows:Row[]=[{...run('meta','meta_account_daily',now-7_200_000)},{...run('notion','prospects_business',now-3_600_000,'running'),lease_until:new Date(now-1).toISOString()},{...run('meta','ad_daily',now)}],jobs:SyncJob[]=[];
 await tickSyncJobs(tickDatabase(rows),environment,{now:()=>now,budget:budget(max=>max<=20_000),execute:async job=>{jobs.push(job);Object.assign(rows[1],{status:'complete',finished_at:new Date(now).toISOString(),started_at:new Date(now).toISOString()});return {status:'complete'};}});
 assert.deepEqual(jobs,['notion']);
});

test('a failed source is skipped so another due stream still progresses',async()=>{
 const rows:Row[]=[{...run('notion','prospects_business',now-7_200_000,'running'),lease_until:new Date(now-7_200_000).toISOString()},{...run('meta','meta_account_daily',now-3_600_000)},{...run('meta','ad_daily',now)}],jobs:SyncJob[]=[];
 const result=await tickSyncJobs(tickDatabase(rows),environment,{now:()=>now,budget:budget(()=>true),execute:async job=>{jobs.push(job);if(job==='notion')throw Error('synthetic');Object.assign(rows[1],{status:'complete',finished_at:new Date(now).toISOString(),started_at:new Date(now).toISOString()});return {status:'complete'};}});
 assert.deepEqual(jobs,['notion','meta']);
 assert.equal(result.status,'partial');assert.deepEqual(result.unitResults,[{job:'notion',status:'failed'},{job:'meta',status:'complete'}]);
});
