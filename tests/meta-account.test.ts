import {windowFixture} from './helpers/source-window';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readMetaAccountAnalytics,META_ACCOUNT_PROFILE,META_ACCOUNT_STREAM,type MetaAccountConfig} from '../src/connectors/meta-account-analytics';
import {syncMetaAccountPeriod} from '../src/lib/sync-meta-account';
import {readMetaAccountPeriod} from '../src/lib/meta-account-dashboard';
import type {Database,Row} from '../src/lib/db';

const env={COCKPIT_MODE:'live',META_AD_ACCOUNT_ID:'12345',META_ACCESS_TOKEN:'synthetic-token'};
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const account={account_id:'12345',currency:'EUR',timezone_name:'Europe/Paris'};
const day=(date:string,extra:Row={})=>({account_id:'12345',date_start:date,date_stop:date,spend:'10.00',impressions:'100',outbound_clicks:[{action_type:'outbound_click',value:'4'}],...extra});
function config(payload:unknown,status=200):MetaAccountConfig{
 let i=0;
 return {accountId:'12345',accessToken:'synthetic-token',from:'2026-01-01',to:'2026-01-03',now:()=> '2026-02-01T00:00:00Z',fetcher:(async(input:unknown,init:RequestInit)=>{
  const url=new URL(String(input));assert.equal(url.hostname,'graph.facebook.com');assert.equal(url.searchParams.has('access_token'),false);assert.equal(init.redirect,'error');
  if(i++===0)return response(account);
  assert.equal(url.searchParams.get('level'),'account');assert.equal(url.searchParams.get('time_increment'),'1');assert.equal(url.searchParams.get('fields')?.includes('actions'),false);
  return response(payload,status);
 })as typeof fetch};
}
function memory(){
 const calls:{name:string;args:Row}[]=[],store:Record<string,Row[]>={sync_runs:[],source_aggregates:[]};
 const db:Database={probe:async()=>{},select:async(table,options)=>store[table]?.filter(r=>Object.entries(options?.eq??{}).every(([k,v])=>String(r[k])===v)).slice(options?.from??0,(options?.from??0)+(options?.limit??1000))??[],
  upsert:async(table,rows)=>{store[table].push(...rows);},rpc:async<T>(name:string,args:Row)=>{
   if(name==='cockpit_source_window')return windowFixture(store.sync_runs,store.source_aggregates,args) as T;
   calls.push({name,args});if(name==='begin_sync_stream'){store.sync_runs.push({id:'new-run',source:'meta',source_namespace:'12345',stream_key:args.p_stream,query_profile_key:args.p_profile,status:'running',started_at:'2026-02-01T00:00:00Z',source_as_of:'2026-02-01T00:00:00Z'});return 'new-run' as T;}
   if(name==='finish_sync'){const run=store.sync_runs.find(r=>r.id===args.p_run)!;Object.assign(run,{status:args.p_status,pagination_complete:args.p_complete,finished_at:'2026-02-01T00:00:00Z'});}return true as T;
  }};return {db,store,calls};
}
test('Meta account/day separates omitted metrics, explicit zero delivery and absent day activity',async()=>{
 const active=await readMetaAccountAnalytics(config({data:[day('2026-01-01',{outbound_clicks:undefined})]}));
 assert.equal(active.status,'complete');assert.equal(active.days[0].outboundClicks,null);assert.equal(active.days[0].clickEvidence,'omitted');
 assert.deepEqual(active.days[1],{date:'2026-01-02',spendMinor:0,impressions:0,outboundClicks:0,clickEvidence:'no_reported_activity',rowReported:false});
 const zero=await readMetaAccountAnalytics(config({data:[day('2026-01-01',{spend:'0',impressions:'0',outbound_clicks:undefined})]}));
 assert.equal(zero.days[0].outboundClicks,0);assert.equal(zero.days[0].clickEvidence,'zero_delivery');
});
test('An incomplete or failed Meta page never certifies zero and secrets stay out of errors',async()=>{
 for(const c of [config({data:[],paging:{next:'https://bad.test/?token=DO_NOT_LOG'}}),config({error:'DO_NOT_LOG'},403),config({data:[day('2026-01-01',{account_id:'other'})]}),config({data:[day('2026-01-01'),day('2026-01-01')]})]){
  const result=await readMetaAccountAnalytics(c);assert.equal(result.status,'failed');assert.equal(result.coverage.complete,false);assert.equal(result.days.length,0);assert.equal(JSON.stringify(result).includes('DO_NOT_LOG'),false);
 }
});
test('Account sync uses a dedicated stream and exact daily money/count rows',async()=>{
 const m=memory();const c=config({data:[day('2026-01-01')]});
 const result=await syncMetaAccountPeriod(c.from,c.to,{db:m.db,env,reader:()=>readMetaAccountAnalytics(c)});
 assert.equal(result.status,'complete');assert.equal(m.calls[0].name,'begin_sync_stream');assert.equal(m.calls[0].args.p_stream,META_ACCOUNT_STREAM);
 assert.equal(m.store.source_aggregates.length,6);assert.equal(m.store.source_aggregates.every(r=>r.report_profile_key===META_ACCOUNT_PROFILE),true);
 const stored=await readMetaAccountPeriod(m.db,c.from,c.to,{env});
 assert.equal(stored.status,'complete');assert.deepEqual(stored.totals,{spendMinor:1000,impressions:100,outboundClicks:4,ctrPercent:4,cpmMinor:10000,cpcMinor:250});
});
test('Failed publication leaves last successful day aggregates readable, without source calls',async()=>{
 const m=memory(),c=config({data:[day('2026-01-01')]});await syncMetaAccountPeriod(c.from,c.to,{db:m.db,env,reader:()=>readMetaAccountAnalytics(c)});
 m.store.sync_runs.push({id:'failed-newer',source:'meta',source_namespace:'12345',stream_key:META_ACCOUNT_STREAM,query_profile_key:META_ACCOUNT_PROFILE,status:'failed',pagination_complete:false,started_at:'2026-03-01T00:00:00Z'});
 m.store.source_aggregates.push(...m.store.source_aggregates.map(r=>({...r,sync_run_id:'failed-newer',value:99999})));
 const result=await readMetaAccountPeriod(m.db,'2026-01-01','2026-01-04',{env});
 assert.equal(result.status,'partial');assert.equal(result.totals.spendMinor,1000);assert.equal(result.totals.cpcMinor,250);assert.equal(result.ratioCoverage.to,'2026-01-03');assert.equal(result.ratioCoverage.comparisonEligible,false);assert.deepEqual(result.coverage.missingDays,['2026-01-03']);
});
test('Unknown active clicks prevent click ratios; coherent provisional data retains observed ratios',async()=>{
 const unknown=memory(),c=config({data:[day('2026-01-01',{outbound_clicks:undefined})]});await syncMetaAccountPeriod(c.from,c.to,{db:unknown.db,env,reader:()=>readMetaAccountAnalytics(c)});
 const report=await readMetaAccountPeriod(unknown.db,c.from,c.to,{env});assert.equal(report.status,'partial');assert.equal(report.totals.cpcMinor,null);assert.equal(report.totals.ctrPercent,null);assert.deepEqual(report.coverage.unknownClickDays,['2026-01-01']);
 const today=memory(),intraday={...config({data:[day('2026-01-01')]}),to:'2026-01-02',now:()=> '2026-01-01T12:00:00Z'};await syncMetaAccountPeriod(intraday.from,intraday.to,{db:today.db,env,reader:()=>readMetaAccountAnalytics(intraday)});
 const provisional=await readMetaAccountPeriod(today.db,'2026-01-01','2026-01-02',{env});assert.equal(provisional.status,'partial');assert.equal(provisional.totals.spendMinor,1000);assert.equal(provisional.totals.cpcMinor,250);assert.equal(provisional.ratioCoverage.provisional,true);assert.equal(provisional.ratioCoverage.comparisonEligible,false);
 assert.equal(report.totals.cpmMinor,10000);assert.equal(report.ratioCoverage.numerators.outboundClicks,null);
});
test('Daily bounds respect DST and fetch rejects partitions over 93 days',async()=>{
 const m=memory(),c={...config({data:[]}),from:'2026-03-29',to:'2026-03-30',now:()=> '2026-04-01T00:00:00Z'};await syncMetaAccountPeriod(c.from,c.to,{db:m.db,env,reader:()=>readMetaAccountAnalytics(c)});
 assert.equal(m.store.source_aggregates[0].period_from,'2026-03-28T23:00:00Z');assert.equal(m.store.source_aggregates[0].period_to,'2026-03-29T22:00:00Z');
 const invalid=await readMetaAccountAnalytics({...config({data:[]}),to:'2027-01-01'});assert.equal(invalid.status,'failed');assert.match(invalid.safeError!,/INVALID_PERIOD/);
});
test('An interior missing day blocks ratios and future days are not certified as zero',async()=>{
 const m=memory(),c={...config({data:[day('2026-01-01')]}),to:'2026-01-04'};await syncMetaAccountPeriod(c.from,c.to,{db:m.db,env,reader:()=>readMetaAccountAnalytics(c)});
 m.store.source_aggregates=m.store.source_aggregates.filter(r=>(r.dimensions as Row).date!=='2026-01-02');
 const report=await readMetaAccountPeriod(m.db,c.from,c.to,{env});assert.equal(report.ratioCoverage.contiguous,false);assert.equal(report.totals.cpcMinor,null);
 const future=await readMetaAccountAnalytics({...config({data:[]}),now:()=> '2026-01-01T12:00:00Z'});assert.equal(future.status,'failed');assert.equal(future.days.length,0);
});
