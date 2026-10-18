import test from 'node:test';
import assert from 'node:assert/strict';
import { Temporal } from '@js-temporal/polyfill';
import { readRefreshState } from '../src/lib/refresh-state';
import { ALL_REFRESH_JOBS, configuredJobScope, syncJobRunFilter, type SyncJob } from '../src/lib/sync-jobs';
import type { Database, Row } from '../src/lib/db';
import { COOKIE_NAME, issueSession, passwordHash } from '../src/lib/auth';
import { getConfig } from '../src/lib/config';
const now=Date.parse('2026-10-06T08:15:00Z'), at=(n:number)=>new Date(now-n*60000).toISOString();
const env:NodeJS.ProcessEnv={NODE_ENV:'test',COCKPIT_MODE:'live',BLG_REFRESH_CADENCE_MINUTES:'30',NOTION_TOKEN:'synthetic',NOTION_DATA_SOURCE_ID:'prospects',NOTION_CLIENT_DATA_SOURCE_ID:'clients',NOTION_COMMERCE_CONFIG:JSON.stringify({clients:{dataSourceId:'c'},payments:{dataSourceId:'p'},schedule:{dataSourceId:'s'},parcours:{dataSourceId:'r'}}),WIX_SITE_ID:'wix',WIX_API_KEY:'synthetic',WIX_LEAD_ENTRY_CONFIG:JSON.stringify({formIds:['f'],quiz:{collectionId:'q'}}),IDENTITY_HMAC_SECRET:'synthetic'.repeat(5),META_AD_ACCOUNT_ID:'meta',META_ACCESS_TOKEN:'synthetic',POSTHOG_PROJECT_ID:'1',POSTHOG_PERSONAL_API_KEY:'synthetic'};
function row(job:SyncJob,clock=now):Row {
 const scope=configuredJobScope(job,env)!;
 const date=Temporal.Instant.fromEpochMilliseconds(clock).toZonedDateTimeISO('Europe/Paris').toPlainDate(),bound=(d:Temporal.PlainDate)=>d.toZonedDateTime('Europe/Paris').toInstant().toString();
 const delta=['notion','forms','quiz_entries','client_history','commerce','meta_catalog'].includes(job);
 const start=new Date(clock-5*60000).toISOString(),end=new Date(clock-2*60000).toISOString();
 const from=delta?'1970-01-01T00:00:00Z':bound(['masterclass','quiz','wix','receipts'].includes(job)?date.with({day:1}).subtract({months:1}):date.subtract({days:35}));
 const to=delta?start:bound(date.add({days:1}));
 return {id:'private-row-'+job,...syncJobRunFilter(job,scope),status:'complete',pagination_complete:true,rows_rejected:0,error_code:null,started_at:start,finished_at:end,source_as_of:start,period_from:from,period_to:to,covered_from:from,covered_to:to};
}
const store=(rows:Row[]):Database=>({select:async(_table,o={})=>rows.filter(r=>Object.entries(o.eq??{}).every(([k,v])=>String(r[k])===v)&&Object.entries(o.in??{}).every(([k,v])=>v.includes(String(r[k])))).sort((a,b)=>String(b[o.order??'id']).localeCompare(String(a[o.order??'id']))).slice(0,o.limit??1000),rpc:async()=>assert.fail('status is read only'),upsert:async()=>assert.fail('status is read only'),probe:async()=>{}});
test('all current sources are fresh, revision opaque and stable; publication changes it',async()=>{
 const rows=ALL_REFRESH_JOBS.map(j=>row(j));
 const first=await readRefreshState(store(rows),env,now);
 assert.equal(first.stale,false);assert.equal(first.pending,false);assert.match(first.publicationId!,/^[a-f0-9]{64}$/);
 assert.deepEqual(await readRefreshState(store(rows),env,now+1000),first);
 assert.ok(!JSON.stringify(first).includes('private-row'));
 rows.find(r=>r.stream_key==='payments_analytics')!.id='new-publication';
 assert.notEqual((await readRefreshState(store(rows),env,now)).publicationId,first.publicationId);
});
test('financial missing publication, failure, and explicit pause cannot be fresh',async()=>{
 const rows=ALL_REFRESH_JOBS.map(j=>row(j));
 assert.equal((await readRefreshState(store(rows.filter(r=>r.stream_key!=='commerce_declared_snapshot')),env,now)).stale,true);
 assert.equal((await readRefreshState(store(rows),{...env,BLG_COMMERCE_READER:'paused'},now)).stale,true);
 rows.push({...row('wix'),id:'failed',started_at:at(1),finished_at:at(1),status:'failed',pagination_complete:false,error_code:'WIX_IMPORT_FAILED'});
 assert.equal((await readRefreshState(store(rows),env,now)).stale,true);
});
test('checkpoint work is pending, never a new publication; expired lease is retryable',async()=>{
 const rows=ALL_REFRESH_JOBS.map(j=>row(j)),first=await readRefreshState(store(rows),env,now);
 rows.push({...row('commerce'),id:'checkpoint',stream_key:'commerce_reader_checkpoint',status:'running',pagination_complete:false,started_at:at(1),finished_at:null,lease_until:at(-1)});
 const active=await readRefreshState(store(rows),env,now);assert.equal(active.pending,true);assert.equal(active.stale,true);assert.equal(active.publicationId,first.publicationId);
 rows.at(-1)!.lease_until=at(1);assert.equal((await readRefreshState(store(rows),env,now)).pending,false);
});
test('opening refresh API keeps authentication and origin checks; GET never invokes collector',async()=>{
 const previous={...process.env},fetcher=globalThis.fetch;
 Object.assign(process.env,env,{APP_ORIGIN:'http://127.0.0.1:3199',COCKPIT_PASSWORD_HASH:passwordHash('synthetic-password-only'),COCKPIT_SESSION_SECRET:'synthetic'.repeat(6),SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SECRET_KEY:'synthetic'});
 delete process.env.BLG_COMMERCE_READER;
 let calls=0;
 globalThis.fetch=async(input)=>{const u=new URL(String(input));assert.equal(u.hostname,'synthetic.supabase.co');assert.ok(u.pathname.endsWith('/sync_runs'));calls++;return Response.json([]);};
 try{
  const {GET,POST}=await import('../src/app/api/[...path]/route'),config=getConfig(),url=config.origin+'/api/refresh';
  assert.equal((await GET(new Request(url))).status,401);assert.equal(calls,0);
  const headers={Cookie:`${COOKIE_NAME}=${issueSession(config)}`};
  assert.equal((await POST(new Request(url,{method:'POST',headers:{...headers,Origin:'https://outside.example'}}))).status,403);assert.equal(calls,0);
  const response=await GET(new Request(url,{headers}));assert.equal(response.status,200);assert.deepEqual(await response.json(),{publicationId:null,pending:false,stale:true});assert.equal(calls,31);
 }finally{globalThis.fetch=fetcher;for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);}
});
