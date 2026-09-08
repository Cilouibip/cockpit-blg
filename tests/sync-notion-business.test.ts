import test from 'node:test';
import assert from 'node:assert/strict';
import {synchronizeNotionChunk} from '../src/lib/sync-notion-business';
import {newBatch} from '../src/connectors/types';
import type {NotionConfig,NotionProspect} from '../src/connectors/notion';
import type {Database,Row} from '../src/lib/db';
const env={COCKPIT_MODE:'live',NOTION_TOKEN:'synthetic',NOTION_DATA_SOURCE_ID:'synthetic',IDENTITY_HMAC_SECRET:'synthetic-secret-32-characters-minimum'};
function dbStub(){let checkpoint={intervals:[{from:'2026-01-01T00:00:00Z',to:'2026-09-01T00:00:00Z',read:0,cursor:'initial'}]};const calls:{name:string;args:Row}[]=[];const db:Database={select:async()=>[],upsert:async()=>assert.fail('RPC only'),probe:async()=>{},rpc:async<T>(name:string,args:Row)=>{calls.push({name,args});if(name==='cockpit_claim_notion')return {busy:false,runId:'same-run',lease:'lease',checkpoint,rowsRead:0} as T;if(name==='cockpit_stage_notion')checkpoint=args.p_checkpoint as typeof checkpoint;if(name==='cockpit_publish_notion')return {status:'complete',count:0} as T;return true as T;}};return{db,calls};}
function page(config:NotionConfig,cursor?:string){return{...newBatch<NotionProspect>('notion','synthetic','v1',config.from,config.to),status:cursor?'partial' as const:'complete' as const,safeError:cursor?'PAGE_LIMIT_REACHED':undefined,checkpoint:cursor?{cursor}:{},counts:{read:0,accepted:0,rejected:0,pages:1}};}
test('chunk keeps stable run and cursor across invocations; no publication until last interval',async()=>{
 const {db,calls}=dbStub();const a=await synchronizeNotionChunk({db,env,maxPages:1,reader:async c=>{assert.equal(c.cursor,'initial');assert.equal(c.queryTimestamp,'created_time');return page(c,'next');}});assert.equal(a.status,'partial');assert.ok(!calls.some(c=>c.name==='cockpit_publish_notion'));
 const b=await synchronizeNotionChunk({db,env,maxPages:1,reader:async c=>{assert.equal(c.cursor,'next');return page(c);}});assert.equal(b.status,'complete');assert.equal(b.runId,a.runId);assert.equal(calls.filter(c=>c.name==='cockpit_publish_notion').length,1);
});
test('failed source page never stages or publishes and releases for retry',async()=>{
 const {db,calls}=dbStub();await assert.rejects(()=>synchronizeNotionChunk({db,env,reader:async c=>({...page(c),status:'failed',safeError:'SOURCE_FAILED',counts:{read:0,accepted:0,rejected:0,pages:0}})}));
 assert.deepEqual(calls.map(c=>c.name),['cockpit_claim_notion','cockpit_release_notion']);assert.equal(calls.at(-1)?.args.p_error,'NOTION_PAGE_RETRY');
});
