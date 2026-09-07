import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboard} from '../src/lib/dashboard';
import type {Database,Row} from '../src/lib/db';
import type {DashboardRollup} from '../src/lib/dashboard-rollup';
const filters={from:'2026-09-01',to:'2026-09-07',source:'all' as const,tunnel:'all' as const,campaign:'',compare:false};
const rollup:DashboardRollup={
 leads:{registrations:15005,unique:12001,unresolved:0,observedAt:'2026-09-08T00:00:00Z',byTunnel:[{tunnel:'quiz',count:15005,unique:12001,unresolved:0}]},
 events:{count:30010,arrivals:15005,observedAt:'2026-09-08T00:00:00Z',steps:[{tunnel:'quiz',event_name:'landing_arrival',value:15005},{tunnel:'quiz',event_name:'quiz_started',value:12000}],questions:[],videos:[]},
 appointments:{total:5,attended:3,noShow:1,unknown:1,observedAt:null},
 finance:{transactionCount:20001,authorityCount:1,compatible:true,grossMinor:20000000,refundMinor:100000,reversalMinor:0,coverageComplete:true,observedAt:'2026-09-08T00:00:00Z',daily:[{date:'2026-09-01',netMinor:19900000}]},
 aggregate:null,deals:{count:0,compatible:false,contractedMinor:0,observedAt:null},
 meta:{rows:15000,compatible:true,spendMinor:100000,impressions:1000000,outboundClicks:10000,observedAt:null,daily:[{date:'2026-09-01',spendMinor:100000}]},
};
function stub(data=rollup){const calls:{name:string;args:Row}[]=[];const db:Database={async select(){assert.fail('Dashboard must not load raw rows');},async upsert(){assert.fail();},async probe(){assert.fail();},async rpc<T>(name:string,args:Row){calls.push({name,args});if(name==='cockpit_dashboard_rollup')return structuredClone(data) as T;if(name==='cockpit_attribution_snapshot')return {run:null,results:[]} as T;if(name==='cockpit_dashboard_lists')return {details:[],pagination:{page:0,pageSize:50,total:15005},campaigns:[]} as T;throw Error(name);}};return {db,calls};}
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
 const {db,calls}=stub();const result=await dashboard(db,{...filters,compare:true},'live');assert.equal(result.metrics.find(m=>m.id==='cash')?.previous,199000);assert.equal(result.metrics.find(m=>m.id==='spend')?.previous,1000);assert.equal(calls.filter(c=>c.name==='cockpit_dashboard_lists').length,1);assert.ok(calls.some(c=>c.name==='cockpit_dashboard_rollup'&&c.args.p_from==='2026-08-25'&&c.args.p_to==='2026-09-01'));
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
