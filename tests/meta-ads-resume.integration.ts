import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Client} from 'pg';
import {synchronizeMetaAdsResumable} from '../src/lib/sync-meta-ads-resume';
import {syncStreamStates} from '../src/lib/sync-jobs';
import type {Database,Row} from '../src/lib/db';
import {postgresDatabase} from '../src/lib/db';
import {synchronizeMetaAds} from '../src/lib/sync';
const base=new URL(process.env.TEST_DATABASE_URL||'postgresql://localhost:55440/postgres');
if(!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw Error('LOCAL_ONLY');
const name='meta_resume_'+Date.now(),target=new URL(base);target.pathname='/'+name;
const admin=new Client({connectionString:base.href});let sql:Client;
const allowed=new Set(['cockpit_claim_meta_ads','cockpit_stage_meta_ads','cockpit_release_meta_ads','cockpit_publish_meta_ads']);
const rpc=async<T>(name:string,args:Row):Promise<T>=>{
 assert.ok(allowed.has(name));const result=await sql.query(`SELECT public.${name}(${Object.keys(args).map((k,i)=>`${k} => $${i+1}`).join(',')}) AS result`,Object.values(args).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v));return result.rows[0].result;
};
const db:Database={probe:async()=>{},select:async()=>[],upsert:async()=>{},rpc};
before(async()=>{
 await admin.connect();await admin.query(`CREATE DATABASE ${name}`);sql=new Client({connectionString:target.href});await sql.connect();
 await sql.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$");
 for(const f of fs.readdirSync('supabase/migrations').filter(f=>/^\d{3}_.*\.sql$/.test(f)&&Number(f.slice(0,3))<=23).sort())await sql.query(fs.readFileSync('supabase/migrations/'+f,'utf8'));
 await sql.query(fs.readFileSync('supabase/migrations/028_meta_ads_persistent_pages.sql','utf8'));
});
after(async()=>{await sql?.end();await new Promise(resolve=>setTimeout(resolve,5500));await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();});
const one=async(q:string,v:unknown[]=[]) => (await sql.query(q,v)).rows[0];
type C={runId:string;lease:string;busy:boolean;from:string;to:string;checkpoint:Record<string,unknown>;namespace?:string};
const claim=async(ns:string,from='2026-09-01',to='2026-09-16',resume=true)=>Object.assign(await rpc<C>('cockpit_claim_meta_ads',{p_namespace:ns,p_profile:'v23.0-ad-day-none',p_from:from,p_to:to,p_resume:resume}),{namespace:ns});
const row=(ns:string,day:string,ad='42',spend=100)=>({source:'meta',accountId:ns,externalId:`${ad}:${day}`,connectorVersion:'meta-read-v1',observedAt:'2026-10-08T09:00:00Z',adId:ad,adName:null,adsetId:null,campaignId:'99',campaignName:null,date:day,currency:'EUR',timezone:'Europe/Paris',spendMinor:spend,impressions:10,outboundClicks:null,reportedConversions:[]});
const stage=(c:C,index:number,page:number,records:Row[],next:string|null=null,before:string|null=null)=>rpc<{checkpoint:Record<string,unknown>}>('cockpit_stage_meta_ads',{p_run:c.runId,p_lease:c.lease,p_index:index,p_page:page,p_before:before,p_records:records,p_next:next,p_terminal:next===null,p_account:{accountId:c.namespace??records[0]?.accountId,currency:'EUR',timezone:'Europe/Paris'}});
const release=(c:C,error:string|null=null)=>rpc('cockpit_release_meta_ads',{p_run:c.runId,p_lease:c.lease,p_error:error});
const published=async(ns:string)=>(await sql.query('SELECT a.external_id,d.* FROM v_ad_daily d JOIN ads a ON a.id=d.ad_id WHERE a.source_namespace=$1 ORDER BY a.external_id,d.date',[ns])).rows;
const age=async(c:C)=>{
 await sql.query('BEGIN');await sql.query("SELECT set_config('blg.meta_ads_run',$1,true)",[c.runId]);
 await sql.query("UPDATE sync_runs SET started_at=clock_timestamp()-interval '3 hours',lease_until=clock_timestamp()-interval '2 hours' WHERE id=$1",[c.runId]);await sql.query('COMMIT');
};

test('saved disjoint scopes survive hours and an old writer; publication is whole and idempotent',async()=>{
 const c=await claim('111');await stage(c,0,0,[row('111','2026-09-01')]);await release(c);assert.equal((await published('111')).length,0);
 await age(c);
 await assert.rejects(sql.query("SELECT begin_sync_stream('meta','111','2026-09-01','2026-09-16','v23.0-ad-day-none','aggregate_period','ad_daily','2026-09-01','2026-09-16')"),{code:'55000'});
 assert.equal((await one('SELECT status FROM sync_runs WHERE id=$1',[c.runId])).status,'running');
 await assert.rejects(sql.query("SELECT finish_sync($1,'failed',0,0,false,'expired_worker')",[c.runId]),{code:'55000'});
 const explicit=await claim('111','2026-09-02','2026-09-17',false);assert.equal(explicit.busy,true);
 const resumed=await claim('111','2026-09-02','2026-09-17');assert.equal(resumed.runId,c.runId);assert.equal(resumed.from,'2026-09-01');assert.equal(resumed.to,'2026-09-16');assert.equal(resumed.checkpoint.index,1);
 await assert.rejects(rpc('cockpit_publish_meta_ads',{p_run:resumed.runId,p_lease:resumed.lease}),{code:'55000'});
 await stage(resumed,1,0,[row('111','2026-09-08','123')]);await stage(resumed,2,0,[]);
 const p=await rpc<{status:string}>('cockpit_publish_meta_ads',{p_run:resumed.runId,p_lease:resumed.lease});assert.equal(p.status,'complete');
 assert.deepEqual((await published('111')).map(r=>[r.external_id,r.date]),[['123','2026-09-08'],['42','2026-09-01']]);
 const id=(await published('111')).map(r=>r.id);
 assert.equal((await rpc<{duplicate:boolean}>('cockpit_publish_meta_ads',{p_run:resumed.runId,p_lease:resumed.lease})).duplicate,true);assert.deepEqual((await published('111')).map(r=>r.id),id);
 const active=await claim('111');await stage(active,0,0,[row('111','2026-09-01','42',300)]);await release(active);assert.deepEqual((await published('111')).map(r=>r.id),id,'unfinished refresh retains old publication');
 const attempt=await one('SELECT * FROM sync_runs WHERE id=$1',[active.runId]);assert.equal(syncStreamStates([attempt],Date.now(),['meta_ads'])[0].state,'due','release is immediately resumable');
});

test('page acknowledgements replay once; stale/out of order, duplicates, scope changes and cursor loops roll back',async()=>{
 const c=await claim('222','2026-09-01','2026-09-02');const records=[row('222','2026-09-01')];
 await stage(c,0,0,records,'cursor-one');await stage(c,0,0,records,'cursor-one');assert.equal((await one('SELECT rows_read FROM sync_runs WHERE id=$1',[c.runId])).rows_read,1);
 await assert.rejects(stage(c,0,0,[row('222','2026-09-01','44')],'different'),{code:'55000'});
 await assert.rejects(stage(c,0,1,[row('333','2026-09-01','44')],null,'cursor-one'),{code:'23514'});
 await assert.rejects(stage(c,0,1,[row('222','2026-09-02','44')],null,'cursor-one'),{code:'23514'});
 await assert.rejects(stage(c,0,1,[row('222','2026-09-01','44'),row('222','2026-09-01','44')],null,'cursor-one'),{code:'23514'});
 await assert.rejects(stage(c,0,1,records,null,'cursor-one'),{code:'23514'});
 await assert.rejects(stage(c,0,1,[],'cursor-one','cursor-one'),{code:'23514'});
 assert.equal((await one('SELECT rows_read FROM sync_runs WHERE id=$1',[c.runId])).rows_read,1);
 await stage(c,0,1,[row('222','2026-09-01','44')],null,'cursor-one');await rpc('cockpit_publish_meta_ads',{p_run:c.runId,p_lease:c.lease});assert.equal((await published('222')).length,2);
});

test('the reader resumes the saved partition/cursor and does not expose a partial or fabricate empty history',async()=>{
 const requests:{range:{since:string;until:string};cursor:string|null}[]=[];
 let remaining=40_000;
 const fetcher:typeof fetch=async(input)=>{
  const url=new URL(String(input));if(!url.pathname.endsWith('/insights'))return Response.json({account_id:'333',currency:'EUR',timezone_name:'Europe/Paris'});
  assert.equal(url.searchParams.get('fields'),'account_id,ad_id,ad_name,adset_id,campaign_id,campaign_name,date_start,date_stop,spend,impressions,outbound_clicks');assert.equal(url.searchParams.get('level'),'ad');assert.equal(url.searchParams.get('time_increment'),'1');assert.equal(url.searchParams.get('action_attribution_windows'),null);
  const range=JSON.parse(url.searchParams.get('time_range')!),cursor=url.searchParams.get('after');requests.push({range,cursor});remaining=0;
  const raw={account_id:'333',ad_id:cursor?'43':'42',date_start:range.since,date_stop:range.since,spend:'1.00',impressions:'10'};
  return Response.json({data:[raw],...(cursor?{}:{paging:{next:'https://graph.facebook.com/private-token-never-followed',cursors:{after:'cursor-one'}}})});
 };
 const env:NodeJS.ProcessEnv={NODE_ENV:'test',META_AD_ACCOUNT_ID:'333',META_ACCESS_TOKEN:'synthetic-private-token'};
 const opts={db,env,fetcher,budget:{remainingWorkMs:()=>remaining,remainingTotalMs:()=>45000}};
 const first=await synchronizeMetaAdsResumable('2026-09-01','2026-09-02',true,opts);assert.equal(first.status,'pending');assert.equal(first.coverage.complete,false);assert.equal((await published('333')).length,0);
 remaining=40000;const next=await synchronizeMetaAdsResumable('2026-09-02','2026-09-03',true,opts);assert.equal(next.status,'complete');assert.equal(next.coverage.from,'2026-09-01');assert.equal(next.coverage.to,'2026-09-02');
 assert.deepEqual(requests.map(r=>r.cursor),[null,'cursor-one']);assert.deepEqual(requests.map(r=>r.range),[{since:'2026-09-01',until:'2026-09-01'},{since:'2026-09-01',until:'2026-09-01'}]);assert.equal((await published('333')).length,2);
 assert.equal(JSON.stringify(next).includes('private-token'),false);
});

test('missing stage acknowledgement retains committed work and lease; takeover after expiry resumes without the received page',async()=>{
 let remaining=40000,ackLost=true,reads=0;
 const dbLost:Database={...db,rpc:async<T>(name:string,args:Row)=>{const result=await rpc<T>(name,args);if(name==='cockpit_stage_meta_ads'&&ackLost){ackLost=false;throw Error('synthetic lost acknowledgement');}return result;}};
 const fetcher:typeof fetch=async input=>{
  const url=new URL(String(input));if(!url.pathname.endsWith('/insights'))return Response.json({account_id:'444',currency:'EUR',timezone_name:'Europe/Paris'});
  reads++;remaining=0;return Response.json({data:[]});
 };
 const opts={db:dbLost,env:{NODE_ENV:'test' as const,META_AD_ACCOUNT_ID:'444',META_ACCESS_TOKEN:'synthetic'},fetcher,budget:{remainingWorkMs:()=>remaining,remainingTotalMs:()=>45000}};
 const first=await synchronizeMetaAdsResumable('2026-09-01','2026-09-10',true,opts);assert.equal(first.status,'failed');
 const c=await one('SELECT id AS "runId",lease_token AS lease,checkpoint FROM sync_runs WHERE id=$1',[first.runId]) as C;assert.equal(c.checkpoint.index,1);
 assert.equal((await claim('444','2026-09-01','2026-09-10')).busy,true);
 await age(c);remaining=40000;const next=await synchronizeMetaAdsResumable('2026-09-01','2026-09-10',true,opts);assert.equal(next.status,'empty');assert.equal(reads,2);assert.equal((await published('444')).length,0);
});

test('transient source failure retains progress; access/scope failure stays terminal, and grants remain private',async()=>{
 const c=await claim('555');await stage(c,0,0,[]);await release(c,'UPSTREAM_HTTP_ERROR');await age(c);
 const next=await claim('555');assert.equal(next.runId,c.runId);assert.equal(next.checkpoint.index,1);await release(next,'ACCESS_DENIED');assert.equal((await one('SELECT status FROM sync_runs WHERE id=$1',[c.runId])).status,'failed');
 await sql.query(fs.readFileSync('supabase/migrations/028_meta_ads_persistent_pages.sql','utf8'));
 for(const signature of ['cockpit_claim_meta_ads(text,text,date,date,boolean)','cockpit_stage_meta_ads(uuid,uuid,integer,integer,text,jsonb,text,boolean,jsonb)','cockpit_release_meta_ads(uuid,uuid,text)','cockpit_publish_meta_ads(uuid,uuid)']){
  assert.equal((await one("SELECT has_function_privilege('anon',$1,'execute') AS allowed",[signature])).allowed,false);
  assert.equal((await one("SELECT has_function_privilege('service_role',$1,'execute') AS allowed",[signature])).allowed,true);
 }
});

test('invalid rows cannot checkpoint a page even when its database acknowledgement could be lost',async()=>{
 let stageCalls=0;
 const dbCount:Database={...db,rpc:async<T>(name:string,args:Row)=>{if(name==='cockpit_stage_meta_ads')stageCalls++;return rpc<T>(name,args);}};
 const fetcher:typeof fetch=async input=>{
  const url=new URL(String(input));if(!url.pathname.endsWith('/insights'))return Response.json({account_id:'666',currency:'EUR',timezone_name:'Europe/Paris'});
  return Response.json({data:[{account_id:'666',ad_id:'42',date_start:'2026-09-01',date_stop:'2026-09-01',spend:'1.00'}, {account_id:'other',ad_id:'43',date_start:'2026-09-01',date_stop:'2026-09-01',spend:'1.00'}]});
 };
 const result=await synchronizeMetaAdsResumable('2026-09-01','2026-09-02',true,{db:dbCount,env:{NODE_ENV:'test',META_AD_ACCOUNT_ID:'666',META_ACCESS_TOKEN:'synthetic'},fetcher});
 assert.equal(result.status,'failed');assert.equal('safeError' in result?result.safeError:undefined,'INVALID_META_ROW');assert.equal(stageCalls,0);
 const run=await one('SELECT status,checkpoint FROM sync_runs WHERE id=$1',[result.runId]);assert.equal(run.status,'failed');assert.equal(run.checkpoint.totalPages,0);assert.equal((await published('666')).length,0);
});

test('caller cancellation keeps saved work; an expired lease cannot stage and owner replacement cannot publish a partial',async()=>{
 const c=await claim('777','2026-09-01','2026-09-10');await stage(c,0,0,[row('777','2026-09-01')]);await release(c);
 const controller=new AbortController();controller.abort();let calls=0;
 const result=await synchronizeMetaAdsResumable('2026-09-01','2026-09-10',true,{db,env:{NODE_ENV:'test',META_AD_ACCOUNT_ID:'777',META_ACCESS_TOKEN:'synthetic'},signal:controller.signal,fetcher:async()=>{calls++;throw Error('cancelled caller cannot fetch');}});
 assert.equal(result.status,'pending');assert.equal(calls,0);assert.equal((await one('SELECT checkpoint FROM sync_runs WHERE id=$1',[c.runId])).checkpoint.index,1);
 const held=await claim('777','2026-09-01','2026-09-10');await age(held);
 await assert.rejects(stage(held,1,0,[]),{code:'55000'});
 const next=await claim('777','2026-09-01','2026-09-10');assert.notEqual(next.lease,held.lease);
 await assert.rejects(stage(held,1,0,[]),{code:'55000'});await assert.rejects(rpc('cockpit_publish_meta_ads',{p_run:next.runId,p_lease:next.lease}),{code:'55000'});
 await stage(next,1,0,[]);await rpc('cockpit_publish_meta_ads',{p_run:next.runId,p_lease:next.lease});assert.equal((await published('777')).length,1);
});

test('real database adapter and synchronizeMetaAds wrapper use the resumable RPCs and freeze explicit scope',async()=>{
 const real=postgresDatabase(target.href);assert.equal(real.metaAdsPersistentPages,true);
 let remaining=40000,insights=0;
 const fetcher:typeof fetch=async input=>{
  const url=new URL(String(input));if(!url.pathname.endsWith('/insights'))return Response.json({account_id:'888',currency:'EUR',timezone_name:'Europe/Paris'});
  insights++;remaining=0;return Response.json({data:[]});
 };
 const opts={db:real,env:{NODE_ENV:'test' as const,COCKPIT_MODE:'live',META_AD_ACCOUNT_ID:'888',META_ACCESS_TOKEN:'synthetic'},fetcher,budget:{remainingWorkMs:()=>remaining,remainingTotalMs:()=>45000}};
 const first=await synchronizeMetaAds('2026-09-01','2026-09-10',opts);assert.equal(first.status,'pending');assert.equal(insights,1);
 remaining=40000;const changed=await synchronizeMetaAds('2026-09-02','2026-09-11',opts);assert.equal(changed.status,'waiting');assert.equal(insights,1,'explicit changed scope cannot mix windows');
 const next=await synchronizeMetaAds('2026-09-01','2026-09-10',opts);assert.equal(next.status,'empty');assert.equal(insights,2);assert.equal((await one('SELECT status,pagination_complete FROM sync_runs WHERE id=$1',[next.runId])).pagination_complete,true);
});

test('an unreviewed HTTP400 remains terminal and does not become a retryable stored checkpoint',async()=>{
 let insights=0;
 const fetcher:typeof fetch=async input=>{
  const url=new URL(String(input));if(!url.pathname.endsWith('/insights'))return Response.json({account_id:'999',currency:'EUR',timezone_name:'Europe/Paris'});
  insights++;return Response.json({error:{code:100,message:'synthetic-private-message',fbtrace_id:'synthetic-private-trace'}},{status:400});
 };
 const result=await synchronizeMetaAdsResumable('2026-09-01','2026-09-02',true,{db,env:{NODE_ENV:'test',META_AD_ACCOUNT_ID:'999',META_ACCESS_TOKEN:'synthetic-private-token'},fetcher});
 assert.equal(result.status,'failed');assert.equal(insights,1);assert.equal((await one('SELECT status,rows_read FROM sync_runs WHERE id=$1',[result.runId])).status,'failed');assert.equal(JSON.stringify(result).includes('synthetic-private'),false);
});

test('partition overhead does not reduce the existing2000-row capacity',async()=>{
 const c=await claim('1200','2026-07-01','2026-10-02');
 const parts=c.checkpoint.partitions as {from:string;to:string}[];assert.equal(parts.length,14);
 for(let i=0;i<parts.length;i++){
  await stage(c,i,0,Array.from({length:100},(_,j)=>row('1200',parts[i].from,String(i*1000+j+1))),`cursor-${i}`);
  await stage(c,i,1,[row('1200',parts[i].from,String(i*1000+101))],null,`cursor-${i}`);
 }
 const done=await one('SELECT checkpoint,rows_read FROM sync_runs WHERE id=$1',[c.runId]);assert.equal(done.checkpoint.totalPages,28);assert.equal(done.rows_read,1414);
 await rpc('cockpit_publish_meta_ads',{p_run:c.runId,p_lease:c.lease});assert.equal((await published('1200')).length,1414);
});

test('even empty pages freeze account currency/timezone before the next partition',async()=>{
 let accounts=0,insights=0;
 const fetcher:typeof fetch=async input=>{
  const url=new URL(String(input));if(!url.pathname.endsWith('/insights'))return Response.json({account_id:'1201',currency:'EUR',timezone_name:++accounts===1?'Europe/Paris':'Europe/London'});
  insights++;return Response.json({data:[]});
 };
 const result=await synchronizeMetaAdsResumable('2026-09-01','2026-09-10',true,{db,env:{NODE_ENV:'test',META_AD_ACCOUNT_ID:'1201',META_ACCESS_TOKEN:'synthetic'},fetcher});
 assert.equal(result.status,'failed');assert.equal(insights,1,'changed account refused before next data query');
 const saved=await one('SELECT checkpoint,status FROM sync_runs WHERE id=$1',[result.runId]);assert.deepEqual(saved.checkpoint.account,{accountId:'1201',currency:'EUR',timezone:'Europe/Paris'});assert.equal(saved.checkpoint.index,1);assert.equal(saved.status,'failed');
});

test('an inactive legacy worker expires at10minutes, while an active legacy lease remains protected',async()=>{
 const old=String((await one("SELECT begin_sync_stream('meta','1202','2026-09-01','2026-09-10','v23.0-ad-day-none','aggregate_period','ad_daily','2026-09-01','2026-09-10') AS id")).id);
 await sql.query("UPDATE sync_runs SET started_at=clock_timestamp()-interval '3 hours',lease_until=NULL WHERE id=$1",[old]);
 const replacement=await claim('1202','2026-09-01','2026-09-10');assert.equal(replacement.busy,false);assert.notEqual(replacement.runId,old);assert.equal((await one('SELECT error_code FROM sync_runs WHERE id=$1',[old])).error_code,'expired_worker');
 const held=String((await one("SELECT begin_sync_stream('meta','1203','2026-09-01','2026-09-10','v23.0-ad-day-none','aggregate_period','ad_daily','2026-09-01','2026-09-10') AS id")).id);
 await sql.query("UPDATE sync_runs SET started_at=clock_timestamp()-interval '3 hours',lease_until=clock_timestamp()+interval '30 seconds' WHERE id=$1",[held]);
 const busy=await claim('1203','2026-09-01','2026-09-10');assert.equal(busy.busy,true);assert.equal(busy.runId,held);assert.equal((await one('SELECT status FROM sync_runs WHERE id=$1',[held])).status,'running');
});
