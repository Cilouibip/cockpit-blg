import test from 'node:test';
import assert from 'node:assert/strict';
import { readKpiWixEmail, MASTERCLASS_EMAIL_MESSAGES } from '../src/connectors/kpi-wix-email';
import { synchronizeKpi } from '../src/lib/sync-kpi';
import type { Database, Row } from '../src/lib/db';
import { createSyncExecutionBudget } from '../src/lib/sync-budget';

const fields = { day: 'em_automation.automation_action_timeframe', message: 'em_automation.message_id', recipient: 'em_automation.recipient_email', sent: 'em_automation.automations_count', delivered: 'em_automation.automation_emails_delivered_count', opens: 'em_automation.automation_emails_opens_count', clicks: 'em_automation.automation_emails_clicks_count' };
const measures = ['sent','delivered','opens','clicks'] as const;
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WIX_API_KEY: 'synthetic', WIX_SITE_ID: 'synthetic-site', IDENTITY_HMAC_SECRET: 'synthetic-secret-at-least-32-characters' };
function model() {
 return Response.json({ semanticModel: { id: 'e660016a-e2be-4eee-9cd2-8cad8a4fd8f3', slug: 'email-marketing-automations-actions', dimensions: [fields.day,fields.message,fields.recipient].map(name => ({ name,type: name === fields.day ? 'DATE_TIME' : 'STRING',sortable:true,filters:{prefixes:['IS'],conditions:['EQUAL']} })),measures: measures.map(key => ({name:fields[key]})) } });
}
type Query = { interval: { start:string; end:string }; filters: { values:string[] }[]; paging:{offset:number}; sort:{fieldName:string} };
function payload(body: Query, count = 1) {
 return Response.json({ results: Array.from({length:count},(_,i)=>({fields:{
  [fields.day]:{timestampValue:body.interval.start},[fields.message]:{stringValue:body.filters[0].values[0]},[fields.recipient]:{stringValue:`synthetic-${body.paging.offset+i}@example.test`},
  ...Object.fromEntries(measures.map(key=>[fields[key],{numericValue:1}]))
 }})),pagingMetadata:{offset:body.paging.offset,count},totals:{fields:Object.fromEntries(measures.map(key=>[fields[key],{numericValue:1205}]))} });
}
function database() {
 const events: {name:string;args:Row}[]=[]; const staged:Row[]=[];
 const db:Database={probe:async()=>{},select:async()=>[],upsert:async(_table,rows)=>{staged.push(...rows);},rpc:async<T>(name:string,args:Row)=>{events.push({name,args});return (name==='begin_sync_stream'?'synthetic-run':{status:'complete'}) as T;}};
 return {db,events,staged};
}
test('email retries only a failed later partition, retains earlier rows and publishes once after the complete response', async()=>{
 const bodies:string[]=[];let modelCalls=0,failures=0;
 const fetcher:typeof fetch=async(input,init)=>{
  if(!String(input).endsWith('/query-data')){modelCalls++;return model();}
  const body=JSON.parse(String(init?.body)) as Query;bodies.push(String(init?.body));
  if(body.interval.start.startsWith('2026-09-14')&&failures++===0)throw new TypeError('synthetic private network detail');
  return payload(body);
 };
 const state=database();
 const result=await synchronizeKpi('wix',{db:state.db,env,fetcher,from:'2026-09-01',to:'2026-10-07'});
 assert.equal(result.status,'complete');assert.equal(result.counts.read,6);assert.equal(modelCalls,1);
 assert.equal(bodies.length,7);const counts=new Map<string,number>();for(const body of bodies)counts.set(body,(counts.get(body)??0)+1);
 assert.deepEqual([...counts.values()].sort(),[1,1,1,1,1,2]);
 assert.equal(state.events.filter(e=>e.name==='cockpit_publish_aggregate_state').length,1);assert.equal(state.events.some(e=>e.name==='finish_sync'),false);
 const rows=state.staged.filter(r=>r.metric_key==='kpi_daily_row');assert.equal(rows.length,6);assert.equal(new Set(rows.map(r=>`${r.period_from}|${r.dimensions_key}`)).size,6);assert.equal(JSON.stringify(state.staged).includes('@example.test'),false);
});
test('email retries the exact failed unique-recipient offset page without duplicating its first 1000 rows',async()=>{
 let failure=false;const bodies:Query[]=[];
 const fetcher:typeof fetch=async(input,init)=>{
  if(!String(input).endsWith('/query-data'))return model();
  const body=JSON.parse(String(init?.body)) as Query;bodies.push(body);
  if(body.paging.offset===1000&&!failure){failure=true;throw new TypeError('synthetic');}
  const hasMessage=body.filters[0].values.includes(MASTERCLASS_EMAIL_MESSAGES[0]);
  return payload(body,hasMessage?(body.paging.offset===0?1000:205):0);
 };
 const batch=await readKpiWixEmail('2026-09-15','2026-09-16',env,fetcher);
 assert.equal(batch.rows.length,1205);assert.equal(new Set(batch.rows.map(r=>r.key)).size,1205);
 const offsets=bodies.filter(b=>b.paging.offset===1000);assert.equal(offsets.length,2);assert.deepEqual(offsets[0],offsets[1]);assert.equal(offsets[0].sort.fieldName,fields.recipient);
 assert.equal(bodies.filter(b=>b.filters[0].values.length===1&&b.filters[0].values[0]===MASTERCLASS_EMAIL_MESSAGES[0]&&b.paging.offset===0).length,1);
});
test('email network failures stop after two attempts, join the sibling and neither stage nor publish partial data',async()=>{
 let calls=0,siblingDone=false;
 const fetcher:typeof fetch=async(input,init)=>{
  if(!String(input).endsWith('/query-data'))return model();
  calls++;const body=JSON.parse(String(init?.body)) as Query;
  if(body.interval.start.startsWith('2026-08-31'))throw new TypeError('private');
  await new Promise(resolve=>setTimeout(resolve,5));siblingDone=true;return payload(body);
 };
 const state=database();
 await assert.rejects(synchronizeKpi('wix',{db:state.db,env,fetcher,from:'2026-09-01',to:'2026-10-07'}),{code:'NETWORK_ERROR'});
 assert.equal(calls,3);assert.equal(siblingDone,true);assert.equal(state.staged.length,0);
 assert.deepEqual(state.events.map(e=>e.name),['begin_sync_stream','finish_sync']);assert.equal(state.events[1].args.p_complete,false);assert.equal(state.events[1].args.p_error,'NETWORK_ERROR');
});
test('email retries transient HTTP 503 and model network failure once; refuses access, invalid JSON and invalid pagination without retry',async()=>{
 for(const kind of ['model-network','503','429','400','401','403','json','pagination'] as const){
  let models=0,queries=0;const fetcher:typeof fetch=async(input,init)=>{
   if(!String(input).endsWith('/query-data')){models++;if(kind==='model-network'&&models===1)throw new TypeError('synthetic');return model();}
   queries++;const body=JSON.parse(String(init?.body)) as Query;
   if((kind==='503'||kind==='429')&&queries===1)return new Response('',{status:Number(kind),headers:{'retry-after':'0'}});
   if(kind==='400'||kind==='401'||kind==='403')return new Response('',{status:Number(kind)});
   if(kind==='json')return new Response('{broken');
   if(kind==='pagination')return Response.json({results:[],pagingMetadata:{count:1,offset:0}});
   return payload(body);
  };
  const pending=readKpiWixEmail('2026-09-15','2026-09-16',env,fetcher);
  if(kind==='400'||kind==='401'||kind==='403'||kind==='json'||kind==='pagination'){
   await assert.rejects(pending,{code:kind==='401'||kind==='403'?'ACCESS_DENIED':kind==='400'?'UPSTREAM_HTTP_ERROR':kind==='json'?'INVALID_RESPONSE':'INVALID_PAGINATION'});assert.equal(queries,1);
  }else {assert.equal((await pending).rows.length,1);assert.equal(models,kind==='model-network'?2:1);assert.equal(queries,kind==='503'||kind==='429'?2:1);}
 }
});
test('email actual query attempts including retries remain capped at 20, with no successful truncation',async()=>{
 let calls=0;const fetcher:typeof fetch=async(input,init)=>{
  if(!String(input).endsWith('/query-data'))return model();
  calls++;if(calls===3)throw new TypeError('synthetic');return payload(JSON.parse(String(init?.body)),1000);
 };
 await assert.rejects(readKpiWixEmail('2026-09-01','2026-10-07',env,fetcher),{code:'PAGE_LIMIT_REACHED'});assert.equal(calls,20);
});
test('email retry obeys the existing invocation source deadline and does not publish partial data',async()=>{
 let calls=0;const state=database();const budget=createSyncExecutionBudget({totalMs:150,writeMarginMs:50,fetcher:async(input,init)=>{
  if(!String(input).endsWith('/query-data'))return model();calls++;throw new TypeError('synthetic');
 }});
 try{
  await assert.rejects(synchronizeKpi('wix',{db:state.db,env,fetcher:budget.sourceFetch,signal:budget.sourceSignal,from:'2026-09-15',to:'2026-09-16'}),{code:'CONNECTOR_ABORTED'});
  assert.equal(calls,1);assert.equal(state.staged.length,0);assert.deepEqual(state.events.map(e=>e.name),['begin_sync_stream','finish_sync']);
 }finally{budget.dispose();}
});

test('email caller abandonment interrupts retry backoff immediately and never begins a second request',async()=>{
 const controller=new AbortController();let calls=0;let timer:ReturnType<typeof setTimeout>|undefined;
 const fetcher:typeof fetch=async(input)=>{
  if(!String(input).endsWith('/query-data'))return model();
  calls++;timer=setTimeout(()=>controller.abort(),10);throw new TypeError('synthetic');
 };
 const started=performance.now();
 try{await assert.rejects(readKpiWixEmail('2026-09-15','2026-09-16',env,fetcher,controller.signal),{code:'CONNECTOR_ABORTED'});assert.equal(calls,1);assert.ok(performance.now()-started<200);}
 finally{if(timer)clearTimeout(timer);}
});
test('email already abandoned before invocation makes no source request',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;
 await assert.rejects(readKpiWixEmail('2026-09-15','2026-09-16',env,async()=>{calls++;return model();},controller.signal),{code:'CONNECTOR_ABORTED'});assert.equal(calls,0);
});
