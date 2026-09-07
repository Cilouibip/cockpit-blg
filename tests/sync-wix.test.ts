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
test('Wix combines completed daily reports without counting overlaps twice',async()=>{
 const previous=process.env.WIX_SITE_ID;process.env.WIX_SITE_ID=namespace;
 try {
  const runs=[
   {id:'old',period_from:'2026-07-31T22:00:00Z',period_to:'2026-08-02T22:00:00Z',finished_at:'2026-09-01T00:00:00Z'},
   {id:'new',period_from:'2026-08-01T22:00:00Z',period_to:'2026-08-03T22:00:00Z',finished_at:'2026-09-02T00:00:00Z'},
  ].map(r=>({...r,source:'wix',source_namespace:namespace,status:'complete',pagination_complete:true,query_profile_key:'wix-payments-analytics-v1'}));
  const make=(run:typeof runs[number],metric:string,value:number,date?:string)=>({...run,sync_run_id:run.id,currency:'EUR',currency_exponent:2,unit:'minor',tax_basis:'tax_inclusive',timezone:'Europe/Paris',value,metric_key:metric,dimensions_key:date?'day:'+date:'all',dimensions:date?{date}:{},report_profile_key:'wix-payments-analytics-v1'});
  const rows=[make(runs[0],'wix_total_revenue',30000),make(runs[0],'wix_daily_revenue',10000,'2026-08-01'),make(runs[0],'wix_daily_revenue',20000,'2026-08-02'),make(runs[1],'wix_total_revenue',-2300),make(runs[1],'wix_daily_revenue',-2300,'2026-08-02')];
  const db:Database={probe:async()=>{},upsert:async()=>{assert.fail('read only');},rpc:async<T>()=>null as T,select:async(table)=>table==='sync_runs'?runs:rows};
  const total=await readWixReportedPeriod(db,'2026-08-01','2026-08-04');
  assert.equal(total?.cash.value,77);assert.deepEqual(total?.dailyRevenue,[{date:'2026-08-01',value:100},{date:'2026-08-02',value:-23},{date:'2026-08-03',value:0}]);
  assert.equal((await readWixReportedPeriod(db,'2026-08-01','2026-08-05'))?.cash.value,null);
  assert.equal((await readWixReportedPeriod(db,'2026-08-02','2026-08-03'))?.cash.value,-23);
 } finally {if(previous===undefined)delete process.env.WIX_SITE_ID;else process.env.WIX_SITE_ID=previous;}
});

 test('Wix empty reports finish pagination without publishing a fabricated cash zero',async()=>{
 const {db,events,stored}=fakeDb();await synchronizeWix('2026-08-01','2026-09-01',{db,env,reader:async()=>({...report(),status:'empty',records:[],coverage:{...report().coverage,complete:false}})});
 assert.equal(stored.length,0);assert.equal(events.at(-1)!.args.p_status,'empty');assert.equal(events.at(-1)!.args.p_complete,true);
 });


test('an exact Wix total survives incomplete daily coverage',async()=>{
 const old=process.env.WIX_SITE_ID;process.env.WIX_SITE_ID=namespace;
 try {
  const report={id:'exact',source:'wix',source_namespace:namespace,status:'complete',pagination_complete:true,query_profile_key:'wix-payments-analytics-v1',period_from:'2024-12-31T23:00:00Z',period_to:'2025-12-31T23:00:00Z',finished_at:'2026-09-07T12:00:00Z'};
  const total={sync_run_id:'exact',currency:'EUR',currency_exponent:2,unit:'minor',tax_basis:'tax_inclusive',timezone:'Europe/Paris',value:10000,metric_key:'wix_total_revenue',dimensions_key:'all',dimensions:{},report_profile_key:'wix-payments-analytics-v1',period_from:report.period_from,period_to:report.period_to};
  const db:Database={select:async(t)=>t==='sync_runs'?[report]:[total],upsert:async()=>{},rpc:async<T>()=>null as T,probe:async()=>{}};
  const result=await readWixReportedPeriod(db,'2025-01-01','2026-01-01');
  assert.equal(result?.cash.value,100);assert.equal(result?.dailyRevenue.length,0);assert.match(result!.cash.coverage,/partiel/);
  assert.equal(await readWixReportedPeriod(db,'2025-02-01','2025-03-01'),null);
 } finally {if(old===undefined)delete process.env.WIX_SITE_ID;else process.env.WIX_SITE_ID=old;}
});
