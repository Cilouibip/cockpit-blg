import test from 'node:test';
import assert from 'node:assert/strict';
import type {Database,Row} from '../src/lib/db';
import {evaluateSyncJobHealth} from '../src/lib/sync-health';
import {notionCommerceProfile} from '../src/connectors/notion-commerce';
import {buildNotionCommerceReport} from '../src/lib/notion-commerce-report';
import {publishNotionCommerceReport,readNotionCommerceReport} from '../src/lib/notion-commerce-storage';
import {commerceConfig,commerceEnv,filters,snapshot,client,parcours,payment} from './commerce-fixtures';

function storage(){
 const runs:Row[]=[],rows:Row[]=[];let sequence=0;
 const db:Database={
  select:async(table,options={})=>{
   const selected=(table==='sync_runs'?runs:rows).filter(row=>Object.entries(options.eq??{}).every(([key,value])=>String(row[key])===value));
   const order=(options.order??'id').split(',');
   return selected.sort((a,b)=>{for(const key of order){const n=String(a[key]).localeCompare(String(b[key]));if(n)return options.descending?-n:n;}return 0;}).slice(options.from??0,(options.from??0)+(options.limit??1000));
  },
  upsert:async(_table,incoming)=>{for(const row of incoming){const existing=rows.find(r=>r.sync_run_id===row.sync_run_id&&r.metric_key===row.metric_key&&r.dimensions_key===row.dimensions_key);if(existing)Object.assign(existing,structuredClone(row));else rows.push(structuredClone(row));}},
  rpc:async<T>(name:string,args:Row):Promise<T>=>{
   if(name==='begin_sync_stream'){const id='synthetic-run-'+(++sequence);runs.push({id,source:args.p_source,source_namespace:args.p_namespace,stream_key:args.p_stream,query_profile_key:args.p_profile,status:'running',period_from:args.p_from,period_to:args.p_to,started_at:new Date().toISOString(),source_as_of:new Date().toISOString()});return id as T;}
   if(name==='finish_sync'){Object.assign(runs.find(r=>r.id===args.p_run&&r.status==='running')??{},{status:args.p_status,pagination_complete:String(args.p_complete),rows_rejected:String(args.p_rejected)});return true as T;}
   throw Error('Unexpected synthetic RPC');
  },probe:async()=>undefined,
 };
 return {db,runs,rows};
}

test('une période hors couverture ou chevauchant un vieux relevé reste absente; le jour courant garde les valeurs provisoires',async()=>{
 const memory=storage(),report=buildNotionCommerceReport(snapshot());
 const published=await publishNotionCommerceReport(memory.db,commerceConfig,report);
 const outside=await readNotionCommerceReport(memory.db,{...filters,from:'2024-03-02',to:'2024-03-10'},commerceEnv);
 assert.equal(outside!.available,false);assert.equal(outside!.counts,null);assert.equal(outside!.paidSales,null);
 assert.equal(Date.parse(outside!.observedAt!),Date.parse(report.startedAt));assert.equal(outside!.runId,published.runId);
 const overlap=await readNotionCommerceReport(memory.db,{...filters,to:'2024-03-10'},commerceEnv);
 assert.equal(overlap!.available,false);assert.equal(overlap!.counts,null);assert.equal(overlap!.paidSales,null);
 const oldLastDay=await readNotionCommerceReport(memory.db,{...filters,from:'2024-03-01',to:'2024-03-01'},commerceEnv);
 assert.equal(oldLastDay!.counts,null,'un jour ancien interrompu en milieu de journée n’est pas complet');
 const current=new Date().toISOString(),today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 await publishNotionCommerceReport(memory.db,commerceConfig,buildNotionCommerceReport(snapshot({startedAt:current,observedAt:current})));
 const sameDay=await readNotionCommerceReport(memory.db,{...filters,from:today,to:today},commerceEnv);
 assert.equal(sameDay!.available,true);assert.equal(sameDay!.counts!.firstClientsDeclared,0);assert.equal(sameDay!.provisional,true);
 const currentOverlap=await readNotionCommerceReport(memory.db,{...filters,to:today},commerceEnv);
 assert.equal(currentOverlap!.available,true);assert.equal(currentOverlap!.counts!.firstClientsDeclared,1);assert.equal(currentOverlap!.provisional,true);
});

for(const altered of ['overview','paid-summary','details'] as const)test(`une publication altérée pendant le stockage reste invisible (${altered})`,async()=>{
 const memory=storage(),first=buildNotionCommerceReport(snapshot());
 const previous=await publishNotionCommerceReport(memory.db,commerceConfig,first);
 const db={...memory.db,upsert:async(...args:Parameters<Database['upsert']>)=>{
  await memory.db.upsert(...args);
  for(const row of memory.rows.filter(r=>r.sync_run_id!==previous.runId)){
   const dimensions=row.dimensions as Row;
   if(row.metric_key==='notion_commerce_overview'&&altered==='overview')dimensions.reportFingerprint='corrupted';
   if(row.metric_key==='notion_commerce_overview'&&altered==='paid-summary')(dimensions.paidSalesSummary as Row).confirmedInitialSales=99;
   if(row.metric_key==='notion_commerce_paid_sales'&&altered==='details')dimensions.details=[];
  }
 }};
 await assert.rejects(()=>publishNotionCommerceReport(db,commerceConfig,buildNotionCommerceReport(snapshot({observedAt:'2024-03-02T12:00:00Z'}))),/COMMERCE_STAGED_REPORT_MISMATCH/);
 assert.equal((await readNotionCommerceReport(memory.db,filters,commerceEnv))!.runId,previous.runId);
 assert.equal(memory.runs.at(-1)!.status,'failed');
});

test('un accusé de réception perdu reprend exactement la publication complète sans double compte',async()=>{
 const memory=storage(),report=buildNotionCommerceReport(snapshot());let lost=true;
 const db={...memory.db,rpc:async<T>(name:string,args:Row):Promise<T>=>{
  const result=await memory.db.rpc<T>(name,args);
  if(name==='finish_sync'&&args.p_status==='complete'&&lost){lost=false;throw Error('Synthetic lost acknowledgement');}
  return result;
 }};
 await assert.rejects(()=>publishNotionCommerceReport(db,commerceConfig,report),/lost acknowledgement/);
 const retry=await publishNotionCommerceReport(memory.db,commerceConfig,report);
 assert.equal(memory.runs.length,1);assert.equal(retry.runId,memory.runs[0].id);
 assert.equal((await readNotionCommerceReport(memory.db,filters,commerceEnv))!.counts!.firstClientsDeclared,1);
});


test('une collecte commencée il y a vingt-six jours reste périmée malgré sa publication maintenant',async()=>{
 const memory=storage(),completedAt=new Date().toISOString(),startedAt=new Date(Date.now()-26*86400000).toISOString();
 const observedDay=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const report=buildNotionCommerceReport(snapshot({startedAt,observedAt:completedAt,clients:[client('client-a',{startedDay:observedDay})],parcours:[parcours('parcours-a',{startDay:observedDay})]}));
 const published=await publishNotionCommerceReport(memory.db,commerceConfig,report),run=memory.runs.find(r=>r.id===published.runId)!;
 const info=memory.rows.find(r=>r.sync_run_id===published.runId&&r.metric_key==='notion_commerce_overview')!.dimensions as Row;
 assert.equal(run.period_to,startedAt);assert.equal(info.observedAt,startedAt);assert.equal(info.readCompletedAt,completedAt);
 assert.ok(memory.rows.some(r=>r.metric_key==='notion_commerce_day'&&(r.dimensions as Row).date===observedDay),'les observations obtenues après le début sont préservées');
 const proof={...run,pagination_complete:true,rows_rejected:0,error_code:null,finished_at:new Date().toISOString(),covered_from:run.period_from,covered_to:run.period_to};
 const health=evaluateSyncJobHealth('commerce',[proof],{namespace:commerceConfig.parcours.dataSourceId,profile:notionCommerceProfile(commerceConfig)},Date.now());
 assert.equal(health.state,'stale');assert.equal(health.code,'PUBLICATION_STALE');assert.equal(Date.parse(health.cutoff!),Date.parse(startedAt));
 const outside=await readNotionCommerceReport(memory.db,{...filters,from:observedDay,to:observedDay},commerceEnv);
 assert.equal(outside!.counts,null);assert.equal(outside!.paidSales,null);assert.equal(Date.parse(outside!.observedAt!),Date.parse(startedAt));
 // An older stored overview cannot regain freshness just by having used the old completion field.
 info.observedAt=completedAt;delete info.readCompletedAt;
 const legacy=await readNotionCommerceReport(memory.db,{...filters,from:startedAt.slice(0,10),to:observedDay},commerceEnv);
 assert.equal(legacy!.counts,null);assert.equal(legacy!.paidSales,null);assert.equal(Date.parse(legacy!.observedAt!),Date.parse(startedAt));
});


test('les détails historiques et la couverture de période ont des contrats distincts et explicites',async()=>{
 const memory=storage(),report=buildNotionCommerceReport(snapshot({payments:[payment('prior',{day:'2024-01-03'}),payment('recent')]}));
 await publishNotionCommerceReport(memory.db,commerceConfig,report);
 const period=await readNotionCommerceReport(memory.db,filters,commerceEnv);
 const historical=await readNotionCommerceReport(memory.db,filters,commerceEnv,undefined,{details:'all-history'});
 assert.equal(period!.available,true);assert.equal(period!.paidSales!.details.length,1);
 assert.equal(historical!.available,true);assert.equal(historical!.paidSales!.details.length,2);assert.equal(historical!.periodCovered,true);
 const outside={...filters,from:'2024-02-01',to:'2024-03-02'};
 const global=await readNotionCommerceReport(memory.db,outside,commerceEnv,undefined,{details:'all-history'});
 assert.equal(global!.available,false);assert.equal(global!.counts,null);assert.equal(global!.paidSales,null);
 const daily=await readNotionCommerceReport(memory.db,outside,commerceEnv,undefined,{details:'all-history',coverage:'per-day'});
 assert.equal(daily!.available,true);assert.equal(daily!.periodCovered,false);assert.equal(daily!.counts,null);assert.equal(daily!.paidSales!.details.length,2);
 assert.equal(Date.parse(daily!.observedAt!),Date.parse(report.startedAt));
});

test('publication avec conflit isolé conserve les originaux, le total vérifié et sa ventilation sur la même période',async()=>{
 const memory=storage(),report=buildNotionCommerceReport(snapshot({clients:[client(),client('safe')],payments:[payment('conflict-a',{providerId:'ch_synthetic'}),payment('conflict-b',{providerId:'ch_synthetic',amountMinor:0}),payment('safe',{clientIds:['safe'],emailKey:'identity-safe',offerCategory:'club',offerRaw:'Club explicite'})],schedules:[{...snapshot().schedules[0],id:'safe-plan',clientIds:['safe'],paymentIds:['safe']}]}));
 await publishNotionCommerceReport(memory.db,commerceConfig,report);
 const read=await readNotionCommerceReport(memory.db,filters,commerceEnv);
 assert.equal(read!.paidSales!.confirmedInitialSales,1);assert.deepEqual(read!.paidSales!.confirmedByOffer,{blg90:0,defi:0,club:1,other:0,unknown:0});assert.equal(read!.paidSales!.pendingInitialPaymentCases,2);assert.equal(read!.paidSales!.details.length,3);assert.equal(read!.coverage!.conflictingPaymentGroups,1);
 assert.equal(Object.values(read!.paidSales!.confirmedByOffer).reduce((a,b)=>a+b,0),read!.paidSales!.confirmedInitialSales);
 const invalid=structuredClone(report);invalid.paidSales.confirmedByOffer.club=2;
 const before=memory.runs.length;await assert.rejects(()=>publishNotionCommerceReport(memory.db,commerceConfig,invalid),/COMMERCE_REPORT_INCOMPLETE/);assert.equal(memory.runs.length,before);
 const overview=memory.rows.find(row=>row.metric_key==='notion_commerce_overview')!.dimensions as Row;
 (overview.paidSalesSummary as Row).confirmedByOffer={blg90:999,defi:0,club:0,other:0,unknown:0};
 const corrupted=await readNotionCommerceReport(memory.db,filters,commerceEnv);assert.equal(corrupted!.available,false);assert.equal(corrupted!.paidSales,null);
});
