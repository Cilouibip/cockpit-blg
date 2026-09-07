import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synchronizeWix, readWixReportedPeriod } from '../src/lib/sync-wix';
import type { Database, Row } from '../src/lib/db';
import type { WixPaymentsAnalyticsBatch } from '../src/connectors/wix-payments-analytics';

const namespace='44444444-4444-4444-8444-444444444444';
const env={NODE_ENV:'test' as const,COCKPIT_MODE:'live',WIX_SITE_ID:namespace,WIX_API_KEY:'synthetic-key'};
function report():WixPaymentsAnalyticsBatch { return {
 source:'wix',accountId:namespace,version:'wix-payments-analytics-v1',status:'complete',records:[{
  source:'wix',accountId:namespace,externalId:'source-total',observedAt:'2026-09-07T12:00:00Z',connectorVersion:'wix-payments-analytics-v1',
  metric:'wix_total_revenue',from:'2026-07-31T22:00:00Z',to:'2026-08-31T22:00:00Z',timezone:'Europe/Paris',
  amount:{minor:12345,currency:'EUR'},count:null,taxBasis:'gross',dimensions:{},transactionGrain:false,
 }],counts:{read:1,accepted:1,rejected:0,pages:1},coverage:{from:'2026-07-31T22:00:00Z',to:'2026-08-31T22:00:00Z',complete:true},
 checkpoint:{},breakdown:[],sourceTotals:null,normalizedNetEligible:false,normalizationReason:'Optional detail is missing',currencyBasis:'wix_site_reporting_currency',definitionVersion:null,
 } as WixPaymentsAnalyticsBatch; }
function fakeDb(fail=false){const events: {name:string;args:Row}[]=[];const stored:Row[]=[];
 const db:Database={probe:async()=>{},select:async()=>[],rpc:async<T>(name:string,args:Row)=>{events.push({name,args});return (name==='begin_sync'?'run-1':true) as T;},
 upsert:async(table,rows)=>{events.push({name:table,args:{}});if(fail)throw new Error('write failed');stored.push(...rows);}};
 return {db,events,stored};}

test('Wix publishes the source total as its own definition, without fabricating null refunds or net cash',async()=>{
 const {db,events,stored}=fakeDb();const result=await synchronizeWix('2026-08-01','2026-09-01',{db,env,reader:async()=>report()});
 assert.equal(result.status,'complete');assert.deepEqual(events.map(e=>e.name),['begin_sync','source_aggregates','finish_sync']);
 assert.equal(stored.length,1);assert.equal(stored[0].metric_key,'wix_total_revenue');assert.equal(stored[0].value,12345);
 assert.equal(stored[0].definition_version,'wix-payments-analytics-v1');assert.equal(stored[0].period_from,'2026-07-31T22:00:00.000Z');
 assert.equal(stored[0].tax_basis,'tax_inclusive');assert.equal(events.at(-1)!.args.p_complete,true);
});
test('Wix partial reads and failed persistence never publish a complete run',async()=>{
 const partial=fakeDb();await synchronizeWix('2026-08-01','2026-09-01',{db:partial.db,env,reader:async()=>({...report(),status:'partial',coverage:{...report().coverage,complete:false}})});
 assert.equal(partial.stored.length,0);assert.equal(partial.events.at(-1)!.args.p_complete,false);
 const failed=fakeDb(true);await assert.rejects(()=>synchronizeWix('2026-08-01','2026-09-01',{db:failed.db,env,reader:async()=>report()}));
 assert.equal(failed.events.at(-1)!.args.p_status,'failed');assert.equal(failed.events.at(-1)!.args.p_complete,false);
});
test('Wix display selects a completed source report and preserves its definition and negative value',async()=>{
 const previous=process.env.WIX_SITE_ID;process.env.WIX_SITE_ID=namespace;
 try {
  let complete=true;
  const db:Database={probe:async()=>{},upsert:async()=>{},rpc:async<T>()=>null as T,select:async(table)=>table==='sync_runs'?[{
   source:'wix',source_namespace:namespace,status:complete?'complete':'running',pagination_complete:complete,finished_at:'2026-09-07T12:00:00Z',
  }]:[{currency:'EUR',currency_exponent:2,unit:'minor',tax_basis:'tax_inclusive',timezone:'Europe/Paris',value:-2300,sync_run_id:'run-1'}]};
  const metric=await readWixReportedPeriod(db,'2026-08-01','2026-09-01');assert.equal(metric?.cash.value,-23);assert.match(metric!.cash.definition,/cartes cadeaux/);assert.match(metric!.cash.source,/Wix/);
  complete=false;assert.equal(await readWixReportedPeriod(db,'2026-08-01','2026-09-01'),null);
 } finally {if(previous===undefined)delete process.env.WIX_SITE_ID;else process.env.WIX_SITE_ID=previous;}
});

 test('Wix empty reports finish pagination without publishing a fabricated cash zero',async()=>{
 const {db,events,stored}=fakeDb();await synchronizeWix('2026-08-01','2026-09-01',{db,env,reader:async()=>({...report(),status:'empty',records:[],coverage:{...report().coverage,complete:false}})});
 assert.equal(stored.length,0);assert.equal(events.at(-1)!.args.p_status,'empty');assert.equal(events.at(-1)!.args.p_complete,true);
 });
