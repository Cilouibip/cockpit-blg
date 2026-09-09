import test from 'node:test';
import assert from 'node:assert/strict';
import {runSupervisedLeadImport} from '../src/lib/supervised-lead-import';
import type {Database} from '../src/lib/db';
import type {LeadPageReader} from '../src/lib/sync-lead-entries';

const secret='synthetic-identity-secret-not-a-live-credential';
const env={COCKPIT_MODE:'live',WIX_SITE_ID:'site',IDENTITY_HMAC_SECRET:secret,WIX_LEAD_ENTRY_CONFIG:JSON.stringify({formIds:['form-a']})};
test('supervised import accepts only injected readers and delegates the terminal publication to the existing worker',async()=>{
 const calls:string[]=[];
 const db={rpc:async(name:string)=>{calls.push(name);if(name==='cockpit_claim_lead_entries')return {busy:false,runId:'run',lease:'lease',rowsRead:0,checkpoint:{version:1,from:'1970-01-01T00:00:00Z',to:'2026-09-09T00:00:00Z',page:0,cursor:null,done:false}};if(name==='cockpit_stage_lead_entries')return {read:0};if(name==='cockpit_publish_lead_entries')return {status:'empty',counts:{read:0,observations:0,changed:0,unchanged:0,rejected:0,stale:0,ignored:0}};}} as unknown as Database;
 const reader:LeadPageReader=async()=>({records:[],read:0,ignored:0,cursor:null,done:true});
 const result=await runSupervisedLeadImport({db,env,readers:{forms:reader},families:['forms'],authorization:'reviewed-supervised-import'});
 assert.equal((result.forms as {status:string}).status,'empty');
 assert.deepEqual(calls,['cockpit_claim_lead_entries','cockpit_stage_lead_entries','cockpit_publish_lead_entries']);
});
test('supervised import refuses an unreviewed or missing reader before staging',async()=>{
 const db={rpc:async()=>{throw Error('not reached');}} as unknown as Database;
 await assert.rejects(()=>runSupervisedLeadImport({db,env,readers:{},families:['forms'],authorization:'reviewed-supervised-import'}),/Lecteur supervisé absent/);
});
test('supervised import stops before the next family when a family fails',async()=>{
 const calls:string[]=[];
 const db={rpc:async(name:string)=>{
  calls.push(name);
  if(name==='cockpit_claim_lead_entries')return {blocked:true,runId:'blocked',reason:'MAPPING_REPLAY_INCOMPLETE',lease:'',rowsRead:0,checkpoint:{version:1,from:'1970-01-01T00:00:00Z',to:'2026-09-09T00:00:00Z',page:0,cursor:null,done:false}};
 }} as unknown as Database;
 const reader:LeadPageReader=async()=>({records:[],read:0,ignored:0,cursor:null,done:true});
 await assert.rejects(()=>runSupervisedLeadImport({db,env,readers:{forms:reader,quiz:reader},families:['forms','quiz'],authorization:'reviewed-supervised-import'}),/Lecture forms refusée/);
 assert.deepEqual(calls,['cockpit_claim_lead_entries']);
});
