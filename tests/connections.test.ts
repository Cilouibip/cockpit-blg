import test from 'node:test';
import assert from 'node:assert/strict';
import { latestConnectionRun } from '../src/lib/connections';

const run=(source:string,stream:string,startedAt:string)=>({source,stream_key:stream,started_at:startedAt,status:'complete'});
test('chaque carte Connexions ignore les imports d’un autre flux',()=>{
 const runs=[
  run('meta','ad_daily','2026-09-08T08:00:00Z'),run('meta','ad_creative_metadata','2026-09-09T08:00:00Z'),
  run('notion','prospects_business','2026-09-07T08:00:00Z'),run('notion','lead_entries_client_history','2026-09-09T08:00:00Z'),
  run('wix','payments_analytics','2026-09-06T08:00:00Z'),run('wix','lead_entries_quiz','2026-09-09T08:00:00Z'),
  run('posthog','quiz_observations','2026-09-07T08:00:00Z'),run('posthog','masterclass_observations','2026-09-08T08:00:00Z'),
 ];
 assert.equal(latestConnectionRun(runs,'meta',['ad_daily'])?.stream_key,'ad_daily');
 assert.equal(latestConnectionRun(runs,'notion',['prospects_business'])?.stream_key,'prospects_business');
 assert.equal(latestConnectionRun(runs,'wix',['payments_analytics'])?.stream_key,'payments_analytics');
 assert.equal(latestConnectionRun(runs,'posthog',['quiz_observations','masterclass_observations'])?.stream_key,'masterclass_observations');
 assert.equal(latestConnectionRun(runs,'wix',['receipt_observations']),undefined);
});
