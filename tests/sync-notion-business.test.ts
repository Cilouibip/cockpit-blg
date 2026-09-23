import test from 'node:test';
import assert from 'node:assert/strict';
import {synchronizeNotionChunk} from '../src/lib/sync-notion-business';
import {newBatch} from '../src/connectors/types';
import type {NotionConfig,NotionProspect} from '../src/connectors/notion';
import type {Database,Row} from '../src/lib/db';
const schemaReader=async()=>({proof:{digest:'a'.repeat(64),deltaSafe:true},fields:{}});
const env={COCKPIT_MODE:'live',NOTION_TOKEN:'synthetic',NOTION_DATA_SOURCE_ID:'synthetic',IDENTITY_HMAC_SECRET:'synthetic-secret-32-characters-minimum'};
function dbStub(){let checkpoint={intervals:[{from:'2026-01-01T00:00:00Z',to:'2026-09-01T00:00:00Z',read:0,cursor:'initial'}]};const calls:{name:string;args:Row}[]=[];const db:Database={select:async()=>[],upsert:async()=>assert.fail('RPC only'),probe:async()=>{},rpc:async<T>(name:string,args:Row)=>{calls.push({name,args});if(name==='cockpit_claim_notion')return {busy:false,runId:'same-run',lease:'lease',checkpoint,rowsRead:0} as T;if(name==='cockpit_stage_notion')checkpoint=args.p_checkpoint as typeof checkpoint;if(name==='cockpit_publish_notion')return {status:'complete',count:0} as T;return true as T;}};return{db,calls};}
function page(config:NotionConfig,cursor?:string){return{...newBatch<NotionProspect>('notion','synthetic','v1',config.from,config.to),status:cursor?'partial' as const:'complete' as const,safeError:cursor?'PAGE_LIMIT_REACHED':undefined,checkpoint:cursor?{cursor}:{},counts:{read:0,accepted:0,rejected:0,pages:1}};}
test('chunk keeps stable run and cursor across invocations; no publication until last interval',async()=>{
 const {db,calls}=dbStub();const a=await synchronizeNotionChunk({db,env,schemaReader,maxPages:1,reader:async c=>{assert.equal(c.cursor,'initial');assert.equal(c.queryTimestamp,'created_time');return page(c,'next');}});assert.equal(a.status,'partial');assert.ok(!calls.some(c=>c.name==='cockpit_publish_notion'));
 const b=await synchronizeNotionChunk({db,env,schemaReader,maxPages:1,reader:async c=>{assert.equal(c.cursor,'next');return page(c);}});assert.equal(b.status,'complete');assert.equal(b.runId,a.runId);assert.equal(calls.filter(c=>c.name==='cockpit_publish_notion').length,1);
});
test('failed source page never stages or publishes and releases for retry',async()=>{
 const {db,calls}=dbStub();await assert.rejects(()=>synchronizeNotionChunk({db,env,schemaReader,reader:async c=>({...page(c),status:'failed',safeError:'SOURCE_FAILED',counts:{read:0,accepted:0,rejected:0,pages:0}})}));
 assert.deepEqual(calls.map(c=>c.name),['cockpit_claim_notion','cockpit_release_notion']);assert.equal(calls.at(-1)?.args.p_error,'SOURCE_FAILED');
});
// U9 (migration 021) : passage delta = intervalle des modifications puis la seule tranche d'inventaire choisie à la réclamation.
function deltaStub(){
 const carried={from:'1970-01-01T00:00:00Z',to:'2026-03-01T00:00:00Z',inventoriedAt:'2026-09-23T08:00:00Z'};
 const plan={partitions:3,pages:3,budget:1,fraction:0.0833,trancheCount:1,tranchePages:1,overdue:0,newPartition:true};
 let checkpoint:Row={version:2,mode:'delta',page:0,partitions:[carried],tranche:[{from:'2026-03-01T00:00:00Z',to:'2026-06-01T00:00:00Z'},{from:'2026-09-23T09:30:00Z',to:'2026-09-23T10:00:00Z'}],inventoryPlan:plan,
  intervals:[{kind:'delta',from:'2026-09-23T09:28:00Z',to:'2026-09-23T10:00:00Z',read:0},{kind:'inventory',from:'2026-03-01T00:00:00Z',to:'2026-06-01T00:00:00Z',read:0},{kind:'inventory',from:'2026-09-23T09:30:00Z',to:'2026-09-23T10:00:00Z',read:0}]};
 const calls:{name:string;args:Row}[]=[];
 const db:Database={select:async()=>[],upsert:async()=>assert.fail('RPC only'),probe:async()=>{},rpc:async<T>(name:string,args:Row)=>{calls.push({name,args});
  if(name==='cockpit_claim_notion')return {busy:false,runId:'delta-run',lease:'lease',checkpoint,rowsRead:0,from:'2026-09-23T09:28:00Z',to:'2026-09-23T10:00:00Z'} as T;
  if(name==='cockpit_stage_notion')checkpoint={...checkpoint,...(args.p_checkpoint as Row)};
  if(name==='cockpit_publish_notion')return {status:'complete',count:3,changed:0,mode:'delta',inventoryThrough:'2026-09-23T08:00:00Z'} as T;
  return true as T;}};
 return {db,calls,carried,plan};
}
test('U9 delta : modifications en last_edited_time puis tranche partielle en created_time, curseur conservé entre invocations, partitions non relues renvoyées telles quelles',async()=>{
 const {db,calls,carried,plan}=deltaStub(),seen:string[]=[];
 const reader=async(c:NotionConfig)=>{seen.push(`business:${c.queryTimestamp}:${c.from}:${c.to}:${c.cursor??''}`);return page(c);};
 const inventoryReader=async(c:NotionConfig)=>{seen.push(`inventory:${c.queryTimestamp}:${c.from}:${c.to}:${c.cursor??''}`);return {...page(c,c.from==='2026-03-01T00:00:00Z'&&!c.cursor?'slice-page-2':undefined)} as never;};
 const first=await synchronizeNotionChunk({db,env,schemaReader,maxPages:2,reader,inventoryReader});
 assert.equal(first.status,'partial');assert.ok(!calls.some(c=>c.name==='cockpit_publish_notion'),'aucune publication avant la fin de la tranche');
 const staged=calls.filter(c=>c.name==='cockpit_stage_notion').map(c=>c.args.p_checkpoint as {intervals:{kind:string;cursor?:string}[];partitions:unknown[];page:number});
 assert.deepEqual(staged.map(c=>c.page),[1,2],'pages numérotées pour le rejeu');
 assert.deepEqual(staged[0].partitions,[carried],'l’intervalle des modifications n’est jamais une partition d’inventaire');
 assert.equal(staged[1].intervals[0].kind,'inventory');assert.equal(staged[1].intervals[0].cursor,'slice-page-2','curseur de la tranche enregistré');
 const second=await synchronizeNotionChunk({db,env,schemaReader,maxPages:3,reader,inventoryReader});
 assert.equal(second.status,'complete');assert.equal(second.runId,first.runId);assert.equal(second.coverage.mode,'delta');
 assert.deepEqual(seen,[
  'business:last_edited_time:2026-09-23T09:28:00Z:2026-09-23T10:00:00Z:',
  'inventory:created_time:2026-03-01T00:00:00Z:2026-06-01T00:00:00Z:',
  'inventory:created_time:2026-03-01T00:00:00Z:2026-06-01T00:00:00Z:slice-page-2',
  'inventory:created_time:2026-09-23T09:30:00Z:2026-09-23T10:00:00Z:',
 ],'seules les plages de la tranche sont inventoriées, dans l’ordre, avec le bon horodatage Notion');
 const last=calls.filter(c=>c.name==='cockpit_stage_notion').at(-1)!.args.p_checkpoint as {intervals:unknown[];partitions:unknown[]};
 assert.deepEqual(last.intervals,[]);
 assert.deepEqual(last.partitions,[carried,{from:'2026-03-01T00:00:00Z',to:'2026-06-01T00:00:00Z'},{from:'2026-09-23T09:30:00Z',to:'2026-09-23T10:00:00Z'}],'partition non relue intacte (inventoriedAt conservée), plages relues ajoutées ; la base les date à la publication');
 assert.equal(calls.filter(c=>c.name==='cockpit_publish_notion').length,1);
 assert.deepEqual(second.coverage.inventoryPlan,plan,'mesures de la tranche exposées dans la réponse du tick');assert.equal(second.coverage.inventoryThrough,'2026-09-23T08:00:00Z');
 assert.match(String(second.coverage.reason),/tranche/);
});
