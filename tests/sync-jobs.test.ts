import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseSyncJob,tickSyncJobs,jobScope,type SyncJob} from '../src/lib/sync-jobs';
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
const stream:Record<SyncJob,[string,string]>={notion:['notion','prospects_business'],meta:['meta','meta_account_daily'],wix:['wix','payments_analytics'],receipts:['wix','receipt_observations'],meta_ads:['meta','ad_daily'],quiz:['posthog','quiz_observations'],masterclass:['posthog','masterclass_observations'],forms:['wix','lead_entries_forms'],quiz_entries:['wix','lead_entries_quiz'],client_history:['notion','lead_entries_client_history'],commerce:['notion','commerce_declared_snapshot']};
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

// Inscriptions Wix, antériorité Client et ventes payées : planifiées seulement quand leur configuration existe ; une lecture partielle reprend dans le même tick, un échec reste visible.
const leadConfig=JSON.stringify({formIds:['form-1'],quiz:{collectionId:'QuizRepondants',originFields:{ad:'publicite'}}});
const commerceConfig=JSON.stringify({clients:{dataSourceId:'ds-clients'},payments:{dataSourceId:'ds-payments'},schedule:{dataSourceId:'ds-schedule'},parcours:{dataSourceId:'ds-parcours'}});
const fullEnvironment={COCKPIT_MODE:'live',WIX_SITE_ID:'wix',WIX_API_KEY:'k',WIX_LEAD_ENTRY_CONFIG:leadConfig,NOTION_DATA_SOURCE_ID:'notion',NOTION_CLIENT_DATA_SOURCE_ID:'notion',NOTION_TOKEN:'t',NOTION_COMMERCE_CONFIG:commerceConfig} as unknown as NodeJS.ProcessEnv;

test('les unités inscriptions, antériorité Client et ventes payées ne sont planifiées qu’avec leur configuration',()=>{
 assert.equal(jobScope('forms',environment),null);assert.equal(jobScope('quiz_entries',environment),null);assert.equal(jobScope('client_history',environment),null);assert.equal(jobScope('commerce',environment),null);
 assert.equal(jobScope('forms',fullEnvironment)?.namespace,'wix');assert.match(jobScope('forms',fullEnvironment)!.profile,/-forms-/);assert.match(jobScope('quiz_entries',fullEnvironment)!.profile,/-quiz-/);
 assert.equal(jobScope('client_history',fullEnvironment)?.namespace,'notion');assert.equal(jobScope('commerce',fullEnvironment)?.namespace,'ds-parcours');
 assert.equal(jobScope('forms',{...fullEnvironment,WIX_API_KEY:undefined} as unknown as NodeJS.ProcessEnv),null,'sans clé serveur, la lecture des inscriptions n’est pas planifiée : l’import supervisé reste la voie');
 assert.equal(jobScope('commerce',{...fullEnvironment,NOTION_COMMERCE_CONFIG:JSON.stringify({clients:{dataSourceId:'a'},payments:{dataSourceId:'b'},parcours:{dataSourceId:'c'}})} as unknown as NodeJS.ProcessEnv),null,'sans échéancier configuré, le rapprochement des ventes n’est pas planifié');
});

test('une lecture d’inscriptions partielle reprend dans le même tick (au plus quatre unités) et un échec Wix reste visible',async()=>{
 const rows:Row[]=[],jobs:SyncJob[]=[];let formsUnits=0;
 const result=await tickSyncJobs(tickDatabase(rows),fullEnvironment,{now:()=>now,budget:budget(()=>true),execute:async job=>{
  jobs.push(job);const [source,key]=stream[job];
  if(job==='forms'){formsUnits++;rows.push({...run(source,key,now,'running'),lease_until:new Date(now-1).toISOString(),started_at:new Date(now).toISOString()});return {status:'partial'};}
  if(job==='quiz_entries'){rows.push(run(source,key,now,'failed'));return {status:'failed'};}
  const row=run(source,key,now);if(job==='commerce')row.source_namespace='ds-parcours';rows.push(row);return {status:'complete'};
 }});
 assert.equal(formsUnits,4,'quatre unités partielles au plus par tick, puis reprise au prochain tick');
 assert.equal(jobs.filter(j=>j==='quiz_entries').length,1);assert.equal(jobs.filter(j=>j==='client_history').length,1);assert.equal(jobs.filter(j=>j==='commerce').length,1);
 assert.equal(result.status,'partial');assert.ok(result.unitResults.some(u=>u.job==='quiz_entries'&&u.status==='failed'),'l’échec n’est jamais masqué');
});


test('all configured acquisition and commerce streams are due after one hour, not before',()=>{
 const jobs:SyncJob[]=['notion','meta','wix','receipts','meta_ads','quiz','masterclass','forms','quiz_entries','client_history','commerce'];
 for(const job of jobs){const [source,key]=stream[job];
  assert.equal(chooseSyncJob([run(source,key,now-3_599_999)],now,[job]),null,`${job} is not due before the hour`);
  assert.equal(chooseSyncJob([run(source,key,now-3_600_000)],now,[job]),job,`${job} is due at one hour`);
 }
});

test('a successful non-resumable source does not make the tick partial',async()=>{
 const rows:Row[]=[run('meta','meta_account_daily',now-3_600_000),run('meta','ad_daily',now)];
 const result=await tickSyncJobs(tickDatabase(rows),{COCKPIT_MODE:'live',META_AD_ACCOUNT_ID:'meta'} as unknown as NodeJS.ProcessEnv,{now:()=>now,budget:budget(()=>true),execute:async job=>{
  assert.equal(job,'meta');Object.assign(rows[0],run('meta','meta_account_daily',now));return {status:'complete'};
 }});
 assert.equal(result.status,'complete');assert.deepEqual(result.unitResults,[{job:'meta',status:'complete'}]);
});

test('unfinished resumable work stays partial even when the last source completed',async()=>{
 const rows:Row[]=[],jobs:SyncJob[]=[];
 const result=await tickSyncJobs(tickDatabase(rows),environment,{now:()=>now,budget:budget(()=>true),execute:async job=>{
  jobs.push(job);const [source,key]=stream[job];
  if(job==='notion')return {status:'partial'};
  rows.push(run(source,key,now));return {status:'complete'};
 }});
 assert.equal(jobs.filter(j=>j==='notion').length,4);assert.equal(result.status,'partial');
});

test('resumable chunks that finish in the same tick are complete',async()=>{
 const rows:Row[]=[];let chunks=0;
 const result=await tickSyncJobs(tickDatabase(rows),{COCKPIT_MODE:'live',NOTION_DATA_SOURCE_ID:'notion'} as unknown as NodeJS.ProcessEnv,{now:()=>now,budget:budget(()=>true),execute:async()=>{
  if(++chunks<3)return {status:'partial'};rows.push(run('notion','prospects_business',now));return {status:'complete'};
 }});
 assert.equal(result.units,3);assert.equal(result.status,'complete');
});
