import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import fs from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {normalizeWixLeadEntry,leadEntryProfile,wixLeadEntryConfig} from '../src/connectors/wix-lead-entries';
import {postgresDatabase} from '../src/lib/db';
import {readLiveKpiFunnel} from '../src/lib/kpi-funnel-live';
import {buildAdFunnel} from '../src/lib/ad-funnel';
import {buildBookingResults} from '../src/lib/booking-results';
import {readVisualJourneyReport} from '../src/connectors/visual-journey-analytics';
import {VISUAL_JOURNEY_FORM_ID} from '../src/lib/visual-journey-report';
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
// Migration 020 : la nouvelle version source met à jour la ligne courante en place (même id) ; l'historique utile est la
// ligne de changement (anciennes date source et empreintes), plus une seconde copie publiée de la fiche.
test('changed source date updates the current row in place while retaining the change event',async()=>{
 const first=record();const a=await claim();await stage(a,[first]);await publish(a);const id=(await db.query('SELECT id FROM lead_source_observations WHERE is_current')).rows[0].id;
 const b=await claim();await stage(b,[record(first.externalId,'a'.repeat(64),'2025-12-20T10:00:00Z','2026-08-02T00:00:00Z')]);await publish(b);
 assert.equal((await rollup()).requestCount,0);assert.equal((await rollup('2025-01-01','2026-01-01')).firstKnownAcquisitions,1);assert.equal((await db.query('SELECT count(*) FROM lead_source_observations WHERE published_at IS NOT NULL')).rows[0].count,'1');
 assert.equal((await db.query('SELECT id FROM lead_source_observations WHERE is_current')).rows[0].id,id);
 const events=(await db.query('SELECT previous_source_updated_at,kinds FROM lead_source_observation_changes')).rows;assert.equal(events.length,1);assert.equal(iso(events[0].previous_source_updated_at),'2026-08-01T00:00:00.000Z');assert.ok(events[0].kinds.includes('source'));
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

// ---------------------------------------------------------------------------------------------------------------
// Migration 020 : une modification met à jour la même ligne ; une absence de changement ne conserve aucune copie ;
// les changements métier sont tracés dans lead_source_observation_changes, sans copie de properties.
const MIGRATION_020='supabase/migrations/020_lead_entries_update_in_place.sql';
// Les dates arrivent en texte dès que src/lib/db est importé (analyseur pg global) : comparaison par instant.
const ms=(value:unknown)=>new Date(value as string).getTime(),iso=(value:unknown)=>new Date(value as string).toISOString();
const one=async(query:string,params:unknown[]=[])=>(await db.query(query,params)).rows[0];
const total=async(namespace='site')=>Number((await one('SELECT count(*)::int n FROM lead_source_observations WHERE source_namespace=$1',[namespace])).n);
const changes=async(namespace='site')=>(await db.query('SELECT * FROM lead_source_observation_changes WHERE source_namespace=$1 ORDER BY changed_at,id',[namespace])).rows;
const currentRow=async(externalId:string)=>one('SELECT * FROM lead_source_observations WHERE is_current AND external_id=$1',[externalId]);
const allRows=async()=>(await db.query('SELECT * FROM lead_source_observations ORDER BY id')).rows;
/** Même observation avec des champs modifiés : empreintes recalculées comme le ferait le connecteur. */
function rehash(value:Record<string,unknown>,patch:Record<string,unknown>={}){
 const {payloadHash:_p,sourcePayloadHash:_s,...rest}={...value,...patch};const hash=createHash('sha256').update(JSON.stringify(rest)).digest('hex');
 return {...rest,payloadHash:hash,sourcePayloadHash:hash} as ReturnType<typeof record>;
}
async function collect(rows:unknown[],family='forms',profile='synthetic-v1',namespace='site'){const c=await claim(family,profile,namespace);await stage(c,rows);return {c,result:await publish(c)};}

test('collecte identique : aucune nouvelle ligne, aucune ligne de changement',async()=>{
 const a=record(),b=record(randomUUID(),'b'.repeat(64));await collect([a,b]);const before=await allRows();
 const {result}=await collect([a,b]);
 assert.equal(result.status,'complete');assert.equal(result.counts.unchanged,2);assert.equal(result.counts.unchangedSkipped,2);assert.equal(result.counts.changed,0);assert.equal(result.counts.events,0);
 assert.deepEqual(await allRows(),before);assert.equal(await total(),2);assert.equal((await changes()).length,0);
});

test('modification réelle (date source et empreinte source) : même id, même nombre de lignes, une ligne de changement « source »',async()=>{
 const first=record(),a=await claim();await stage(a,[first]);await publish(a);const before=await currentRow(first.externalId);
 const b=await claim();await stage(b,[rehash(first,{sourceUpdatedAt:'2026-08-02T00:00:00Z',sourceStatus:'CANCELED'})]);const result=await publish(b);
 assert.equal(result.status,'complete');assert.equal(result.counts.changed,1);assert.equal(result.counts.events,1);assert.equal(await total(),1);
 const after=await currentRow(first.externalId);
 assert.equal(after.id,before.id,'même objet');assert.equal(after.run_id,b.runId,'tentative qui a publié la modification');
 assert.equal(ms(after.recorded_at),ms(before.recorded_at),'première observation conservée');
 assert.equal(ms(after.published_at),ms((await one('SELECT finished_at FROM sync_runs WHERE id=$1',[b.runId])).finished_at),'publiée par la nouvelle tentative');
 assert.equal(after.source_status,'CANCELED');assert.equal(iso(after.source_updated_at),'2026-08-02T00:00:00.000Z');assert.notEqual(after.source_payload_hash,before.source_payload_hash);
 assert.equal(Number((await one('SELECT count(*)::int n FROM lead_source_observations WHERE run_id=$1 AND NOT is_current',[b.runId])).n),0,'aucune ligne préparée restante');
 const events=await changes();assert.equal(events.length,1);const [event]=events;
 assert.equal(event.observation_id,before.id);assert.equal(event.run_id,b.runId);assert.equal(event.external_id,first.externalId);assert.equal(event.family,'forms');
 assert.deepEqual(event.kinds,['source','derived']);assert.equal(ms(event.changed_at),ms(after.published_at));
 assert.equal(iso(event.previous_source_updated_at),iso(before.source_updated_at));assert.equal(event.previous_payload_hash,before.payload_hash);
 assert.equal(event.previous_source_payload_hash,before.source_payload_hash);assert.equal(event.previous_mapping_profile,'synthetic-v1');
 assert.equal(event.previous_person_id,before.person_id);assert.equal(event.previous_identity_state,before.identity_state);assert.equal(event.previous_eligible,true);
 assert.equal(Object.hasOwn(event,'properties'),false,'trace minimale sans properties');
});

test('nouvel objet : une ligne de plus, aucune ligne de changement',async()=>{
 const a=record();await collect([a]);const b=record(randomUUID(),'b'.repeat(64));const {c,result}=await collect([a,b]);
 assert.equal(await total(),2);assert.equal(result.counts.changed,1);assert.equal(result.counts.unchangedSkipped,1);assert.equal(result.counts.events,0);
 assert.equal((await currentRow(b.externalId)).run_id,c.runId);assert.equal((await changes()).length,0);
});

test('re-liaison d’identité (état puis personne) : même ligne, une ligne de changement « identity » à chaque fois',async()=>{
 const person=randomUUID(),other=randomUUID();await db.query('INSERT INTO people(id) VALUES($1),($2)',[person,other]);
 await db.query("INSERT INTO person_identities(source,source_namespace,identity_kind,identity_key,state,evidence) VALUES('identity','blg-email-v1','email_hmac',$1,'ambiguous','synthetic')",['a'.repeat(64)]);
 const original=record();await collect([original]);const before=await currentRow(original.externalId);assert.equal(before.identity_state,'conflict');assert.equal(before.person_id,null);
 await db.query("UPDATE person_identities SET valid_to=clock_timestamp() WHERE identity_key=$1 AND valid_to IS NULL",['a'.repeat(64)]);
 await db.query("INSERT INTO person_identities(person_id,source,source_namespace,identity_kind,identity_key,assignment_version,valid_from,state,evidence) VALUES($1,'identity','blg-email-v1','email_hmac',$2,2,clock_timestamp(),'linked','reviewed synthetic resolution')",[person,'a'.repeat(64)]);
 const linked=await collect([original]);
 assert.equal(linked.result.counts.identityChanged,1);assert.equal(linked.result.counts.events,1);assert.equal(await total(),1);
 let after=await currentRow(original.externalId);assert.equal(after.id,before.id);assert.equal(after.person_id,person);assert.equal(after.identity_state,'linked');assert.equal(after.run_id,linked.c.runId);
 assert.equal(ms(after.source_updated_at),ms(before.source_updated_at));
 let events=await changes();assert.equal(events.length,1);assert.deepEqual(events[0].kinds,['identity']);assert.equal(events[0].previous_identity_state,'conflict');assert.equal(events[0].previous_person_id,null);
 // Personne réaffectée par une résolution revue : même ligne, seconde trace.
 await db.query("UPDATE person_identities SET valid_to=clock_timestamp() WHERE identity_key=$1 AND valid_to IS NULL",['a'.repeat(64)]);
 await db.query("INSERT INTO person_identities(person_id,source,source_namespace,identity_kind,identity_key,assignment_version,valid_from,state,evidence) VALUES($1,'identity','blg-email-v1','email_hmac',$2,3,clock_timestamp(),'linked','second reviewed synthetic resolution')",[other,'a'.repeat(64)]);
 const relinked=await collect([original]);assert.equal(relinked.result.counts.identityChanged,1);assert.equal(await total(),1);
 after=await currentRow(original.externalId);assert.equal(after.id,before.id);assert.equal(after.person_id,other);
 events=await changes();assert.equal(events.length,2);assert.deepEqual(events[1].kinds,['identity']);assert.equal(events[1].previous_person_id,person);assert.equal(events[1].previous_identity_state,'linked');
});

test('changement de profil de mapping sur N inscriptions : N mises à jour en place, aucune ligne, aucune trace ; MAPPING_REPLAY_INCOMPLETE toujours actif',async()=>{
 const N=5,rows=Array.from({length:N},(_,i)=>record(randomUUID(),'abcde'[i].repeat(64)));await collect(rows);
 const before=(await db.query("SELECT id,external_id,recorded_at FROM lead_source_observations WHERE source_namespace='site' ORDER BY external_id")).rows;
 const remapped=rows.map(row=>({...row,properties:{dateBasis:'submission_created',version:'synthetic-v2'},payloadHash:createHash('sha256').update('synthetic-v2:'+row.externalId).digest('hex')}));
 const {c,result}=await collect(remapped,'forms','synthetic-v2');
 assert.equal(result.status,'complete');assert.equal(result.counts.mappingChanged,N);assert.equal(result.counts.events,0);assert.equal(result.counts.changed,N);
 assert.equal(await total(),N,'aucune nouvelle ligne');assert.equal((await changes()).length,0,'re-dérivation technique : aucune trace');
 const after=(await db.query("SELECT id,external_id,recorded_at,run_id,mapping_profile,properties FROM lead_source_observations WHERE source_namespace='site' ORDER BY external_id")).rows;
 assert.deepEqual(after.map(row=>row.id),before.map(row=>row.id));assert.deepEqual(after.map(row=>ms(row.recorded_at)),before.map(row=>ms(row.recorded_at)));
 assert.ok(after.every(row=>row.run_id===c.runId&&row.mapping_profile==='synthetic-v2'&&row.properties.version==='synthetic-v2'));
 assert.equal((await rollup('2026-01-01','2027-01-01',{forms:{profile:'synthetic-v2',containerIds:['synthetic-form']}})).requestCount,N);
 // Contrôle inchangé : un nouveau profil dont le rejeu omet une inscription échoue sans rien modifier.
 const published=(await db.query('SELECT * FROM lead_source_observations WHERE is_current ORDER BY id')).rows;
 const v3=await claim('forms','synthetic-v3');await stage(v3,remapped.slice(1));const blocked=await publish(v3);
 assert.equal(blocked.reason,'MAPPING_REPLAY_INCOMPLETE');assert.equal(blocked.counts.unmappedHistory,1);
 assert.deepEqual((await db.query('SELECT * FROM lead_source_observations WHERE is_current ORDER BY id')).rows,published);assert.equal((await changes()).length,0);
 assert.equal(Number((await one('SELECT count(*)::int n FROM lead_source_observations WHERE run_id=$1 AND published_at IS NULL AND NOT is_current',[v3.runId])).n),N-1,'lignes préparées de la tentative en échec, jamais publiées');
});

test('éligibilité modifiée par un profil revu : mise à jour en place, une ligne de changement « eligibility »',async()=>{
 const original=record();await collect([original]);const before=await currentRow(original.externalId);
 const {result}=await collect([{...original,eligible:false,properties:{version:'synthetic-v2'},payloadHash:'c'.repeat(64)}],'forms','synthetic-v2');
 assert.equal(result.counts.mappingChanged,1);assert.equal(result.counts.events,1);assert.equal(await total(),1);
 assert.equal((await currentRow(original.externalId)).id,before.id);assert.equal((await currentRow(original.externalId)).eligible,false);
 const [event]=await changes();assert.deepEqual(event.kinds,['eligibility','mapping','derived']);assert.equal(event.previous_eligible,true);assert.equal(event.previous_mapping_profile,'synthetic-v1');
});

test('ligne préparée plus ancienne (stale) : supprimée, ligne courante intacte',async()=>{
 const first=record();await collect([first]);const snapshot=await currentRow(first.externalId);
 const {c,result}=await collect([record(first.externalId,'a'.repeat(64),'2026-07-01T00:00:00Z','2026-07-01T00:00:00Z')]);
 assert.equal(result.status,'complete');assert.equal(result.counts.stale,1);assert.equal(result.counts.events,0);
 assert.equal(await total(),1);assert.deepEqual(await currentRow(first.externalId),snapshot);
 assert.equal(Number((await one('SELECT count(*)::int n FROM lead_source_observations WHERE run_id=$1',[c.runId])).n),0,'aucune version conservée');assert.equal((await changes()).length,0);
});

test('conflit de version : échec, aucune ligne publiée modifiée, aucune trace',async()=>{
 const first=record();await collect([first]);const published=await allRows();
 const {c,result}=await collect([record(first.externalId,'a'.repeat(64),'2026-07-01T10:00:00Z')]);
 assert.equal(result.status,'failed');assert.equal(result.reason,'SOURCE_VERSION_CONFLICT');assert.equal((await one('SELECT status FROM sync_runs WHERE id=$1',[c.runId])).status,'failed');
 assert.deepEqual((await allRows()).filter(row=>row.run_id!==c.runId),published);assert.equal((await changes()).length,0);
 const staged=(await db.query('SELECT is_current,published_at FROM lead_source_observations WHERE run_id=$1',[c.runId])).rows;
 assert.deepEqual(staged,[{is_current:false,published_at:null}],'ligne préparée de la tentative en échec, jamais publiée');
});

test('rejeu de publication : refus 55000, aucune ligne ni trace modifiée',async()=>{
 const first=record();await collect([first]);const {c}=await collect([rehash(first,{sourceUpdatedAt:'2026-08-02T00:00:00Z'})]);
 const rows=await allRows(),events=await changes();assert.equal(events.length,1);
 await db.query('SAVEPOINT replay');await assert.rejects(()=>publish(c),{code:'55000'});await db.query('ROLLBACK TO replay');
 assert.deepEqual(await allRows(),rows);assert.deepEqual(await changes(),events);
});

test('tentative interrompue puis reprise : aucune double ligne',async()=>{
 const a=record();await collect([a]);const before=await currentRow(a.externalId),b=record(randomUUID(),'b'.repeat(64));
 const modified=rehash(a,{sourceUpdatedAt:'2026-08-02T00:00:00Z',sourceStatus:'CANCELED'});
 const pending=await claim();await stage(pending,[modified],false,0);assert.equal((await stage(pending,[modified],false,0)).alreadyStaged,true);
 assert.equal((await currentRow(a.externalId)).source_status,'CONFIRMED','page préparée invisible');
 await db.query("UPDATE sync_runs SET lease_until=now()-interval '1 second' WHERE id=$1",[pending.runId]);
 const resumed=await claim();assert.equal(resumed.runId,pending.runId);assert.equal(resumed.checkpoint.page,1);
 await stage(resumed,[b],true,1);const result=await publish(resumed);
 assert.equal(result.status,'complete');assert.equal(result.counts.events,1);assert.equal(await total(),2);
 const after=await currentRow(a.externalId);assert.equal(after.id,before.id);assert.equal(after.source_status,'CANCELED');assert.equal(after.run_id,pending.runId);
 assert.equal(Number((await one('SELECT count(*)::int n FROM lead_source_observations WHERE NOT is_current')).n),0);assert.equal((await changes()).length,1);
});

test('ordre de fusion : la ligne préparée est supprimée avant que la ligne courante prenne la tentative (index unique)',async()=>{
 assert.equal(Number((await one("SELECT count(*)::int n FROM pg_constraint WHERE conrelid='public.lead_source_observations'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (run_id, source_namespace, family, external_id)'")).n),1);
 const first=record();await collect([first]);const current=await currentRow(first.externalId);
 const c=await claim();await stage(c,[rehash(first,{sourceUpdatedAt:'2026-08-02T00:00:00Z'})]);
 // Contre-épreuve : mettre à jour la ligne courante avant de supprimer la ligne préparée viole l'index unique.
 await db.query('SAVEPOINT update_first');await assert.rejects(()=>db.query('UPDATE lead_source_observations SET run_id=$1 WHERE id=$2',[c.runId,current.id]),{code:'23505'});await db.query('ROLLBACK TO update_first');
 const result=await publish(c);assert.equal(result.status,'complete');
 const after=await currentRow(first.externalId);assert.equal(after.id,current.id);assert.equal(after.run_id,c.runId);assert.equal(await total(),1);
});

test('lecteurs (filtre commun et agrégats SQL) : ligne mise à jour en place et ligne non préparée restent sélectionnées',async()=>{
 const a=record(),b=record(randomUUID(),'b'.repeat(64));const first=await collect([a,b]);
 const second=await collect([rehash(a,{sourceUpdatedAt:'2026-08-02T00:00:00Z',contactId:'contact-2'}),b]);
 assert.equal((await currentRow(a.externalId)).run_id,second.c.runId);assert.equal((await currentRow(b.externalId)).run_id,first.c.runId,'ligne non modifiée : ancienne tentative');
 // Filtre des lecteurs kpi-funnel-live, ad-funnel, booking-results et visual-journey-analytics : is_current, published_at,
 // run_id parmi les tentatives complètes, mapping_profile = dernier profil publié de l'espace et de la famille.
 const selected=(await db.query(`WITH complete AS (SELECT * FROM sync_runs WHERE status IN ('complete','empty') AND pagination_complete AND rows_rejected=0),
  latest AS (SELECT DISTINCT ON (source_namespace,stream_key) source_namespace,replace(stream_key,'lead_entries_','') family,query_profile_key FROM complete WHERE stream_key LIKE 'lead_entries_%' ORDER BY source_namespace,stream_key,finished_at DESC,id DESC)
  SELECT o.external_id FROM lead_source_observations o JOIN complete r ON r.id=o.run_id JOIN latest l ON l.source_namespace=o.source_namespace AND l.family=o.family AND l.query_profile_key=o.mapping_profile
  WHERE o.is_current AND o.published_at IS NOT NULL ORDER BY o.external_id`)).rows.map(row=>row.external_id);
 assert.deepEqual(selected,[a.externalId,b.externalId].sort());
 assert.equal((await rollup()).requestCount,2);
 const v2=(await db.query("SELECT cockpit_lead_entry_rollup_v2('site','crm','clients','2026-01-01','2027-01-01',$1) r",[JSON.stringify({forms:{profile:'synthetic-v1',containerIds:['synthetic-form']}})])).rows[0].r;assert.equal(v2.requestCount,2);
});

test('droits : table des changements refusée à anon et authenticated, RLS active, aucune colonne properties',async()=>{
 const rights=await one(`SELECT has_table_privilege('anon','lead_source_observation_changes','SELECT') anon_select,has_table_privilege('anon','lead_source_observation_changes','INSERT') anon_insert,
  has_table_privilege('authenticated','lead_source_observation_changes','SELECT') authenticated_select,has_table_privilege('authenticated','lead_source_observation_changes','UPDATE') authenticated_update,
  has_table_privilege('service_role','lead_source_observation_changes','SELECT') service_select,(SELECT relrowsecurity FROM pg_class WHERE oid='public.lead_source_observation_changes'::regclass) rls`);
 assert.deepEqual(rights,{anon_select:false,anon_insert:false,authenticated_select:false,authenticated_update:false,service_select:true,rls:true});
 for(const role of ['anon','authenticated']){await db.query('SAVEPOINT role');await db.query(`SET LOCAL ROLE ${role}`);await assert.rejects(()=>db.query('SELECT count(*) FROM lead_source_observation_changes'),{code:'42501'});await db.query('ROLLBACK TO role');}
 assert.equal(Number((await one("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='lead_source_observation_changes' AND column_name='properties'")).n),0);
 const publishRights=await one("SELECT has_function_privilege('anon','cockpit_publish_lead_entries(uuid,uuid)','execute') anon,has_function_privilege('authenticated','cockpit_publish_lead_entries(uuid,uuid)','execute') authenticated,has_function_privilege('service_role','cockpit_publish_lead_entries(uuid,uuid)','execute') service");
 assert.deepEqual(publishRights,{anon:false,authenticated:false,service:true});
});

test('retour arrière : corps 018 réappliqué, lignes mises à jour en place lues par l’ancien code, puis 020 réappliquée',async()=>{
 const text=fs.readFileSync(MIGRATION_020,'utf8');
 const block=text.slice(text.indexOf('-- RETOUR ARRIERE 020 DEBUT'),text.indexOf('-- RETOUR ARRIERE 020 FIN')).split('\n').slice(1).map(line=>line.replace(/^-- ?/,'')).join('\n');
 const a=record(),b=record(randomUUID(),'b'.repeat(64));await collect([a,b]);const modified=rehash(a,{sourceUpdatedAt:'2026-08-02T00:00:00Z',sourceStatus:'CANCELED'});await collect([modified,b]);
 const inPlace=await currentRow(a.externalId);
 await db.query(block);assert.equal(Number((await one('SELECT count(*)::int n FROM cockpit_migrations WHERE version=20')).n),0);
 assert.equal((await rollup()).requestCount,2,'lignes mises à jour en place lisibles après retour arrière');
 // Ancien code (018) : une nouvelle modification conserve une version d'audit, aucune trace écrite.
 const old=await collect([rehash(modified,{sourceUpdatedAt:'2026-08-03T00:00:00Z'}),b]);assert.equal(old.result.status,'complete');assert.equal(old.result.counts.events,undefined);
 assert.equal(await total(),3);assert.equal((await changes()).length,1);assert.equal((await rollup()).requestCount,2);
 assert.equal((await db.query('SELECT is_current FROM lead_source_observations WHERE id=$1',[inPlace.id])).rows[0].is_current,false);
 // 020 réappliquée (sans BEGIN/COMMIT, dans la transaction du test) : de nouveau en place.
 await db.query(text.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));assert.equal(Number((await one('SELECT count(*)::int n FROM cockpit_migrations WHERE version=20')).n),1);
 const again=await collect([rehash(modified,{sourceUpdatedAt:'2026-08-04T00:00:00Z'}),b]);assert.equal(again.result.counts.events,1);assert.equal(await total(),3);assert.equal((await rollup()).requestCount,2);
});

test('lecteurs réels (kpi-funnel-live, ad-funnel, booking-results, visual-journey-analytics) et migration 020 rejouable, sur une base dédiée',async()=>{
 const readerName='lead_readers_'+Date.now(),readerUrl=new URL(base);readerUrl.pathname='/'+readerName;
 await admin.query(`CREATE DATABASE ${readerName}`);const sql=new Client({connectionString:readerUrl.href});await sql.connect();
 const originalFetch=globalThis.fetch;globalThis.fetch=(async()=>{throw Error('NO_NETWORK_IN_TESTS');}) as typeof fetch;
 try{
  for(const f of fs.readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort())await sql.query(fs.readFileSync('supabase/migrations/'+f,'utf8'));
  // Rejouable : seconde application complète (BEGIN/COMMIT du fichier), aucune erreur, version inscrite une fois.
  await sql.query(fs.readFileSync(MIGRATION_020,'utf8'));
  assert.equal((await sql.query('SELECT count(*)::int n FROM cockpit_migrations WHERE version=20')).rows[0].n,1);
  const site='site-lecteurs',raw=JSON.stringify({formIds:[VISUAL_JOURNEY_FORM_ID]}),profile=leadEntryProfile('forms',wixLeadEntryConfig(raw)!),env={NODE_ENV:'test',WIX_SITE_ID:site,WIX_LEAD_ENTRY_CONFIG:raw} as NodeJS.ProcessEnv;
  const entry=(id:string,identity:string,ad:string)=>rehash({source:'wix',sourceNamespace:site,family:'forms',externalId:id,containerId:VISUAL_JOURNEY_FORM_ID,contactId:null,sourceStatus:'CONFIRMED',identityKey:identity,occurredAt:'2026-09-10T08:00:00Z',sourceUpdatedAt:'2026-09-10T08:00:00Z',eligible:true,properties:{dateBasis:'submission_created',origin:{ad,campaign:'1201',source:'fb'}}});
  const collectHere=async(rows:unknown[])=>{
   const c=(await sql.query('SELECT cockpit_claim_lead_entries($1,$2,$3) r',[site,'forms',profile])).rows[0].r as Claim;
   await sql.query('SELECT cockpit_stage_lead_entries($1,$2,0,$3,NULL,true,$4,0)',[c.runId,c.lease,JSON.stringify(rows),rows.length]);
   return {c,result:(await sql.query('SELECT cockpit_publish_lead_entries($1,$2) r',[c.runId,c.lease])).rows[0].r};
  };
  const reader=postgresDatabase(readerUrl.href),now=new Date().toISOString(),day='2026-09-10';
  const reads=async()=>{
   const kpi=await readLiveKpiFunnel(reader,{from:day,to:day,source:'all',tunnel:'all',campaign:'',compare:false},{env,now});
   const funnel=await buildAdFunnel(reader,{from:day,to:day,tunnel:'all'},{env,visits:null,now});
   const booking=await buildBookingResults(reader,{from:day,to:day,tunnel:'all'},{env,now});
   const journey=await readVisualJourneyReport(reader,{from:day,to:day,source:'all',campaign:'',includeTests:false,wixSiteId:site,syncEnv:env,now:()=>now,log:()=>{}} as Parameters<typeof readVisualJourneyReport>[1]);
   return {kpi,funnel,booking,journey};
  };
  const a=entry('reader-a','a'.repeat(64),'120200000000000011'),b=entry('reader-b','b'.repeat(64),'120200000000000012');const first=await collectHere([a,b]);
  // Réservation explicite (Notion) de la personne de l'inscription a : booking-results l'attribue par l'origine de l'inscription publiée.
  const personA=(await sql.query("SELECT person_id FROM lead_source_observations WHERE external_id='reader-a'")).rows[0].person_id;
  await sql.query("INSERT INTO prospects(source,source_namespace,external_id,person_id,connector_version,mapping_version,business) VALUES('notion','crm-lecteurs','prospect-reader-a',$1,'synthetic','synthetic',$2)",[personA,JSON.stringify({dates:{booked:day}})]);
  const before=await reads();
  const second=await collectHere([rehash(a,{sourceUpdatedAt:'2026-09-11T08:00:00Z',contactId:'contact-2'}),b]);
  assert.equal(second.result.counts.events,1);
  const rows=(await sql.query('SELECT external_id,run_id FROM lead_source_observations WHERE source_namespace=$1 ORDER BY external_id',[site])).rows;
  assert.deepEqual(rows,[{external_id:'reader-a',run_id:second.c.runId},{external_id:'reader-b',run_id:first.c.runId}],'deux lignes : a en place (tentative 2), b non préparée (tentative 1)');
  const after=await reads();
  console.log('READERS '+JSON.stringify({before:summary(before),after:summary(after)}));
  // Les quatre lecteurs lisent les deux inscriptions, avant et après la mise à jour en place, à l'identique.
  assert.deepEqual(summary(after),summary(before));
  assert.deepEqual(summary(after).kpi,[2]);assert.equal(summary(after).funnel,2);assert.equal(summary(after).signup,2);assert.equal(summary(after).registered,2);
  assert.deepEqual(summary(after).booking.map((row:any)=>row.attributionKey),['ad:120200000000000011'],'réservation attribuée par l’origine de l’inscription mise à jour en place');
 }finally{globalThis.fetch=originalFetch;await sql.end();await new Promise(resolve=>setTimeout(resolve,5500));await admin.query(`DROP DATABASE IF EXISTS ${readerName}`);}
});
function summary(r:any){return {kpi:r.kpi.status==='ready'?r.kpi.snapshot.daily.map((d:any)=>d.wix_form_submission_occurrences):r.kpi.status,funnel:r.funnel.totals?.registrations,funnelRows:r.funnel.rows.map((row:any)=>[row.key,row.registrations]),booking:r.booking.rows.map((row:any)=>({id:row.id,attributionKey:row.attributionKey,source:row.source,reservedInPeriod:row.reservedInPeriod})),signup:r.journey.stages.find((stage:any)=>stage.id==='signup')?.count,registered:r.journey.form.registered.count};}
