import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshNotionToCompletion} from '../src/lib/refresh-plan';
test('one refresh continues short Notion chunks until publication and reports progress',async()=>{
 let calls=0;const progress:number[]=[];
 const result=await refreshNotionToCompletion(async()=>({status:++calls===35?'complete':'partial',counts:{pages:3,read:calls*300}}),read=>progress.push(read));
 assert.equal(calls,35);assert.equal(result.status,'complete');assert.equal(progress.length,34);assert.equal(progress.at(-1),10200);
});
test('interruption, busy and the chunk budget never announce a published result',async()=>{
 let calls=0;
 const budget=await refreshNotionToCompletion(async()=>({status:'partial',counts:{pages:3,read:++calls*300}}),()=>{});
 assert.equal(calls,40);assert.equal(budget.status,'partial');assert.match(budget.coverage!.reason!,/reprendre/);
 calls=0;assert.equal((await refreshNotionToCompletion(async()=>{calls++;return {status:'partial',counts:{pages:0}};},()=>{})).status,'partial');assert.equal(calls,1);
 calls=0;await assert.rejects(()=>refreshNotionToCompletion(async()=>{if(++calls===2)throw Error('interrupted');return {status:'partial',counts:{pages:3}};},()=>{}),/interrupted/);assert.equal(calls,2);
});
