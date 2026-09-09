import test from 'node:test';
import assert from 'node:assert/strict';
import {createSyncExecutionBudget,SyncBudgetExpired} from '../src/lib/sync-budget';
import {readJson} from '../src/connectors/http';

test('The invocation deadline reaches a reader that installs its own request timeout',async()=>{
  let transportAborted=false;
  const fetcher:typeof fetch=async(_input,init)=>new Promise((_resolve,reject)=>{
    assert.ok(init?.signal);
    init.signal.addEventListener('abort',()=>{transportAborted=true;reject(init.signal?.reason);},{once:true});
  });
  const budget=createSyncExecutionBudget({totalMs:100,writeMarginMs:80,fetcher});
  try {
    await assert.rejects(readJson(new URL('https://example.invalid/'),{method:'GET'},{fetcher:budget.sourceFetch,attempts:1,timeoutMs:60_000}),/NETWORK_ERROR/);
    assert.equal(transportAborted,true);
    assert.equal(budget.canStart(1),false);
  } finally {budget.dispose();}
});

test('Writes retain their reserved window after the source budget expires, then also stop',async()=>{
  let now=0,calls=0;
  const budget=createSyncExecutionBudget({totalMs:1000,writeMarginMs:200,now:()=>now,fetcher:async()=>{calls++;return new Response('{}');}});
  try {
    assert.equal(budget.canStart(800),true);now=801;
    await assert.rejects(budget.sourceFetch('https://example.invalid/'),(error:unknown)=>error instanceof SyncBudgetExpired&&error.phase==='source');
    await budget.writeFetch('https://example.invalid/');assert.equal(calls,1);
    now=1000;await assert.rejects(budget.writeFetch('https://example.invalid/'),SyncBudgetExpired);assert.equal(calls,1);
  } finally {budget.dispose();}
});

test('Caller cancellation stops reads while bounded persistence remains possible',async()=>{
  const caller=new AbortController();let calls=0;
  const budget=createSyncExecutionBudget({signal:caller.signal,fetcher:async()=>{calls++;return new Response('{}');}});
  try {caller.abort();assert.equal(budget.canStart(1),false);await assert.rejects(budget.sourceFetch('https://example.invalid/'),SyncBudgetExpired);await budget.writeFetch('https://example.invalid/');assert.equal(calls,1);}finally{budget.dispose();}
});

test('A per-request signal is retained and invalid budgets fail before transport',async()=>{
  const requestAbort=new AbortController();let signal:AbortSignal|null|undefined;
  const budget=createSyncExecutionBudget({fetcher:async(_input,init)=>{signal=init?.signal;return new Response('{}');}});
  try {await budget.sourceFetch(new Request('https://example.invalid/',{signal:requestAbort.signal}));requestAbort.abort();assert.equal(signal?.aborted,true);}finally{budget.dispose();}
  assert.throws(()=>createSyncExecutionBudget({totalMs:50,writeMarginMs:50}),RangeError);
});
