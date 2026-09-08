import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseSyncJob} from '../src/lib/sync-jobs';
import {metaRefreshPeriods} from '../src/lib/refresh-plan';
const now=Date.parse('2026-09-08T12:00:00Z');
test('resumable Notion does not starve a source never read, and active lease is not duplicated',()=>{
 const pending={source:'notion',stream_key:'prospects_business',status:'running',started_at:'2026-09-08T09:00:00Z',lease_until:'2026-09-08T11:59:00Z'};
 assert.equal(chooseSyncJob([pending],now,['notion','meta']),'meta');
 assert.equal(chooseSyncJob([pending],now,['notion']),'notion');
 assert.equal(chooseSyncJob([{...pending,lease_until:'2026-09-08T12:01:00Z'}],now,['notion']),null);
});
test('Meta account and ad streams have separate cadences',()=>{
 const recent={source:'meta',stream_key:'meta_account_daily',status:'complete',started_at:'2026-09-08T11:55:00Z',finished_at:'2026-09-08T11:56:00Z'};
 assert.equal(chooseSyncJob([recent],now,['meta','meta_ads']),'meta_ads');assert.equal(chooseSyncJob([recent],now,['meta']),null);
});
test('year refresh partitions preserve every selected day exactly once within source limit',()=>{
 const periods=metaRefreshPeriods('2024-01-01','2024-12-31');assert.equal(periods.length,4);assert.equal(periods[0].from,'2024-01-01');assert.equal(periods.at(-1)?.to,'2024-12-31');
 for(let i=1;i<periods.length;i++){assert.equal(Date.parse(periods[i].from)-Date.parse(periods[i-1].to),86400000);}
 for(const p of periods)assert.ok((Date.parse(p.to)-Date.parse(p.from))/86400000+1<=93);
});
