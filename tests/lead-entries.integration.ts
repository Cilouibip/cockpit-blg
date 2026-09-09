import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import fs from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {normalizeWixLeadEntry,leadEntryProfile} from '../src/connectors/wix-lead-entries';
const base=new URL(process.env.TEST_DATABASE_URL||'postgresql://localhost:55440/postgres');
if(!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw Error('LOCAL_ONLY');
const name='lead_test_'+Date.now(),admin=new Client({connectionString:base.href});const target=new URL(base);target.pathname='/'+name;let db:Client;
before(async()=>{await admin.connect();await admin.query(`CREATE DATABASE ${name}`);db=new Client({connectionString:target.href});await db.connect();for(const f of fs.readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort())await db.query(fs.readFileSync('supabase/migrations/'+f,'utf8'));await db.query("SET statement_timeout='8s'");});
after(async()=>{await db?.end();await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();});beforeEach(()=>db.query('BEGIN'));afterEach(()=>db.query('ROLLBACK'));
type Claim={runId:string;lease:string;checkpoint:{page:number};busy?:boolean};
async function claim(family='forms',profile='synthetic-v1',namespace='site'){return (await db.query('SELECT cockpit_claim_lead_entries($1,$2,$3) r',[namespace,family,profile])).rows[0].r as Claim;}
function record(id=randomUUID(),identity='a'.repeat(64),at='2026-06-01T10:00:00Z',updated='2026-08-01T00:00:00Z'){
 const value={source:'wix',sourceNamespace:'site',family:'forms',externalId:id,containerId:'synthetic-form',contactId:null,sourceStatus:'CONFIRMED',identityKey:identity,occurredAt:at,sourceUpdatedAt:updated,eligible:true,properties:{dateBasis:'submission_created'}};
 return {...value,payloadHash:createHash('sha256').update(JSON.stringify(value)).digest('hex'),sourcePayloadHash:createHash('sha256').update(JSON.stringify(value)).digest('hex')};
}
async function stage(c:Claim,rows:unknown[],done=true,page=0,ignored=0){return (await db.query('SELECT cockpit_stage_lead_entries($1,$2,$3,$4,$5,$6,$7,$8) r',[c.runId,c.lease,page,JSON.stringify(rows),done?null:'next',done,rows.length+ignored,ignored])).rows[0].r;}
async function publish(c:Claim){return (await db.query('SELECT cockpit_publish_lead_entries($1,$2) r',[c.runId,c.lease])).rows[0].r;}
async function rollup(from='2026-01-01',to='2027-01-01',scope:unknown={forms:{profile:'synthetic-v1',containerIds:['synthetic-form']},quiz:{profile:'synthetic-v1',containerIds:['synthetic-quiz']},client_history:{profile:'synthetic-v1',containerIds:['clients']}}){return (await db.query("SELECT cockpit_lead_entry_rollup('site','crm','clients',$1,$2,$3) r",[from,to,JSON.stringify(scope)])).rows[0].r;}
test('staged entries never activate browser traffic or become visible before a terminal publication',async()=>{
 const c=await claim();await stage(c,[record()],false);assert.equal((await rollup()).available,false);assert.equal((await rollup()).requestCount,0);
 assert.equal((await db.query('SELECT count(*) FROM v_events_canonical')).rows[0].count,'0');
 await db.query('SAVEPOINT invalid');await assert.rejects(()=>publish(c),{code:'55000'});await db.query('ROLLBACK TO invalid');
 await stage(c,[],true,1);const result=await publish(c);assert.equal(result.status,'complete');assert.equal((await rollup()).requestCount,1);assert.equal((await db.query('SELECT count(*) FROM events')).rows[0].count,'0');
});
test('same page retry, lease resume, then repeated import preserve one request and exact counters',async()=>{
 const row=record(),c=await claim();await stage(c,[row],false);assert.equal((await stage(c,[row],false)).alreadyStaged,true);
 await db.query('SELECT cockpit_release_lead_entries($1,$2)',[c.runId,c.lease]);const resumed=await claim();assert.equal(resumed.runId,c.runId);assert.equal(resumed.checkpoint.page,1);await stage(resumed,[],true,1);assert.equal((await publish(resumed)).counts.read,1);
 const next=await claim();await stage(next,[row]);const result=await publish(next);assert.equal(result.counts.unchanged,1);assert.equal(result.counts.changed,0);assert.equal((await rollup()).requestCount,1);
});
test('changed source date publishes a new version while retaining history',async()=>{
 const first=record();const a=await claim();await stage(a,[first]);await publish(a);
 const b=await claim();await stage(b,[record(first.externalId,'a'.repeat(64),'2025-12-20T10:00:00Z','2026-08-02T00:00:00Z')]);await publish(b);
 assert.equal((await rollup()).requestCount,0);assert.equal((await rollup('2025-01-01','2026-01-01')).firstKnownAcquisitions,1);assert.equal((await db.query('SELECT count(*) FROM lead_source_observations WHERE published_at IS NOT NULL')).rows[0].count,'2');
});
test('same timestamp different content fails explicitly and keeps the last published facts',async()=>{
 const first=record(),a=await claim();await stage(a,[first]);await publish(a);const b=await claim();await stage(b,[record(first.externalId,'a'.repeat(64),'2026-07-01T10:00:00Z')]);const fail=await publish(b);assert.equal(fail.reason,'SOURCE_VERSION_CONFLICT');assert.equal((await rollup('2026-06-01','2026-07-01')).requestCount,1);
});
test('unchanged content with newer source timestamp advances the version guard',async()=>{
 const first=record(),a=await claim();await stage(a,[first]);await publish(a);
 const same={...first,sourceUpdatedAt:'2026-08-02T00:00:00Z'};const b=await claim();await stage(b,[same]);assert.equal((await publish(b)).counts.unchanged,1);
 const c=await claim();await stage(c,[{...same,payloadHash:'f'.repeat(64),occurredAt:'2026-07-01T00:00:00Z'}]);assert.equal((await publish(c)).reason,'SOURCE_VERSION_CONFLICT');
});
test('older versions and omissions cannot erase historical acquisition',async()=>{
 const first=record(),a=await claim();await stage(a,[first]);await publish(a);
 const b=await claim();await stage(b,[record(first.externalId,'a'.repeat(64),'2026-07-01T00:00:00Z','2026-07-01T00:00:00Z')]);assert.equal((await publish(b)).counts.stale,1);
 const c=await claim();await stage(c,[]);assert.equal((await publish(c)).status,'empty');assert.equal((await rollup()).requestCount,1);
});
test('global antiquity is evaluated before period filtering and requests remain separate',async()=>{
 const a=await claim();await stage(a,[record(randomUUID(),'a'.repeat(64),'2024-05-20T10:00:00Z'),record()]);await publish(a);
 const result=await rollup();assert.equal(result.firstKnownAcquisitions,0);assert.equal(result.peopleWithRequests,1);assert.equal(result.requestCount,1);assert.equal(result.knownBeforePeriod,1);
});
test('published Notion person is reused by the shared identity namespace',async()=>{
 const person=randomUUID();await db.query('INSERT INTO people(id) VALUES($1)',[person]);await db.query("INSERT INTO person_identities(person_id,source,source_namespace,identity_kind,identity_key,state,evidence) VALUES($1,'identity','blg-email-v1','email_hmac',$2,'linked','synthetic Notion')",[person,'a'.repeat(64)]);
 const c=await claim();await stage(c,[record()]);await publish(c);assert.equal((await db.query('SELECT person_id FROM lead_source_observations WHERE is_current')).rows[0].person_id,person);assert.equal((await db.query('SELECT count(*) FROM people')).rows[0].count,'1');
});
test('client start provides an earlier bound, never an artificial acquisition date',async()=>{
 const client={...record(),source:'notion',sourceNamespace:'clients',family:'client_history',containerId:'clients',occurredAt:'2024-02-01T00:00:00Z'};const a=await claim('client_history','synthetic-v1','clients');await stage(a,[client]);await publish(a);
 const b=await claim();await stage(b,[record()]);await publish(b);assert.equal((await rollup()).firstKnownAcquisitions,0);assert.equal((await rollup()).earlierClientEvidence,1);assert.equal((await rollup('2024-01-01','2025-01-01')).firstKnownAcquisitions,0);assert.equal((await rollup()).requestCount,1);
});
test('only a reciprocal client relation bridges a new email to the existing prospect person',async()=>{
 const person=randomUUID(),clientId=randomUUID();await db.query('INSERT INTO people(id) VALUES($1)',[person]);
 await db.query("INSERT INTO prospects(source,source_namespace,external_id,person_id,source_updated_at,connector_version,mapping_version,business) VALUES('notion','crm','prospect-linked',$1,now(),'synthetic','synthetic',$2)",[person,JSON.stringify({clientIds:[clientId],acquisitionDay:'2024-05-01'})]);
 const client={...record(clientId,'b'.repeat(64)),source:'notion',sourceNamespace:'clients',family:'client_history',containerId:'clients',properties:{prospectNamespace:'crm',prospectIds:['prospect-linked']}};
 const c=await claim('client_history','synthetic-v1','clients');await stage(c,[client]);await publish(c);
 const w=await claim();await stage(w,[record(randomUUID(),'b'.repeat(64))]);await publish(w);
 assert.equal((await db.query("SELECT person_id FROM person_identities WHERE identity_key=$1",['b'.repeat(64)])).rows[0].person_id,person);assert.equal((await rollup()).firstKnownAcquisitions,0);assert.equal((await db.query('SELECT count(*) FROM people')).rows[0].count,'1');
});
test('one-way client relation and conflicting preexisting email are not merged',async()=>{
 const p1=randomUUID(),p2=randomUUID(),clientId=randomUUID();await db.query('INSERT INTO people(id) VALUES($1),($2)',[p1,p2]);
 await db.query("INSERT INTO prospects(source,source_namespace,external_id,person_id,source_updated_at,connector_version,mapping_version,business) VALUES('notion','crm','prospect-linked',$1,now(),'synthetic','synthetic',$2)",[p1,JSON.stringify({clientIds:[clientId]})]);
 await db.query("INSERT INTO person_identities(person_id,source,source_namespace,identity_kind,identity_key,state,evidence) VALUES($1,'identity','blg-email-v1','email_hmac',$2,'linked','synthetic')",[p2,'b'.repeat(64)]);
 const client={...record(clientId,'b'.repeat(64)),source:'notion',sourceNamespace:'clients',family:'client_history',containerId:'clients',properties:{prospectNamespace:'crm',prospectIds:['prospect-linked']}};
 const c=await claim('client_history','synthetic-v1','clients');await stage(c,[client]);await publish(c);
 assert.equal((await db.query('SELECT identity_state FROM lead_source_observations WHERE is_current')).rows[0].identity_state,'conflict');assert.equal((await db.query('SELECT person_id FROM lead_source_observations WHERE is_current')).rows[0].person_id,null);
 assert.equal((await db.query('SELECT person_id FROM person_identities')).rows[0].person_id,p2);
});
test('malformed checkpoint and unbalanced page cannot publish or lose source rows',async()=>{
 const c=await claim();await db.query('SAVEPOINT bad');await assert.rejects(()=>db.query('SELECT cockpit_stage_lead_entries($1,$2,0,\'[]\',NULL,true,1,0)',[c.runId,c.lease]),{code:'23514'});await db.query('ROLLBACK TO bad');
 await db.query("UPDATE sync_runs SET checkpoint='{}' WHERE id=$1",[c.runId]);await db.query('SAVEPOINT empty');await assert.rejects(()=>publish(c),{code:'55000'});await db.query('ROLLBACK TO empty');assert.equal((await rollup()).requestCount,0);
});
test('raw Notion business antiquity cannot be hidden by a later prioritized acquisitionDay',async()=>{
 const person=randomUUID();await db.query('INSERT INTO people(id) VALUES($1)',[person]);
 await db.query("INSERT INTO prospects(source,source_namespace,external_id,person_id,connector_version,mapping_version,business) VALUES('notion','crm','historic-person',$1,'synthetic','synthetic',$2)",[person,JSON.stringify({acquisitionDay:'2026-08-20',dates:{legacy:'2024-05-01',real:'2026-08-20',wix:'invalid'}})]);
 assert.equal((await rollup('2026-08-01','2026-09-01')).firstKnownAcquisitions,0);assert.equal((await rollup('2024-01-01','2025-01-01')).firstKnownAcquisitions,1);
});
test('reviewed mapping profile can reclassify an unchanged source without inventing a source-version conflict',async()=>{
 const original=record(),a=await claim();await stage(a,[original]);await publish(a);
 const next={...original,eligible:false,properties:{version:'synthetic-v2'},payloadHash:'c'.repeat(64)};const b=await claim('forms','synthetic-v2');await stage(b,[next]);const result=await publish(b);assert.equal(result.status,'complete');assert.equal(result.counts.mappingChanged,1);
 const r=await rollup('2026-01-01','2027-01-01',{forms:{profile:'synthetic-v2',containerIds:['synthetic-form']}});assert.equal(r.requestCount,0);assert.equal(r.excludedSourceRequests,1);
 const again=await claim('forms','synthetic-v1');assert.equal((again as any).checkpoint.from.slice(0,10),'1970-01-01');
});
test('a resolved identity replaces the stale unresolved current row without duplicating a request',async()=>{
 const person=randomUUID();await db.query('INSERT INTO people(id) VALUES($1)',[person]);
 await db.query("INSERT INTO person_identities(source,source_namespace,identity_kind,identity_key,state,evidence) VALUES('identity','blg-email-v1','email_hmac',$1,'ambiguous','synthetic')",['a'.repeat(64)]);
 const original=record(),a=await claim();await stage(a,[original]);await publish(a);assert.equal((await rollup()).unresolvedDatedRequests,1);
 await db.query("UPDATE person_identities SET valid_to=clock_timestamp() WHERE identity_key=$1",['a'.repeat(64)]);
 await db.query("INSERT INTO person_identities(person_id,source,source_namespace,identity_kind,identity_key,assignment_version,valid_from,state,evidence) VALUES($1,'identity','blg-email-v1','email_hmac',$2,2,clock_timestamp(),'linked','reviewed synthetic resolution')",[person,'a'.repeat(64)]);
 const b=await claim();await stage(b,[original]);const result=await publish(b);assert.equal(result.counts.identityChanged,1);assert.equal((await rollup()).unresolvedDatedRequests,0);assert.equal((await rollup()).requestCount,1);assert.equal((await rollup()).sourceRequestPeople,1);
});
test('explicit scope removal excludes old current observations while retained history remains',async()=>{
 const a=await claim();await stage(a,[record()]);await publish(a);assert.equal((await rollup()).requestCount,1);
 assert.equal((await rollup('2026-01-01','2027-01-01',{forms:{profile:'synthetic-v1',containerIds:['different-form']}})).requestCount,0);
 assert.equal((await rollup('2026-01-01','2027-01-01',{})).requestCount,0);assert.equal((await db.query('SELECT count(*) FROM lead_source_observations WHERE is_current')).rows[0].count,'1');
});
test('profile changes cannot claim a live namespace lease',async()=>{
 const c=await claim();assert.equal((await claim('forms','different-profile')).busy,true);await db.query('SELECT cockpit_release_lead_entries($1,$2)',[c.runId,c.lease]);const next=await claim('forms','different-profile');assert.notEqual(next.runId,c.runId);assert.equal((await db.query('SELECT status FROM sync_runs WHERE id=$1',[c.runId])).rows[0].status,'failed');
});
test('all new observation functions and table remain server only',async()=>{
 const permissions=(await db.query("SELECT bool_and(NOT has_function_privilege('anon',oid,'execute') AND NOT has_function_privilege('authenticated',oid,'execute') AND has_function_privilege('service_role',oid,'execute') AND NOT prosecdef) ok FROM pg_proc WHERE proname IN ('cockpit_claim_lead_entries','cockpit_stage_lead_entries','cockpit_publish_lead_entries','cockpit_release_lead_entries','cockpit_lead_entry_rollup')")).rows[0];assert.equal(permissions.ok,true);assert.equal((await db.query("SELECT has_table_privilege('anon','lead_source_observations','SELECT') ok")).rows[0].ok,false);
});

test('real normalizer remaps provider fields at the same source version, while common source contradictions still fail',async()=>{
 const secret='synthetic-only-identity-key-for-digest-tests',config={formNamespace:'forms',formIds:['synthetic-form'],ignoredFormIds:[],formEmailField:'email'};
 const raw={id:'normalizer-entry',formId:'synthetic-form',namespace:'forms',createdDate:'2026-06-01T00:00:00Z',updatedDate:'2026-08-01T00:00:00Z',status:'CONFIRMED',submissions:{email:'first@example.org',email_bis:'second@example.org'}};
 const first=normalizeWixLeadEntry(raw,'forms',config,'site',secret)!,a=await claim('forms',leadEntryProfile('forms',config));await stage(a,[first]);await publish(a);
 const nextConfig={...config,formEmailField:'email_bis'},next=normalizeWixLeadEntry(raw,'forms',nextConfig,'site',secret)!;
 assert.equal(next.sourcePayloadHash,first.sourcePayloadHash);assert.notEqual(next.identityKey,first.identityKey);
 const b=await claim('forms',leadEntryProfile('forms',nextConfig));await stage(b,[next]);assert.equal((await publish(b)).status,'complete');
 const changed=normalizeWixLeadEntry({...raw,submissions:{...raw.submissions,email_bis:'third@example.org'}},'forms',nextConfig,'site',secret)!;
 const c=await claim('forms',leadEntryProfile('forms',{...nextConfig,ignoredFormIds:['new-test']}));await stage(c,[changed]);assert.equal((await publish(c)).reason,'SOURCE_VERSION_CONFLICT');
 assert.equal((await db.query('SELECT identity_key FROM lead_source_observations WHERE is_current')).rows[0].identity_key,next.identityKey);
});
test('mapping omission blocks transition explicitly, preserves the last useful reader and does not loop through full replays',async()=>{
 const a=await claim();await stage(a,[record()]);await publish(a);
 const b=await claim('forms','synthetic-v2');await stage(b,[]);assert.equal((await publish(b)).reason,'MAPPING_REPLAY_INCOMPLETE');
 const kept=await rollup('2026-01-01','2027-01-01',{forms:{profile:'synthetic-v2',containerIds:['synthetic-form']}});assert.equal(kept.requestCount,1);assert.equal(kept.mappingPending.length,1);
 const blocked=await claim('forms','synthetic-v2');assert.equal((blocked as any).blocked,true);assert.equal(blocked.runId,b.runId);
 assert.equal((await db.query("SELECT count(*) FROM sync_runs WHERE query_profile_key='synthetic-v2'")).rows[0].count,'1');
});
test('explicitly removing a container allows a new profile while preserving excluded historical rows',async()=>{
 const a=await claim();await stage(a,[record()]);await publish(a);
 const b=(await db.query("SELECT cockpit_claim_lead_entries('site','forms','synthetic-v2',NULL,'[\"different-form\"]') r")).rows[0].r;
 await stage(b,[]);assert.equal((await publish(b)).status,'empty');
 const result=await rollup('2026-01-01','2027-01-01',{forms:{profile:'synthetic-v2',containerIds:['different-form']}});assert.equal(result.requestCount,0);assert.deepEqual(result.mappingPending,[]);
 const next=await claim('forms','synthetic-v2');assert.notEqual((next as any).checkpoint.from.slice(0,10),'1970-01-01');
 assert.equal((await db.query('SELECT count(*) FROM lead_source_observations WHERE is_current')).rows[0].count,'1');
});
