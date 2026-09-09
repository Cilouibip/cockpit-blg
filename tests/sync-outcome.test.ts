import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyticsSyncOutcome} from '../src/lib/sync-outcome';
const ok=(status:string):PromiseFulfilledResult<{status:string}>=>({status:'fulfilled',value:{status}});
test('partial and failed source imports are visible in HTTP and the per-source result',()=>{
 assert.equal(analyticsSyncOutcome([ok('complete'),ok('complete')]).httpStatus,200);
 const partial=analyticsSyncOutcome([ok('complete'),{status:'rejected',reason:new Error('private upstream response')}]);
 assert.equal(partial.httpStatus,207);assert.equal(partial.body.sources[1].status,'failed');assert.ok(!JSON.stringify(partial).includes('private'));
 assert.equal(analyticsSyncOutcome([ok('failed'),{status:'fulfilled',value:null}]).httpStatus,502);
 assert.equal(analyticsSyncOutcome([ok('empty'),ok('complete')]).httpStatus,207);
 assert.equal(analyticsSyncOutcome([ok('partial'),ok('complete')]).body.status,'partial');
});
