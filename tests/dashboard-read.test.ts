import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboard} from '../src/lib/dashboard';
import type {Database,Row} from '../src/lib/db';
import type {DashboardRollup} from '../src/lib/dashboard-rollup';
import {createHash} from 'node:crypto';
import {AppError} from '../src/lib/errors';
import {COMMERCE_COUNTERS,NOTION_COMMERCE_VERSION} from '../src/lib/notion-commerce-report';
import {notionCommerceConfig,notionCommerceProfile} from '../src/connectors/notion-commerce';
const filters={from:'2026-09-01',to:'2026-09-07',source:'all' as const,tunnel:'all' as const,campaign:'',compare:false};
const rollup:DashboardRollup={
 leads:{registrations:15005,unique:12001,unresolved:0,observedAt:'2026-09-08T00:00:00Z',byTunnel:[{tunnel:'quiz',count:15005,unique:12001,unresolved:0}]},
 events:{count:30010,arrivals:15005,observedAt:'2026-09-08T00:00:00Z',steps:[{tunnel:'quiz',event_name:'landing_arrival',value:15005},{tunnel:'quiz',event_name:'quiz_started',value:12000}],questions:[],videos:[]},
 appointments:{total:5,attended:3,noShow:1,unknown:1,observedAt:null},
 finance:{transactionCount:20001,authorityCount:1,compatible:true,grossMinor:20000000,refundMinor:100000,reversalMinor:0,coverageComplete:true,observedAt:'2026-09-08T00:00:00Z',daily:[{date:'2026-09-01',netMinor:19900000}]},
 aggregate:null,deals:{count:0,compatible:false,contractedMinor:0,observedAt:null},
 meta:{rows:15000,compatible:true,spendMinor:100000,impressions:1000000,outboundClicks:10000,observedAt:null,daily:[{date:'2026-09-01',spendMinor:100000}]},
};
function stub(data=rollup){const calls:{name:string;args:Row}[]=[];const db:Database={async select(){assert.fail('Dashboard must not load raw rows');},async upsert(){assert.fail();},async probe(){assert.fail();},async rpc<T>(name:string,args:Row){calls.push({name,args});if(name==='cockpit_source_window')return {runs:[],aggregates:[],selections:[],validations:{},exactRunId:null,latestAttempt:null} as T;if(name==='cockpit_dashboard_rollup')return structuredClone(data) as T;if(name==='cockpit_attribution_snapshot')return {run:null,results:[]} as T;if(name==='cockpit_dashboard_lists')return {details:[],pagination:{page:0,pageSize:50,total:15005},campaigns:[]} as T;throw Error(name);}};return {db,calls};}
test('vues principales lisent des agrégats exacts au-delà de10000 sans charger les lignes métier',async()=>{
 const {db,calls}=stub();const result=await dashboard(db,filters,'live');
 assert.equal(result.metrics.find(m=>m.id==='leads')?.value,12001);assert.equal(result.metrics.find(m=>m.id==='cash')?.value,199000);assert.equal(result.pillars[0].metrics[0].value,15005);assert.equal(result.journeys.find(j=>j.id==='quiz')?.steps[0].value,15005);assert.equal(result.detailsPagination?.total,15005);assert.equal(result.details.length,0);
 assert.deepEqual(calls.map(c=>c.name).sort(),['cockpit_attribution_snapshot','cockpit_dashboard_lists','cockpit_dashboard_rollup']);assert.equal(calls[0].args.p_to,'2026-09-08');
});
test('agrégats partiels et filtres ne transforment pas un total global en valeur attribuée',async()=>{
 const data=structuredClone(rollup);data.finance.coverageComplete=false;data.leads.unresolved=1;const {db}=stub(data);
 const result=await dashboard(db,{...filters,campaign:'meta:campaign-a'},'live');assert.equal(result.metrics.find(m=>m.id==='cash')?.value,null);assert.equal(result.metrics.find(m=>m.id==='leads')?.value,null);assert.equal(result.metrics.find(m=>m.id==='appointments')?.value,null);
});
test('comparaison relit la période précédente sans relire les listes',async()=>{
 const {db,calls}=stub();const result=await dashboard(db,{...filters,compare:true},'live');assert.equal(result.metrics.find(m=>m.id==='cash')?.previous,199000);assert.equal(result.metrics.find(m=>m.id==='spend')?.previous,null);assert.equal(calls.filter(c=>c.name==='cockpit_dashboard_lists').length,1);assert.ok(calls.some(c=>c.name==='cockpit_dashboard_rollup'&&c.args.p_from==='2026-08-25'&&c.args.p_to==='2026-09-01'));
});


test('changing live filters never calls a source API or writes an import',async()=>{
 const oldWix=process.env.WIX_SITE_ID,oldPostHog=process.env.POSTHOG_PROJECT_ID,oldFetch=globalThis.fetch;
 process.env.WIX_SITE_ID='synthetic-site';process.env.POSTHOG_PROJECT_ID='synthetic-project';
 globalThis.fetch=async()=>{assert.fail('filter must not query external APIs');};
 try {
  const {db}=stub();db.select=async()=>[];
  const result=await dashboard(db,{...filters,compare:true},'live');
  assert.equal(result.period.from,filters.from);assert.equal(result.metrics.find(m=>m.id==='cash')?.value,199000);
 } finally {
  globalThis.fetch=oldFetch;
  if(oldWix===undefined)delete process.env.WIX_SITE_ID;else process.env.WIX_SITE_ID=oldWix;
  if(oldPostHog===undefined)delete process.env.POSTHOG_PROJECT_ID;else process.env.POSTHOG_PROJECT_ID=oldPostHog;
 }
});

test('la période courante et sa comparaison partagent une borne de quatre lectures',async()=>{
 const saved={WIX_SITE_ID:process.env.WIX_SITE_ID,NOTION_DATA_SOURCE_ID:process.env.NOTION_DATA_SOURCE_ID,POSTHOG_PROJECT_ID:process.env.POSTHOG_PROJECT_ID};
 process.env.WIX_SITE_ID='synthetic-site';process.env.NOTION_DATA_SOURCE_ID='synthetic-notion';process.env.POSTHOG_PROJECT_ID='synthetic-project';
 const skeleton=new Set(['cockpit_dashboard_rollup','cockpit_attribution_snapshot','cockpit_dashboard_lists']);
 const {db}=stub();const base=db.rpc.bind(db);const stored:string[]=[];let inFlight=0,peak=0;
 db.rpc=async<T>(name:string,args:Row):Promise<T>=>{
  if(skeleton.has(name))return base<T>(name,args);
  stored.push(name);inFlight++;peak=Math.max(peak,inFlight);
  try{
   await new Promise(resolve=>setTimeout(resolve,5));
   if(name==='cockpit_business_rollup')return {available:false,observedAt:null,sourceRows:0,leads:{rows:0,known:0,unresolved:0,creationOnly:0},appointments:{total:0,attended:0,explicitFinished:0,noShow:0,cancelled:0,unknown:0,booked:0,closed:0}} as T;
   return await base<T>(name,args);
  }finally{inFlight--;}
 };
 db.select=async()=>[];
 try{
  const result=await dashboard(db,{...filters,compare:true},'live');
  assert.ok(stored.includes('cockpit_business_rollup')&&stored.filter(name=>name==='cockpit_source_window').length>=4,stored.join(','));
  assert.equal(peak,4,`lectures simultanées observées : ${peak}`);
  assert.equal(result.metrics.find(m=>m.id==='cash')?.value,199000);
  assert.equal(result.metrics.find(m=>m.id==='cash')?.previous,199000);
 } finally {for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

test('une lecture acquisition interrompue conserve les autres métriques et ne réactive pas les anciens leads',async()=>{
 const before=process.env.WIX_SITE_ID;process.env.WIX_SITE_ID='synthetic-site';
 try{
  const {db}=stub();db.select=async()=>{throw Error('synthetic read failure');};
  const result=await dashboard(db,filters,'live');
  assert.equal(result.metrics.find(m=>m.id==='cash')?.value,199000);assert.equal(result.metrics.find(m=>m.id==='leads')?.value,null);
  assert.ok(result.notices.some(n=>n.includes('autres sources restent affichées')));
 }finally{if(before===undefined)delete process.env.WIX_SITE_ID;else process.env.WIX_SITE_ID=before;}
});

// Lecteur des ventes suspendu (réglage absent) : publication synthétique relue telle quelle, dates issues du rapport.
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value as Row).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const commerceRaw=JSON.stringify({clients:{dataSourceId:'ds-clients'},payments:{dataSourceId:'ds-payments'},schedule:{dataSourceId:'ds-schedule'},parcours:{dataSourceId:'ds-parcours'}});
function commercePublication(observedAt:string):Record<string,Row[]>{
 const profile=notionCommerceProfile(notionCommerceConfig(commerceRaw)!),run='run-'+observedAt;
 const counts=Object.fromEntries(COMMERCE_COUNTERS.map(key=>[key,key==='firstAccompanimentsStarted'?1:0])),daily=[{date:'2026-09-03',counts}];
 const details=[{paymentId:'pay-1',paymentUrl:null,clientIds:['client-1'],clientName:null,clientUrl:null,scheduleIds:[],scheduleUrls:[],parcoursIds:[],day:'2026-09-03',amountMinor:10000,state:'confirmed',reasons:['first_succeeded_payment_for_client']}];
 const summary={confirmedInitialSales:1,reconciledInitialSales:0,pendingInitialPaymentCases:0,excludedSubsequentPayments:0,refundCases:0,coverage:{payments:1,schedules:0,parcours:0,unlinkedPayments:0}};
 const base={source:'notion',source_namespace:'ds-parcours',report_profile_key:profile,sync_run_id:run};
 return {
  sync_runs:[{id:run,source:'notion',source_namespace:'ds-parcours',stream_key:'commerce_declared_snapshot',status:'complete',pagination_complete:true,rows_rejected:0,query_profile_key:profile,period_to:observedAt,started_at:observedAt,finished_at:observedAt}],
  source_aggregates:[
   {...base,metric_key:'notion_commerce_overview',dimensions_key:'all',dimensions:{version:NOTION_COMMERCE_VERSION,observedAt,totals:counts,dailyCount:1,dailyHash:digest(daily),paidSalesSummary:summary,paidSalesCount:1,paidSalesHash:digest(details),coverage:{sourceRows:{},undatedClientStarts:0,futureClientStarts:0}}},
   {...base,metric_key:'notion_commerce_day',dimensions_key:'2026-09-03',dimensions:daily[0]},
   {...base,metric_key:'notion_commerce_paid_sales',dimensions_key:'paid-sales:000000',dimensions:{details}},
  ],
 };
}
const selectFrom=(tables:Record<string,Row[]>)=>async(table:string,options:{eq?:Record<string,string>}={})=>(tables[table]??[]).filter(row=>Object.entries(options.eq??{}).every(([key,value])=>String(row[key])===value));
test('pause du lecteur des ventes : la dernière publication reste lue avec sa propre date ; une lecture en échec ne fait pas échouer le tableau',async()=>{
 const saved={NOTION_COMMERCE_CONFIG:process.env.NOTION_COMMERCE_CONFIG,BLG_COMMERCE_READER:process.env.BLG_COMMERCE_READER};
 process.env.NOTION_COMMERCE_CONFIG=commerceRaw;delete process.env.BLG_COMMERCE_READER;
 try{
  for(const observedAt of ['2026-09-05T07:00:00Z','2026-08-20T16:30:00Z']){
   const {db}=stub();db.select=selectFrom(commercePublication(observedAt)) as Database['select'];
   const result=await dashboard(db,filters,'live');
   const clients=result.metrics.find(m=>m.id==='new_clients')!,sales=result.metrics.find(m=>m.id==='paid_sales')!;
   assert.equal(clients.value,1);assert.equal(clients.updatedAt,observedAt,'date du rapport lu, jamais figée');
   assert.equal(sales.value,1);assert.equal(sales.updatedAt,observedAt);
   assert.equal(result.metrics.find(m=>m.id==='cash')?.value,199000);
  }
  const {db}=stub();let commerceReads=0;
  db.select=async(table,options)=>{if(table==='sync_runs'&&options?.eq?.stream_key==='commerce_declared_snapshot'){commerceReads++;throw new AppError('Le chargement des données a été interrompu. Réessaie.',503,'database_query_interrupted');}return [];};
  const result=await dashboard(db,{...filters,compare:true},'live');
  assert.ok(commerceReads>0);
  for(const id of ['new_clients','paid_sales']){const metric=result.metrics.find(m=>m.id===id)!;assert.equal(metric.value,null,id);assert.equal(metric.updatedAt,null,id);assert.match(metric.unavailableReason!,/a échoué/,id);}
  assert.equal(result.commerce?.available,false);
  assert.equal(result.metrics.find(m=>m.id==='cash')?.value,199000,'les autres blocs restent servis');assert.equal(result.metrics.find(m=>m.id==='cash')?.previous,199000);
 }finally{for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
