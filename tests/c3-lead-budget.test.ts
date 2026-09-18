import test from 'node:test';
import assert from 'node:assert/strict';
import {synchronizeLeadEntries} from '../src/lib/sync-lead-entries';
import {createSyncExecutionBudget} from '../src/lib/sync-budget';
import type {Database,Row} from '../src/lib/db';
test('Wix inscription transport shares the tick abort budget and releases its persisted lease',async()=>{
 const calls:string[]=[];let fetched=0;const controller=new AbortController();let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 const db:Database={select:async()=>[],upsert:async()=>{},probe:async()=>{},rpc:async<T>(name:string)=>{calls.push(name);return (name==='cockpit_claim_lead_entries'?{busy:false,runId:'run',lease:'lease',rowsRead:0,checkpoint:{version:1,from:'2026-09-01T00:00:00Z',to:'2026-09-02T00:00:00Z',cursor:null,page:0,done:false}}:true) as T;}};
 const budget=createSyncExecutionBudget({signal:controller.signal,fetcher:async(_input,init)=>{fetched++;entered();return new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(Error('synthetic abort')),{once:true});});}});
 try{const pending=synchronizeLeadEntries('forms',{db,env:{COCKPIT_MODE:'live',WIX_SITE_ID:'site',WIX_API_KEY:'synthetic',WIX_LEAD_ENTRY_CONFIG:JSON.stringify({formIds:['form']}),IDENTITY_HMAC_SECRET:'synthetic-secret-with-at-least-32-chars'},fetcher:budget.sourceFetch});await started;controller.abort();await assert.rejects(pending);}
 finally{budget.dispose();}
 assert.equal(fetched,1);assert.deepEqual(calls,['cockpit_claim_lead_entries','cockpit_release_lead_entries']);
});
