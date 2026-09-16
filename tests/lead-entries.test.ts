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
 assert.deepEqual(requests[0].body.query.filter.$and.find((x:any)=>x.formId),{formId:{$in:['form-a']}},'Only configured forms may be fetched; unrelated CRM submissions must stay outside the request');
 await readWixLeadEntryPage({...args,cursor:'opaque'});assert.deepEqual(requests[1].body.query,{cursorPaging:{limit:100,cursor:'opaque'}});
});
const quizItem=(id:string)=>({id,data:{_id:id,email:'person@example.org',_createdDate:{$date:'2026-08-30T16:11:04.883Z'},_updatedDate:{$date:'2026-08-30T16:15:00Z'},status:'completed',source:'ig',page:'https://example.org/quiz'}});
test('CMS quiz continues from count and offset when the first page is short, until total is reached',async()=>{
 const requests:any[]=[];
 const pages=[
  {dataItems:[quizItem('quiz-one')],pagingMetadata:{count:1,offset:0,total:2,tooManyToCount:false}},
  {dataItems:[quizItem('quiz-two')],pagingMetadata:{count:1,offset:1,total:2,tooManyToCount:false}}
 ];
 const fetcher=(async(_url,init)=>{requests.push(JSON.parse(String(init?.body)));return Response.json(pages.shift());}) as typeof fetch;
 const args={family:'quiz' as const,config,siteId:'site',apiKey:'synthetic',identitySecret:secret,from:'2026-08-01T00:00:00Z',to:'2026-09-01T00:00:00Z',fetcher};
 const first=await readWixLeadEntryPage(args);assert.equal(first.done,false);assert.equal(first.cursor,'1');assert.equal(first.read,1);
 const second=await readWixLeadEntryPage({...args,cursor:first.cursor});assert.equal(second.done,true);assert.equal(second.cursor,null);assert.equal(second.read,1);
 assert.deepEqual(requests.map(r=>r.query.paging.offset),[0,1]);assert.equal(requests[0].returnTotalCount,true);
});
test('CMS quiz accepts an empty terminal page with an exact total and omitted or false tooManyToCount',async()=>{
 for(const pagingMetadata of [
  {count:0,offset:0,total:0,tooManyToCount:false},
  {count:0,offset:0,total:0}
 ]){
  const fetcher=(async()=>Response.json({dataItems:[],pagingMetadata})) as typeof fetch;
  const page=await readWixLeadEntryPage({family:'quiz',config,siteId:'site',apiKey:'synthetic',identitySecret:secret,from:'2026-08-01T00:00:00Z',to:'2026-09-01T00:00:00Z',fetcher});
  assert.equal(page.done,true);assert.equal(page.cursor,null);assert.equal(page.read,0);
 }
});
test('CMS quiz refuses missing/approximate totals, invalid tooManyToCount, a response offset mismatch and an inconsistent count',async()=>{
 const args={family:'quiz' as const,config,siteId:'site',apiKey:'synthetic',identitySecret:secret,from:'2026-08-01T00:00:00Z',to:'2026-09-01T00:00:00Z'};
 for(const pagingMetadata of [
  {count:0,offset:0,tooManyToCount:false},
  {count:0,offset:0,total:0,tooManyToCount:true},
  {count:0,offset:0,total:0,tooManyToCount:null},
  {count:0,offset:0,total:0,tooManyToCount:'false'},
  {count:0,offset:0,total:0,tooManyToCount:0},
  {count:0,offset:1,total:0,tooManyToCount:false},
  {count:1,offset:0,total:1,tooManyToCount:false}
 ])await assert.rejects(()=>readWixLeadEntryPage({...args,fetcher:(async()=>Response.json({dataItems:[],pagingMetadata})) as typeof fetch}),/INVALID_SOURCE_PAGINATION/);
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

// --- Origine commune aux deux tunnels (15-09-2026) ---
const originConfig:WixLeadEntryConfig={...config,formOriginFields:{visitor:'blg_visiteur',first:'blg_origine',current:'blg_arrivee',session:'blg_session'},quiz:{...config.quiz!,originFields:{source:'source',medium:'support',campaign:'campagne',ad:'publicite',adset:'motCle',linkId:'lienId',pagePath:'pageArrivee',visitor:'visiteur'},firstTouchFields:{source:'premiereSource',medium:'premiereSupport',campaign:'premiereCampagne',ad:'premierePublicite',adset:'premiereMotCle',linkId:'premiereLienId',page:'premierePage',at:'premiereLe',tunnel:'premiereTunnel'}}};
const LINK='11111111-1111-4111-8111-111111111111',VID='22222222-2222-4222-8222-222222222222';
test('quiz : A (première origine) et B (arrivée) restent distinctes, adset et lien lus, visiteur UUID, paramètres d’arrivée extraits sans valeur personnelle',()=>{
 const r=normalizeWixLeadEntry({id:'quiz-a',data:{_id:'quiz-a',email:'person@example.org',_createdDate:{$date:'2026-09-15T10:00:00Z'},_updatedDate:{$date:'2026-09-15T10:00:00Z'},status:'completed',source:'fb',support:'paid',campagne:'120200000000000002',publicite:'120200000000000012',motCle:'120200000000000022',lienId:LINK,visiteur:VID.toUpperCase(),pageArrivee:'https://quizz.blg-studio.fr/?utm_source=fb&utm_content=120200000000000012&blg_link_id='+LINK+'&fbclid=abc&email=private%40example.org',premiereSource:'fb',premiereSupport:'paid',premiereCampagne:'120200000000000001',premierePublicite:'120200000000000011',premiereMotCle:'120200000000000021',premiereLienId:'not-a-uuid',premierePage:'https://quizz.blg-studio.fr/',premiereLe:'2026-09-14T09:00:00.000Z',premiereTunnel:'quiz'}},'quiz',originConfig,'site',secret)!;
 assert.equal((r.properties.origin as Record<string,unknown>).ad,'120200000000000012');
 assert.equal((r.properties.origin as Record<string,unknown>).adset,'120200000000000022');
 assert.equal((r.properties.origin as Record<string,unknown>).linkId,LINK);
 assert.equal((r.properties.origin as Record<string,unknown>).visitor,VID);
 assert.equal((r.properties.origin as Record<string,unknown>).pagePath,'https://quizz.blg-studio.fr/');
 assert.equal((r.properties.origin as Record<string,unknown>).fbclid,true);
 assert.equal((r.properties.firstTouch as Record<string,unknown>).ad,'120200000000000011');
 assert.equal((r.properties.firstTouch as Record<string,unknown>).linkId,undefined,'lien invalide ignoré');
 assert.equal((r.properties.firstTouch as Record<string,unknown>).tunnel,'quiz');
 assert.equal(JSON.stringify(r).includes('private'),false);
});
test('quiz historique sans colonnes nouvelles : origine lue dans l’URL d’arrivée, aucune première origine inventée',()=>{
 const r=normalizeWixLeadEntry({id:'quiz-old',data:{_id:'quiz-old',email:'person@example.org',_createdDate:{$date:'2026-08-20T10:00:00Z'},_updatedDate:{$date:'2026-08-20T10:00:00Z'},status:'completed',pageArrivee:'https://quizz.blg-studio.fr/?utm_source=fb&utm_campaign=120200000000000001&utm_content=120200000000000011'}},'quiz',originConfig,'site',secret)!;
 assert.equal((r.properties.origin as Record<string,unknown>).ad,'120200000000000011');
 assert.equal((r.properties.origin as Record<string,unknown>).campaign,'120200000000000001');
 assert.equal(r.properties.firstTouch,null);
 const direct=normalizeWixLeadEntry({id:'quiz-direct',data:{_id:'quiz-direct',email:'person@example.org',_createdDate:{$date:'2026-08-21T10:00:00Z'},_updatedDate:{$date:'2026-08-21T10:00:00Z'},status:'completed',pageArrivee:'https://quizz.blg-studio.fr/'}},'quiz',originConfig,'site',secret)!;
 assert.ok(!(direct.properties.origin as Record<string,unknown>).ad,'arrivée directe : aucune publicité');
 assert.equal(direct.properties.firstTouch,null);
});
test('masterclass : champs cachés lus (A, arrivée, visiteur, session) ; anciennes soumissions sans champs et JSON invalide ou personnel ignorés',()=>{
 const withFields=normalizeWixLeadEntry(form({submissions:{email:'person@example.org',blg_visiteur:VID,blg_origine:JSON.stringify({utm_source:'fb',utm_campaign:'120200000000000001',utm_content:'120200000000000011',link_id:LINK,at:'2026-09-14T09:00:00.000Z',page:'https://quizz.blg-studio.fr/',tunnel:'quiz',email:'leak@example.org'}),blg_arrivee:JSON.stringify({utm_source:'fb',utm_campaign:'120200000000000002',utm_content:'120200000000000012',ad_id:'ignored-when-utm-present'}),blg_session:'mc-abc-123'}}),'forms',originConfig,'site',secret)!;
 assert.equal((withFields.properties.firstTouch as Record<string,unknown>).ad,'120200000000000011');
 assert.equal((withFields.properties.firstTouch as Record<string,unknown>).linkId,LINK);
 assert.equal((withFields.properties.origin as Record<string,unknown>).ad,'120200000000000012');
 assert.equal((withFields.properties.origin as Record<string,unknown>).visitor,VID);
 assert.equal((withFields.properties.origin as Record<string,unknown>).session,'mc-abc-123');
 assert.equal(JSON.stringify(withFields).includes('leak'),false);
 const old=normalizeWixLeadEntry(form(),'forms',originConfig,'site',secret)!;
 assert.deepEqual(old.properties.origin,{});assert.equal(old.properties.firstTouch,null);assert.equal(old.eligible,true);
 const broken=normalizeWixLeadEntry(form({submissions:{email:'person@example.org',blg_visiteur:'nope',blg_origine:'{broken',blg_arrivee:JSON.stringify({email:'x@y.z'}),blg_session:'bad session'}}),'forms',originConfig,'site',secret)!;
 assert.deepEqual(broken.properties.origin,{});assert.equal(broken.properties.firstTouch,null);
 assert.notEqual(withFields.payloadHash,old.payloadHash,'un contexte différent est une observation différente');
});
test('configuration : adset, lien, visiteur et première origine acceptés ; clé inconnue refusée',()=>{
 assert.ok(wixLeadEntryConfig(JSON.stringify({formIds:['f'],formOriginFields:{first:'blg_origine'},quiz:{collectionId:'q',originFields:{adset:'motCle',linkId:'lienId',visitor:'visiteur'},firstTouchFields:{ad:'premierePublicite'}}})));
 assert.throws(()=>wixLeadEntryConfig(JSON.stringify({formIds:['f'],quiz:{collectionId:'q',originFields:{unknown:'x'}}})),/INVALID_LEAD_ENTRY_CONFIGURATION/);
 assert.throws(()=>wixLeadEntryConfig(JSON.stringify({formIds:['f'],formOriginFields:{email:'email'}})),/INVALID_LEAD_ENTRY_CONFIGURATION/);
});
