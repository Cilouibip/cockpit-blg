import test from 'node:test';
import assert from 'node:assert/strict';
import type {Database,Row} from '../src/lib/db';
import {readSourceSnapshot,invalidateSourceSnapshots,sourceAttempt,type SourceWindow} from '../src/lib/source-snapshots';
const selector:SourceWindow={kind:'daily_bundle',stream:'meta_account_daily',profile:'synthetic',from:'2026-01-01',to:'2026-02-01',timezone:'Europe/Paris',currency:'EUR',currencyExponent:2};
const empty={runs:[],aggregates:[],selections:[],validations:{},exactRunId:null,latestAttempt:null};
test('one read RPC, complete selector cache isolation, no raw scans and no cached failures',async()=>{
 const calls:Row[]=[];let fail=false;
 const db:Database={select:async()=>assert.fail('No table scan'),upsert:async()=>assert.fail('read only'),probe:async()=>{},rpc:async<T>(name:string,args:Row)=>{assert.equal(name,'cockpit_source_window');calls.push(args);if(fail)throw Error('synthetic failure');return structuredClone(empty) as T;}};
 await Promise.all([readSourceSnapshot(db,'meta','synthetic',selector),readSourceSnapshot(db,'meta','synthetic',selector)]);assert.equal(calls.length,1);
 for(const change of [{from:'2026-01-02'},{to:'2026-02-02'},{profile:'another'},{stream:'another'},{kind:'exact_report' as const},{timezone:'UTC'},{currency:'USD'},{currencyExponent:0}])await readSourceSnapshot(db,'meta','synthetic',{...selector,...change});
 assert.equal(calls.length,9);await readSourceSnapshot(db,'meta','another',selector);assert.equal(calls.length,10);
 invalidateSourceSnapshots(db);fail=true;await assert.rejects(()=>readSourceSnapshot(db,'meta','synthetic',selector));fail=false;await readSourceSnapshot(db,'meta','synthetic',selector);assert.equal(calls.length,12);
});
test('latest failed attempt is metadata distinct from a still usable publication',()=>{
 const snapshot={...empty,runs:[{id:'old'}],aggregates:[{value:100}],latestAttempt:{status:'failed',started_at:'2026-02-01T00:00:00Z',finished_at:'2026-02-01T00:00:01Z'}};
 assert.deepEqual(sourceAttempt(snapshot),{status:'failed',startedAt:'2026-02-01T00:00:00Z',finishedAt:'2026-02-01T00:00:01Z'});assert.equal(snapshot.aggregates[0].value,100);
});

test('expired windows are refreshed and a long-lived database keeps at most128 completed entries',async()=>{
 let calls=0;const originalNow=Date.now;let now=1000;Date.now=()=>now;
 const db:Database={select:async()=>assert.fail(),upsert:async()=>assert.fail(),probe:async()=>{},rpc:async<T>()=>{calls++;return structuredClone(empty) as T;}};
 try{
  await readSourceSnapshot(db,'meta','synthetic',selector);now+=30001;await readSourceSnapshot(db,'meta','synthetic',{...selector,profile:'new'});await readSourceSnapshot(db,'meta','synthetic',selector);assert.equal(calls,3);
  invalidateSourceSnapshots(db);for(let i=0;i<129;i++)await readSourceSnapshot(db,'meta','synthetic',{...selector,profile:'p'+i});
  const before=calls;await readSourceSnapshot(db,'meta','synthetic',{...selector,profile:'p0'});assert.equal(calls,before+1);await readSourceSnapshot(db,'meta','synthetic',{...selector,profile:'p128'});assert.equal(calls,before+1);
 }finally{Date.now=originalNow;}
});
