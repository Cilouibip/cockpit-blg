import {test} from 'node:test';
import assert from 'node:assert/strict';
import {postHogPeriod} from '../src/lib/posthog-dashboard';
import type {PostHogAnalyticsReport} from '../src/connectors/posthog-analytics';
import type {Database,Row} from '../src/lib/db';
test('explicit PostHog refresh retries immediately after failure and does not cache success',async()=>{
 const keys=['POSTHOG_HOST','POSTHOG_PROJECT_ID','POSTHOG_PERSONAL_API_KEY'];const old=keys.map(k=>process.env[k]);
 Object.assign(process.env,{POSTHOG_HOST:'https://example.invalid',POSTHOG_PROJECT_ID:'synthetic',POSTHOG_PERSONAL_API_KEY:'synthetic'});
 try {
  let calls=0;const finishes:Row[]=[];
  const db:Database={select:async()=>[],probe:async()=>{},upsert:async()=>{},rpc:async<T>(name:string,args:Row)=>{if(name==='finish_sync')finishes.push(args);return 'run' as T;}};
  const reader=async()=>{if(++calls===1)throw new Error('source unavailable');return {status:'empty',coverage:{queryComplete:true},byEvent:[],byHostEvent:[],questions:[],overview:null} as unknown as PostHogAnalyticsReport;};
  assert.equal(await postHogPeriod('2026-09-07','2026-09-08',{db,reader}),null);
  assert.equal((await postHogPeriod('2026-09-07','2026-09-08',{db,reader}))?.status,'empty');
  await postHogPeriod('2026-09-07','2026-09-08',{db,reader});
  assert.equal(calls,3);assert.deepEqual(finishes.map(r=>r.p_status),['failed','empty','empty']);
 } finally {keys.forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];});}
});
