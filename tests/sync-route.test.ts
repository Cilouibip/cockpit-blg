import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {issueSession,passwordHash,COOKIE_NAME} from '../src/lib/auth';
import {getConfig} from '../src/lib/config';
import {metaRefreshPeriods} from '../src/lib/refresh-plan';

test('authenticated sync routes accept receipts and forward four annual Meta partitions through the real handler',async()=>{
 const previous={...process.env},oldFetch=globalThis.fetch;
 Object.assign(process.env,{COCKPIT_MODE:'live',APP_ORIGIN:'https://cockpit.example.test',COCKPIT_SESSION_SECRET:'synthetic-session-secret-at-least-32-chars',COCKPIT_PASSWORD_HASH:passwordHash('synthetic-password-only'),SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SECRET_KEY:'synthetic',META_AD_ACCOUNT_ID:'12345',META_ACCESS_TOKEN:'synthetic',WIX_SITE_ID:'44444444-4444-4444-8444-444444444444',WIX_API_KEY:'synthetic',POSTHOG_HOST:'https://eu.posthog.com',POSTHOG_PROJECT_ID:'123',POSTHOG_PERSONAL_API_KEY:'synthetic'});
 const metaRanges:{since:string;until:string}[]=[],runs:Record<string,unknown>[]=[],limits=new Map<string,number>();let receiptsCalls=0;const posthogQueries:string[]=[];
 const response=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
 globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(String(input));
  if(url.hostname==='synthetic.supabase.co'){
   const body=JSON.parse(String(init?.body??'null'));
   if(url.pathname.endsWith('/consume_rate_limit')){const count=(limits.get(body.p_key)??0)+1;limits.set(body.p_key,count);return response(count<=body.p_limit);}
   if(url.pathname.endsWith('/begin_sync_stream')){runs.push(body);return response(randomUUID());}
   if(url.pathname.endsWith('/finish_sync'))return response(true);
   if(url.pathname.endsWith('/source_aggregates'))return new Response(null,{status:201});
  }
  if(url.hostname==='eu.posthog.com'){
   if(url.pathname.endsWith('/property_definitions/'))return response({results:[{name:'$host',property_type:'String'},{name:'$current_url',property_type:'String'}]});
   if(!url.pathname.endsWith('/query/'))return response({id:123});
   const body=JSON.parse(String(init?.body));posthogQueries.push(body.query.query);
   const count=['events','visitors','sessions','events_with_visitor_id','events_with_session_id'];
   if(body.name==='Masterclass aggregate observations')return response({columns:['event','events','visitors','kit_sessions','events_with_visitor_id','events_with_kit_session_id','verified_host_events','unlocated_events','excluded_events'],results:[]});
   const name=body.name.split(' ').at(-1);
   if(name==='overview')return response({columns:[...count,'observed_tracked_events','missing_host_events','conflicting_host_events','excluded_host_events','identifiable_test_events','first_observed_at','last_observed_at'],results:[[0,0,0,0,0,0,0,0,0,0,null,null]]});
   return response({columns:[...(name==='byEvent'?['event']:name==='byHostEvent'?['host','event']:['day','event','host']),...count],results:[]});
  }
  if(url.hostname==='graph.facebook.com'){
   if(!url.pathname.endsWith('/insights'))return response({account_id:'12345',currency:'EUR',timezone_name:'Europe/Paris'});
   metaRanges.push(JSON.parse(url.searchParams.get('time_range')!));return response({data:[]});
  }
  if(url.hostname==='www.wixapis.com'&&url.pathname==='/payments/v2/transactions'){receiptsCalls++;return response({transactions:[],pagination:{offset:0,limit:1000,total:0}});}
  assert.fail('Unexpected external request '+url.hostname+url.pathname);
 }) as typeof fetch;
 try{
  const {POST}=await import('../src/app/api/[...path]/route');const config=getConfig(),headers={Cookie:`${COOKIE_NAME}=${issueSession(config)}`,Origin:config.origin};
  const call=(path:string)=>POST(new Request(config.origin+'/api/'+path,{method:'POST',headers}));
  const receipt=await call('sync/receipts?from=2024-01-01&to=2024-12-31');assert.equal(receipt.status,200);assert.equal((await receipt.json()).status,'empty');assert.equal(receiptsCalls,1);assert.equal(runs[0].p_stream,'receipt_observations');
  const periods=metaRefreshPeriods('2024-01-01','2024-12-31');
  for(const p of periods){const result=await call('sync/meta?'+new URLSearchParams(p));assert.equal(result.status,200);assert.equal((await result.json()).status,'complete');}
  assert.deepEqual(metaRanges,periods.map(p=>({since:p.from,until:p.to})));assert.equal(runs.filter(r=>r.p_stream==='meta_account_daily').length,4);
  const runsBeforePH=runs.length;
  for(const type of ['quiz','masterclass']){const result=await call('sync/analytics?from=2026-08-18&to=2026-09-03&type='+type);assert.equal(result.status,200);assert.deepEqual(await result.json(),{status:'empty',sources:[{source:type,status:'empty'}]});}
  assert.deepEqual(runs.slice(runsBeforePH).map(r=>r.p_stream),['quiz_observations','masterclass_observations']);assert.equal(receiptsCalls,1,'PostHog must not relaunch any Wix request');
  assert.ok(posthogQueries.every(q=>q.includes(String(Date.parse('2026-08-17T22:00:00Z')))&&q.includes(String(Date.parse('2026-09-03T22:00:00Z')))));
  const unsupported=await call('sync/analytics?from=2026-08-18&to=2026-09-03&type=masterclass&source=paid');assert.equal(unsupported.status,422);assert.equal(runs.length,runsBeforePH+2);
  const denied=await POST(new Request(config.origin+'/api/sync/receipts',{method:'POST',headers:{Origin:config.origin}}));assert.equal(denied.status,401);
 }finally{globalThis.fetch=oldFetch;for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);}
});
