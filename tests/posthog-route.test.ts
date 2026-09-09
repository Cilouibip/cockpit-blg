import test from 'node:test';
import assert from 'node:assert/strict';
import {issueSession,passwordHash,COOKIE_NAME} from '../src/lib/auth';
import {getConfig} from '../src/lib/config';
import {startOfParisDay} from '../src/domain/dates';
import {database,supabaseDatabase} from '../src/lib/db';
import {readSourceSnapshot,invalidateSourceWindow,type SourceWindow} from '../src/lib/source-snapshots';
const empty={runs:[],aggregates:[],selections:[],validations:{},exactRunId:null,latestAttempt:null};
const rollup={leads:{registrations:0,unique:0,unresolved:0,observedAt:null,byTunnel:[]},events:{count:0,arrivals:0,observedAt:null,steps:[],questions:[],videos:[]},appointments:{total:0,attended:0,noShow:0,unknown:0,observedAt:null},finance:{transactionCount:0,authorityCount:0,compatible:false,grossMinor:0,refundMinor:0,reversalMinor:0,coverageComplete:false,observedAt:null,daily:[]},aggregate:null,deals:{count:0,compatible:false,contractedMinor:0,observedAt:null},meta:{rows:0,compatible:false,spendMinor:0,impressions:0,outboundClicks:0,observedAt:null,daily:[]}};
test('real report handlers preserve exact keys, source-free GET, target cache bypass, comparison and separate business sync',async()=>{
 const previous={...process.env},oldFetch=globalThis.fetch;
 for(const name of ['NOTION_DATA_SOURCE_ID','WIX_LEAD_ENTRY_CONFIG','META_AD_ACCOUNT_ID','WIX_SITE_ID'])delete process.env[name];
 Object.assign(process.env,{COCKPIT_MODE:'live',APP_ORIGIN:'https://cockpit.example.test',COCKPIT_SESSION_SECRET:'synthetic-session-secret-at-least-32-chars',COCKPIT_PASSWORD_HASH:passwordHash('synthetic-password-only'),SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SECRET_KEY:'synthetic',POSTHOG_PROJECT_ID:'synthetic-project',POSTHOG_QUIZ_HOST:'quiz.example.org',POSTHOG_PRODUCTION_HOSTS:'quiz.example.org,www.example.org'});
 let published=false,active=false;const windows:any[]=[],mutations:string[]=[];let sourceCalls=0;
 globalThis.fetch=(async(input,init)=>{
  const u=new URL(String(input)),body=JSON.parse(String(init?.body??'null'));
  if(u.hostname==='www.wixapis.com'&&u.pathname==='/forms/v4/submissions/namespace/query'){sourceCalls++;return Response.json({submissions:[],metadata:{count:0,hasNext:false}});}
  assert.equal(u.hostname,'synthetic.supabase.co','No unreviewed source request');
  const rpc=u.pathname.split('/').at(-1);
  if(rpc==='consume_rate_limit')return Response.json(true);
  if(rpc==='cockpit_dashboard_rollup')return Response.json(rollup);
  if(rpc==='cockpit_attribution_snapshot')return Response.json({run:null,results:[]});
  if(rpc==='cockpit_dashboard_lists')return Response.json({details:[],campaigns:[],pagination:{page:0,pageSize:50,total:0}});
  if(rpc==='sync_runs')return Response.json(active?[{started_at:new Date().toISOString()}]:[]);
  if(rpc==='cockpit_source_window'){
   windows.push(body);if(!published||body.p_stream!=='quiz_observations')return Response.json(empty);
   const run={id:'stored-'+body.p_from,query_profile_key:body.p_profile,period_from:startOfParisDay(body.p_from),period_to:startOfParisDay(body.p_to),source_as_of:'2026-09-08T17:00:00Z',started_at:'2026-09-08T17:00:00Z',finished_at:'2026-09-08T17:00:01Z',status:'empty'};
   const row={sync_run_id:run.id,report_profile_key:body.p_profile,period_from:run.period_from,period_to:run.period_to,unit:'count',timezone:'Europe/Paris',dimensions_key:'all',dimensions:{},metric_key:'posthog_events',value:0};
   return Response.json({...empty,runs:[run],aggregates:[row],exactRunId:run.id});
  }
  if(rpc==='cockpit_claim_lead_entries'){mutations.push(rpc);assert.deepEqual(body.p_container_ids,['synthetic-form']);return Response.json({busy:false,runId:'synthetic-run',lease:'synthetic-lease',rowsRead:0,checkpoint:{version:1,from:'2026-08-01T00:00:00Z',to:'2026-09-01T00:00:00Z',page:0,cursor:null,done:false}});}
  if(rpc==='cockpit_stage_lead_entries'){mutations.push(rpc);assert.equal(body.p_read,0);assert.equal(body.p_done,true);return Response.json({read:0});}
  if(rpc==='cockpit_publish_lead_entries'){mutations.push(rpc);return Response.json({status:'empty',counts:{read:0,observations:0,changed:0,unchanged:0,stale:0,rejected:0,ignored:0}});}
  assert.fail('Unexpected request '+rpc);
 }) as typeof fetch;
 try{
  const {GET,POST}=await import('../src/app/api/[...path]/route');const config=getConfig(),headers={Cookie:`${COOKIE_NAME}=${issueSession(config)}`,Origin:config.origin};
  const get=(p:string)=>GET(new Request(config.origin+'/api/'+p,{headers}));const post=(p:string)=>POST(new Request(config.origin+'/api/'+p,{method:'POST',headers}));
  const q='from=2026-08-18&to=2026-09-03&tunnel=quiz&compare=true';
  const descriptor=await (await get('reports/posthog?'+q+'&type=quiz')).json();assert.equal(descriptor.supported,true);assert.equal(windows.length,0);assert.equal(sourceCalls,0);
  const before=await (await get('dashboard?'+q)).json();assert.equal(before.pillars[0].metrics.find((m:any)=>m.id==='arrivals').value,null);
  const db=database(),other=supabaseDatabase(config,globalThis.fetch),window:SourceWindow={stream:'quiz_observations',profile:windows[0].p_profile,from:'2026-08-18',to:'2026-09-04',timezone:'Europe/Paris',currency:null,currencyExponent:null,kind:'exact_report'};
  await readSourceSnapshot(other,'posthog','synthetic-project',window);published=true;
  invalidateSourceWindow(other,'posthog','synthetic-project',window);assert.equal((await readSourceSnapshot(other,'posthog','synthetic-project',window)).runs.length,1);
  const stale=await (await get('dashboard?'+q)).json();assert.equal(stale.pillars[0].metrics.find((m:any)=>m.id==='arrivals').value,null,'Other instance publication alone does not clear this cache');
  const unrelated={...window,stream:'meta_account_daily',profile:'another',kind:'daily_bundle' as const,currency:'EUR',currencyExponent:2};await readSourceSnapshot(db,'meta','another',unrelated);
  const after=await (await get('dashboard?'+q+'&refreshPosthog=1')).json();const arrival=after.pillars[0].metrics.find((m:any)=>m.id==='arrivals');assert.equal(arrival.value,0);assert.equal(arrival.previous,0);assert.equal(after.metrics.find((m:any)=>m.id==='leads').value,null);
  const count=windows.length;await readSourceSnapshot(db,'meta','another',unrelated);assert.equal(windows.length,count,'Targeted refresh keeps unrelated source cache');
  const ready=await post('reports/posthog?'+q+'&type=quiz');assert.equal(ready.status,200);assert.equal((await ready.json()).key,descriptor.key);assert.equal(sourceCalls,0);
  active=true;const waiting=await post('reports/posthog?'+q.replace('tunnel=quiz','tunnel=masterclass')+'&type=masterclass');assert.equal(waiting.status,202);assert.equal((await waiting.json()).state,'waiting');
  const unsupported=await post('reports/posthog?'+q+'&type=masterclass');assert.equal(unsupported.status,422);
  assert.equal((await POST(new Request(config.origin+'/api/reports/posthog?'+q+'&type=quiz',{method:'POST',headers:{Origin:config.origin}}))).status,401);
  Object.assign(process.env,{WIX_SITE_ID:'synthetic-site',WIX_API_KEY:'synthetic',IDENTITY_HMAC_SECRET:'synthetic-identity-secret-at-least-32-chars',WIX_LEAD_ENTRY_CONFIG:JSON.stringify({formIds:['synthetic-form']})});
  const business=await post('sync/lead-entries?family=forms');assert.equal(business.status,200);assert.equal((await business.json()).status,'empty');assert.equal(sourceCalls,1);assert.deepEqual(mutations,['cockpit_claim_lead_entries','cockpit_stage_lead_entries','cockpit_publish_lead_entries']);
 }finally{globalThis.fetch=oldFetch;for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);}
});
