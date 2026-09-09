import test from 'node:test';
import assert from 'node:assert/strict';
import {emailIdentity} from '../src/domain/identity';
import {normalizeWixLeadEntry,readWixLeadEntryPage,wixLeadEntryConfig,type WixLeadEntryConfig} from '../src/connectors/wix-lead-entries';
import {normalizeNotionClientHistory} from '../src/connectors/notion-client-history';
import {synchronizeLeadEntries} from '../src/lib/sync-lead-entries';
import {readLeadDefinitions} from '../src/lib/lead-entry-dashboard';
import type {Database} from '../src/lib/db';
const secret='synthetic-identity-secret-not-a-live-credential';
const config:WixLeadEntryConfig={formNamespace:'wix.form_app.form',formIds:['form-a'],ignoredFormIds:['form-test'],formEmailField:'email',quiz:{collectionId:'quiz-entries',emailField:'email',statusField:'status',completedStatus:'completed',originFields:{source:'source',pagePath:'page'}}};
const form=(extra:Record<string,unknown>={})=>({id:'entry-one',formId:'form-a',namespace:'wix.form_app.form',createdDate:'2026-05-30T15:00:00Z',updatedDate:'2026-08-01T12:00:00Z',status:'CONFIRMED',contactId:'contact-a',submissions:{email:' Person@Example.org ',privateAnswer:'not retained'},...extra});
test('source timestamp and common HMAC are preserved locally; no private answers or emails emitted',()=>{
 const r=normalizeWixLeadEntry(form(),'forms',config,'site',secret)!;
 assert.equal(r.identityKey,emailIdentity('person@example.org',secret));assert.equal(r.occurredAt,'2026-05-30T15:00:00Z');
 assert.equal(r.eligible,true);assert.equal(JSON.stringify(r).includes('Example.org'),false);assert.equal(JSON.stringify(r).includes('not retained'),false);
});
test('missing/invalid email retains dated request and legitimate plus aliases remain different identities',()=>{
 const noEmail=normalizeWixLeadEntry(form({submissions:{}}),'forms',config,'site',secret)!;assert.equal(noEmail.identityKey,null);assert.equal(noEmail.eligible,true);
 const invalid=normalizeWixLeadEntry(form({submissions:{email:'invalid'}}),'forms',config,'site',secret)!;assert.equal(invalid.properties.identityBasis,'email_invalid');
 assert.notEqual(normalizeWixLeadEntry(form({submissions:{email:'person+followup@example.org'}}),'forms',config,'site',secret)!.identityKey,emailIdentity('person@example.org',secret));
});
test('only explicitly configured test forms are excluded; unknown form fails rather than implying complete zero',()=>{
 assert.equal(normalizeWixLeadEntry(form({formId:'form-test'}),'forms',config,'site',secret),null);
 assert.throws(()=>normalizeWixLeadEntry(form({formId:'new-form'}),'forms',config,'site',secret),/UNCONFIGURED_SOURCE_FORM/);
 assert.equal(normalizeWixLeadEntry(form({submissions:{email:'test+real@example.org'}}),'forms',config,'site',secret)!.eligible,true);
});
test('repeat submission IDs are distinct and changed source timestamp alone keeps content digest',()=>{
 const first=normalizeWixLeadEntry(form(),'forms',config,'site',secret)!;
 const same=normalizeWixLeadEntry(form({updatedDate:'2026-08-02T12:00:00Z'}),'forms',config,'site',secret)!;assert.equal(first.payloadHash,same.payloadHash);
 const repeat=normalizeWixLeadEntry(form({id:'entry-two',createdDate:'2026-08-02T12:00:00Z'}),'forms',config,'site',secret)!;assert.notEqual(first.externalId,repeat.externalId);assert.equal(first.identityKey,repeat.identityKey);
});
test('quiz projection keeps origin without URL query or private values and uses exact CMS timestamps',()=>{
 const r=normalizeWixLeadEntry({id:'quiz-one',data:{_id:'quiz-one',email:'person@example.org',_createdDate:{$date:'2026-08-30T16:11:04.883Z'},_updatedDate:{$date:'2026-08-30T16:15:00Z'},status:'completed',source:'ig',page:'https://example.org/quiz?email=private',privateAnswer:'never'}},'quiz',config,'site',secret)!;
 assert.equal(r.occurredAt,'2026-08-30T16:11:04.883Z');assert.deepEqual(r.properties.origin,{source:'ig',pagePath:'https://example.org/quiz'});assert.equal(JSON.stringify(r).includes('private'),false);
});
test('Forms page sends site header and supported update filter; cursor continuation is bounded',async()=>{
 const requests:{url:string;body:any;headers:any}[]=[];
 const fetcher=(async(url,init)=>{requests.push({url:String(url),body:JSON.parse(String(init?.body)),headers:init?.headers});return Response.json({submissions:[form()],metadata:{count:1,hasNext:false,cursors:{}}});}) as typeof fetch;
 const args={family:'forms' as const,config,siteId:'site',apiKey:'synthetic',identitySecret:secret,from:'2026-08-01T00:00:00Z',to:'2026-09-01T00:00:00Z',fetcher};
 const page=await readWixLeadEntryPage(args);assert.equal(page.done,true);assert.equal(page.read,1);assert.equal(requests[0].headers['wix-site-id'],'site');assert.ok(requests[0].body.query.filter.$and.some((x:any)=>x.updatedDate?.$gte));
 await readWixLeadEntryPage({...args,cursor:'opaque'});assert.deepEqual(requests[1].body.query,{cursorPaging:{limit:100,cursor:'opaque'}});
});
test('source page rejects duplicates and missing terminal evidence',async()=>{
 const args={family:'forms' as const,config,siteId:'site',apiKey:'synthetic',identitySecret:secret,from:'2026-08-01T00:00:00Z',to:'2026-09-01T00:00:00Z'};
 await assert.rejects(()=>readWixLeadEntryPage({...args,fetcher:(async()=>Response.json({submissions:[form(),form()],metadata:{count:2,hasNext:false}})) as typeof fetch}),/DUPLICATE_SOURCE_IDS/);
 await assert.rejects(()=>readWixLeadEntryPage({...args,fetcher:(async()=>Response.json({submissions:[],metadata:{count:0}})) as typeof fetch}),/INVALID_SOURCE_PAGINATION/);
});
test('client program date is stored as prior-existence evidence, including date-only Paris semantics',()=>{
 const c={dataSourceId:'clients',prospectNamespace:'crm',emailField:'E-mail',emailBisField:'E-mail BIS',startedField:'Started',prospectField:'Prospect'};
 const r=normalizeNotionClientHistory({id:'client-one',last_edited_time:'2026-08-01T00:00:00Z',archived:false,properties:{'E-mail':{email:'person@example.org'},Started:{date:{start:'2024-01-01'}},Prospect:{relation:[{id:'prospect-one'}],has_more:false}}},c,secret);
 assert.equal(r.occurredAt,'2023-12-31T23:00:00Z');assert.equal(r.properties.dateBasis,'client_program_started_bound');assert.equal(r.identityKey,emailIdentity('person@example.org',secret));
});
test('worker resumes existing checkpoint and only publishes after terminal page',async()=>{
 const calls:string[]=[];const db={rpc:async(name:string,args:any)=>{calls.push(name);if(name==='cockpit_claim_lead_entries')return {busy:false,runId:'run',lease:'lease',rowsRead:100,checkpoint:{version:1,from:'2026-01-01T00:00:00Z',to:'2026-09-01T00:00:00Z',page:1,cursor:'next',done:false}};if(name==='cockpit_stage_lead_entries'){assert.equal(args.p_page,1);return {read:101};}if(name==='cockpit_publish_lead_entries')return {status:'complete',counts:{read:101,observations:101,changed:1,unchanged:100,rejected:0,stale:0,ignored:0}};}} as unknown as Database;
 const r=await synchronizeLeadEntries('forms',{db,env:{COCKPIT_MODE:'live',WIX_SITE_ID:'site',WIX_API_KEY:'synthetic',IDENTITY_HMAC_SECRET:secret,WIX_LEAD_ENTRY_CONFIG:JSON.stringify(config)},reader:async x=>{assert.equal(x.cursor,'next');return {records:[normalizeWixLeadEntry(form(),'forms',config,'site',secret)!],read:1,ignored:0,cursor:null,done:true};}});
 assert.equal(r.status,'complete');assert.deepEqual(calls,['cockpit_claim_lead_entries','cockpit_stage_lead_entries','cockpit_publish_lead_entries']);
});
test('unconfigured family is unavailable without issuing database/source calls',async()=>{
 let called=false;const db={rpc:async()=>{called=true;}} as unknown as Database;
 await assert.rejects(()=>synchronizeLeadEntries('forms',{db,env:{IDENTITY_HMAC_SECRET:secret}}),/pas configurée/);assert.equal(called,false);
 assert.equal(wixLeadEntryConfig(undefined),null);
 assert.equal(await readLeadDefinitions(db,{from:'2026-01-01',to:'2026-08-31',source:'all',tunnel:'all',campaign:'all',compare:false},'2026-09-01',{}),null);
});
