import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import fs from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {makeRevision} from '../src/lib/links';
const base=process.env.TEST_DATABASE_URL||'postgresql://localhost:55440/postgres';
const address=new URL(base);if(!['localhost','127.0.0.1','[::1]'].includes(address.hostname))throw new Error('LOCAL_DATABASE_TESTS_ONLY');
const name='cockpit_test_'+Date.now();const admin=new Client({connectionString:base});
const target=new URL(base);target.pathname='/'+name;let db:Client;
before(async()=>{await admin.connect();await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$");await admin.query(`CREATE DATABASE ${name}`);db=new Client({connectionString:target.href});await db.connect();for(const file of fs.readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort())await db.query(fs.readFileSync('supabase/migrations/'+file,'utf8'));});
after(async()=>{await db?.end();await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();});
beforeEach(async()=>{await db.query('BEGIN');});afterEach(async()=>{await db.query('ROLLBACK');});
async function fails(fn:()=>Promise<unknown>,code:string){await db.query('SAVEPOINT expect_failure');try{await assert.rejects(fn,(e:unknown)=>(e as {code:string}).code===code);}finally{await db.query('ROLLBACK TO SAVEPOINT expect_failure');await db.query('RELEASE SAVEPOINT expect_failure');}}
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const linkInput={placement:'instagram_bio' as const,destination:'quiz' as const,campaign:'SQL test',label:'Synthetic test'};
async function link(){const revision=makeRevision(linkInput);await db.query('SELECT save_tracked_link($1,$2,0)',[revision.link_id,JSON.stringify(revision)]);return revision;}
function lead(source='first_party',account='test-account',id=randomUUID(),email='a'.repeat(64)){return {source,source_account_id:account,external_id:id,event_id:randomUUID(),registered_at:'2026-09-01T10:00:00Z',tunnel:'quiz',journey_id:randomUUID(),anonymous_id:randomUUID(),session_id:randomUUID(),link_revision_id:null,identity:{namespace:'contacts',external_id:id,email_hmac:email}};}
async function register(value:ReturnType<typeof lead>){return (await db.query('SELECT register_lead($1,$2) AS result',[JSON.stringify(value),sha(value)])).rows[0].result;}
async function begin(source='meta',ns='test-meta',profile='v23-ad-day-none'){return (await db.query("SELECT begin_sync($1,$2,'2026-09-01T00:00:00Z','2026-09-03T00:00:00Z',$3,$4,'2026-09-01','2026-09-03') AS id",[source,ns,profile,source==='notion'?'source_snapshot':'aggregate_period'])).rows[0].id;}
const meta=(account='test-meta')=>({source:'meta',accountId:account,adId:'90001',adName:'Synthetic ad',adsetId:'80001',campaignId:'70001',campaignName:'Synthetic campaign',date:'2026-09-01',currency:'EUR',timezone:'Europe/Paris',spendMinor:4200,impressions:1000,outboundClicks:20,reportedConversions:[{action:'lead',count:2,window:'7d_click'}],connectorVersion:'test-v1',observedAt:'2026-09-03T12:00:00Z'});
const finish=(run:string,status='complete')=>db.query('SELECT finish_sync($1,$2,1,0,true,NULL)',[run,status]);
async function payment(kind='receipt',amount=60000,original:string|null=null,currency='EUR'){return (await db.query("INSERT INTO payments(source,source_namespace,external_id,kind,status,effective_at,gross_minor,currency,currency_exponent,tax_basis,source_locator,reconciliation_state,original_payment_id,connector_version) VALUES('wix','test-payments',$1,$2,'settled','2026-09-02T10:00Z',$3,$4,2,'tax_inclusive','synthetic','reconciled',$5,'test') RETURNING *",[randomUUID(),kind,amount,currency,original])).rows[0];}

test('migration PostgreSQL17 complète, 22 tables RLS, droits client refusés tables/vues/RPC',async()=>{
 const rows=(await db.query("SELECT relname,relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'")).rows;assert.equal(rows.length,22);assert.ok(rows.every(r=>r.relrowsecurity));
 for(const role of ['anon','authenticated']){await fails(async()=>{await db.query('SET LOCAL ROLE '+role);await db.query('SELECT * FROM people');},'42501');await fails(async()=>{await db.query('SET LOCAL ROLE '+role);await db.query('SELECT * FROM v_cash_movements');},'42501');await fails(async()=>{await db.query('SET LOCAL ROLE '+role);await db.query("SELECT consume_rate_limit($1,1,60)",['b'.repeat(64)]);},'42501');}
 await db.query('SET LOCAL ROLE service_role');assert.equal((await db.query('SELECT count(*) FROM people')).rows[0].count,'0');
});
test('révision atomique, immuable et contrôle de version; archivage conserve URL',async()=>{
 const r=await link();await fails(()=>db.query("UPDATE link_revisions SET label='edited' WHERE id=$1",[r.id]),'55000');
 await db.query('SELECT archive_tracked_link($1,true,1)',[r.link_id]);await fails(()=>db.query('SELECT save_tracked_link($1,$2,1)',[r.link_id,JSON.stringify(makeRevision(linkInput,r.link_id,2))]),'55000');
 await db.query('SELECT archive_tracked_link($1,false,1)',[r.link_id]);await db.query('SELECT save_tracked_link($1,$2,1)',[r.link_id,JSON.stringify(makeRevision(linkInput,r.link_id,2))]);
 assert.equal((await db.query('SELECT generated_url FROM link_revisions WHERE id=$1',[r.id])).rows[0].generated_url,r.generated_url);
 await fails(()=>db.query('SELECT save_tracked_link($1,$2,1)',[r.link_id,JSON.stringify(makeRevision(linkInput,r.link_id,2))]),'40001');
});
test('deux mises à jour concurrentes : une seule nouvelle version',async()=>{
 const r=await link();await db.query('COMMIT');const a=new Client({connectionString:target.href}),b=new Client({connectionString:target.href});await Promise.all([a.connect(),b.connect()]);
 const outcomes=await Promise.allSettled([a.query('SELECT save_tracked_link($1,$2,1)',[r.link_id,JSON.stringify(makeRevision(linkInput,r.link_id,2))]),b.query('SELECT save_tracked_link($1,$2,1)',[r.link_id,JSON.stringify(makeRevision(linkInput,r.link_id,2))])]);
 await Promise.all([a.end(),b.end()]);assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);assert.equal((outcomes.find(o=>o.status==='rejected') as PromiseRejectedResult).reason.code,'40001');await db.query('BEGIN');
});
test('inscriptions canonique : retries, deux tunnels, namespaces, conflit payload et identité ambiguë',async()=>{
 const first=lead();assert.equal((await register(first)).duplicate,false);assert.equal((await register(first)).duplicate,true);
 const second={...lead('wix','other-account'),tunnel:'masterclass'};await register(second);
 assert.equal((await db.query('SELECT count(DISTINCT person_id) FROM lead_registrations')).rows[0].count,'1');assert.equal((await db.query('SELECT count(*) FROM lead_registrations')).rows[0].count,'2');
 await fails(()=>db.query('SELECT register_lead($1,$2)',[JSON.stringify({...first,tunnel:'masterclass'}),sha('changed')]),'23505');
 const outsider=lead('first_party','test-account',randomUUID(),'b'.repeat(64));await register(outsider);
 const conflict={...lead(),identity:{...first.identity,email_hmac:'b'.repeat(64)}};assert.equal((await register(conflict)).resolved,false);
 const unresolved=(await db.query("SELECT count(*) FROM lead_registrations WHERE evidence_state='unresolved' AND person_id IS NULL")).rows[0].count;assert.equal(unresolved,'1');
});
test('ingestion navigateur ne crée ni personne ni inscription, idempotence et conflit',async()=>{
 const e={event_id:randomUUID(),event_name:'landing_arrival',occurred_at:'2026-09-01T10:00Z',anonymous_id:randomUUID(),session_id:randomUUID(),journey_id:randomUUID(),tunnel:'quiz',page_version:'v1',properties:{}};
 await db.query('SELECT ingest_browser_event($1,$2)',[JSON.stringify(e),sha(e)]);await db.query('SELECT ingest_browser_event($1,$2)',[JSON.stringify(e),sha(e)]);
 assert.equal((await db.query('SELECT count(*) FROM events')).rows[0].count,'1');assert.equal((await db.query('SELECT count(*) FROM lead_registrations')).rows[0].count,'0');
 await fails(()=>db.query('SELECT ingest_browser_event($1,$2)',[JSON.stringify({...e,event_name:'lead_registered'}),sha('fake')]),'23505');
 await fails(()=>db.query('SELECT ingest_browser_event($1,$2)',[JSON.stringify({...e,event_id:randomUUID(),event_name:'lead_registered'}),sha('fake-new')]),'23514');
});
test('identité versionnée : aucun intervalle chevauchant et preuve d’affectation immuable',async()=>{
 await register(lead());const identity=(await db.query("SELECT * FROM person_identities WHERE identity_kind='external'")).rows[0];
 await fails(()=>db.query('UPDATE person_identities SET person_id=NULL WHERE id=$1',[identity.id]),'55000');
 await fails(()=>db.query("INSERT INTO person_identities(person_id,source,source_namespace,identity_kind,identity_key,assignment_version,state,evidence) VALUES($1,$2,$3,$4,$5,2,'linked','test')",[identity.person_id,identity.source,identity.source_namespace,identity.identity_kind,identity.identity_key]),'23514');
});
test('paiements, échéances et remboursement tardif : net exact ; anomalie dépassement conservée',async()=>{
 const p=await payment();await payment('receipt',60000);await payment('receipt',60000);await payment('refund',15000,p.id);
 assert.equal((await db.query('SELECT sum(signed_minor) FROM v_cash_movements')).rows[0].sum,'165000');
 const bad=await payment('refund',50000,p.id);assert.equal(bad.reconciliation_state,'anomaly');assert.equal(bad.anomaly_code,'refund_exceeds_receipt');
 const wrong=await payment('refund',100,p.id,'USD');assert.equal(wrong.anomaly_code,'incompatible_original');
 const orphan=await payment('refund',200);assert.equal(orphan.reconciliation_state,'unresolved');
});
test('chaîne RDV : cycle refusé et statut sans preuve ne fournit pas date de présence',async()=>{
 const insert=async()=> (await db.query("INSERT INTO appointments(source,source_namespace,external_id,identity_basis,status,connector_version) VALUES('first_party','test',$1,'stable_booking','unknown','test') RETURNING id",[randomUUID()])).rows[0].id;
 const a=await insert(),b=await insert();await db.query('UPDATE appointments SET supersedes_appointment_id=$1 WHERE id=$2',[a,b]);await fails(()=>db.query('UPDATE appointments SET supersedes_appointment_id=$1 WHERE id=$2',[b,a]),'23514');
 await fails(()=>db.query("UPDATE appointments SET attended_at=now() WHERE id=$1",[a]),'23514');
});
test('Notion : remplacement date reste un emplacement courant, historique idempotent, retard sans écrasement',async()=>{
 const run=await begin('notion','test-notion','commercial');const r={source:'notion',accountId:'test-notion',externalId:randomUUID(),name:'Synthetic prospect',status:'Closé',responsible:['Owner test'],closer:[],appointmentAt:'2026-09-01',nextFollowUpAt:null,archived:false,sourceUpdatedAt:'2026-09-01T10:00Z',observedAt:'2026-09-02T10:00Z',connectorVersion:'test',mappingVersion:'test'};
 await db.query('SELECT import_notion_page($1,$2,NULL)',[run,JSON.stringify([r])]);await db.query('SELECT import_notion_page($1,$2,NULL)',[run,JSON.stringify([r])]);
 await db.query('SELECT import_notion_page($1,$2,NULL)',[run,JSON.stringify([{...r,appointmentAt:'2026-09-04',sourceUpdatedAt:'2026-09-02T10:00Z'}])]);
 await db.query('SELECT import_notion_page($1,$2,NULL)',[run,JSON.stringify([r])]);
 const appt=(await db.query('SELECT * FROM appointments')).rows[0];assert.equal(appt.identity_basis,'notion_current_slot');assert.equal(appt.status,'unknown');assert.equal(appt.attended_at,null);assert.equal(appt.schedule_version,2);
 assert.equal((await db.query('SELECT count(*) FROM appointments')).rows[0].count,'1');assert.equal((await db.query('SELECT count(*) FROM commercial_history')).rows[0].count,'2');assert.equal((await db.query('SELECT count(*) FROM deals')).rows[0].count,'0');
});
test('Meta : page et checkpoint atomiques, lot partiel exclu, dernier lot vide remplace ancien',async()=>{
 const a=await begin();await db.query('SELECT import_meta_page($1,$2,$3)',[a,JSON.stringify([meta()]),'nextpage']);assert.equal((await db.query('SELECT count(*) FROM v_ad_daily')).rows[0].count,'0');await finish(a);
 assert.equal((await db.query('SELECT sum(spend_minor) FROM v_ad_daily')).rows[0].sum,'4200');assert.equal((await db.query('SELECT sum(action_count) FROM v_meta_conversions_daily')).rows[0].sum,'2');
 const b=await begin();await fails(()=>db.query('SELECT import_meta_page($1,$2,$3)',[b,JSON.stringify([meta(),meta('wrong-account')]),'must-not-advance']),'23514');assert.equal((await db.query('SELECT cursor_after FROM sync_runs WHERE id=$1',[b])).rows[0].cursor_after,null);
 await db.query("SELECT finish_sync($1,'partial',1,1,false,'test_failure')",[b]);assert.equal((await db.query('SELECT sum(spend_minor) FROM v_ad_daily')).rows[0].sum,'4200');
 const c=await begin();await db.query("UPDATE sync_runs SET source_as_of=source_as_of+interval '1 second' WHERE id=$1",[c]);await finish(c,'empty');assert.equal((await db.query('SELECT count(*) FROM v_ad_daily')).rows[0].count,'0');assert.equal((await db.query('SELECT count(*) FROM v_meta_conversions_daily')).rows[0].count,'0');assert.equal((await db.query('SELECT absence_means_zero FROM sync_runs WHERE id=$1',[c])).rows[0].absence_means_zero,false);
});
test('limite persistante atomique et fenêtre bornée',async()=>{const key='e'.repeat(64);assert.equal((await db.query('SELECT consume_rate_limit($1,2,60) AS ok',[key])).rows[0].ok,true);assert.equal((await db.query('SELECT consume_rate_limit($1,2,60) AS ok',[key])).rows[0].ok,true);assert.equal((await db.query('SELECT consume_rate_limit($1,2,60) AS ok',[key])).rows[0].ok,false);});
test('correction d’un reçu conserve anomalie si elle rend les remboursements incompatibles',async()=>{
 const p=await payment('receipt',10000);await payment('refund',8000,p.id);await db.query('UPDATE payments SET gross_minor=5000 WHERE id=$1',[p.id]);assert.equal((await db.query('SELECT reconciliation_state FROM payments WHERE id=$1',[p.id])).rows[0].reconciliation_state,'anomaly');
 const reverse=(await db.query("INSERT INTO payments(source,source_namespace,external_id,kind,status,effective_at,gross_minor,currency,currency_exponent,tax_basis,source_locator,reconciliation_state,reversal_direction,connector_version) VALUES('wix','test-payments',$1,'reversal','settled',now(),200,'EUR',2,'tax_inclusive','synthetic','reconciled',1,'test') RETURNING reconciliation_state",[randomUUID()])).rows[0];assert.equal(reverse.reconciliation_state,'unresolved');
});
test('publication d’attribution immuable, y compris transfert vers un autre run',async()=>{
 const value=lead();await register(value);const registration=(await db.query('SELECT id,person_id FROM lead_registrations LIMIT 1')).rows[0];
 const makeRun=async()=> (await db.query("INSERT INTO attribution_runs(calculation_fingerprint,status,code_version,metric_definition_version,identity_cutoff_at,input_cutoff_at,input_manifest,model,lookback_days,observation_horizon_days,cohort_from,cohort_to,cohort_timezone,currency,tax_basis,scope,coverage_summary) VALUES($1,'building','test','test',now(),now(),'{}','last_non_direct',30,90,'2026-01-01','2026-02-01','Europe/Paris','EUR','tax_inclusive','{}','{}') RETURNING id",[randomUUID()])).rows[0].id;
 const a=await makeRun(),b=await makeRun();const result=(await db.query("INSERT INTO attribution_results(attribution_run_id,person_id,target_kind,lead_registration_id,status,person_evidence_refs,mapping_refs,dimensions_snapshot,candidate_evidence_snapshot,target_snapshot,first_customer_proof,input_digest) VALUES($1,$2,'acquisition',$3,'unknown','[]','[]','{}','[]','{}','{}','test') RETURNING id",[a,registration.person_id,registration.id])).rows[0].id;
 await db.query("UPDATE attribution_runs SET status='published',published_at=now() WHERE id=$1",[a]);
 await fails(()=>db.query('UPDATE attribution_results SET attribution_run_id=$1 WHERE id=$2',[b,result]),'55000');await fails(()=>db.query("UPDATE attribution_runs SET input_manifest='{}' WHERE id=$1",[a]),'55000');
});
test('publication attribution atomique : un lien cible invalide annule tout le calcul',async()=>{
 const payload={calculation_fingerprint:randomUUID(),code_version:'test',metric_definition_version:'test',identity_cutoff_at:'2026-06-01T00:00Z',input_cutoff_at:'2026-06-01T00:00Z',input_manifest:{costSnapshotIds:['test']},model:'last_non_direct',lookback_days:30,observation_horizon_days:90,cohort_from:'2026-01-01T00:00Z',cohort_to:'2026-02-01T00:00Z',cohort_timezone:'Europe/Paris',currency:'EUR',scope:{source:'all',tunnel:'all',campaign:''},coverage_summary:{available:false}};
 const bad={id:randomUUID(),person_id:null,target_kind:'acquisition',lead_registration_id:randomUUID(),status:'unknown',person_evidence_refs:[],mapping_refs:[],dimensions_snapshot:{},candidate_evidence_snapshot:[],target_snapshot:{},first_customer_proof:{},input_digest:'test'};
 await fails(()=>db.query('SELECT publish_attribution($1,$2)',[JSON.stringify(payload),JSON.stringify([bad])]),'23503');assert.equal((await db.query('SELECT count(*) FROM attribution_runs')).rows[0].count,'0');
 const success=(await db.query('SELECT publish_attribution($1,$2) AS id',[JSON.stringify(payload),'[]'])).rows[0].id;
 const retry=(await db.query('SELECT publish_attribution($1,$2) AS id',[JSON.stringify(payload),'[]'])).rows[0].id;assert.equal(success,retry);
});

test('PostHog aggregate source uses the existing private import journal and rejects other sources',async()=>{
 const run=await begin('posthog','synthetic-project','posthog-production-aggregates-v1');await finish(run);
 const row=(await db.query('SELECT source,stream_key,status FROM sync_runs WHERE id=$1',[run])).rows[0];
 assert.deepEqual(row,{source:'posthog',stream_key:'aggregates',status:'complete'});
 await fails(()=>begin('unsupported','synthetic-project'), '23514');
});

test('business staging shares backend identity, remains unpublished and restores archived source rows',async()=>{
 const claim=async()=>(await db.query("SELECT cockpit_claim_notion('synthetic-notion','business-v1') AS x")).rows[0].x;
 const row={source:'notion',accountId:'synthetic-notion',externalId:'contact-a',name:'Synthetic',status:'RDV Terminé',responsible:[],closer:[],appointmentAt:'2026-08-10',nextFollowUpAt:null,archived:false,sourceUpdatedAt:'2026-09-01T00:00:00Z',observedAt:'2026-09-08T10:00:00Z',connectorVersion:'test',mappingVersion:'test',business:{identityKey:'c'.repeat(64),acquisitionDay:'2026-08-01',createdAt:'2026-08-01T00:00:00Z',scheduledDay:'2026-08-10',attendance:'show_up',explicitFinished:true}};
 const stage=async(c:{runId:string;lease:string},rows:unknown[],checkpoint:unknown={intervals:[]})=>db.query('SELECT cockpit_stage_notion($1,$2,$3,$4,$5)',[c.runId,c.lease,JSON.stringify(rows),JSON.stringify(checkpoint),rows.length]);
 const publish=async(c:{runId:string;lease:string})=>db.query('SELECT cockpit_publish_notion($1,$2)',[c.runId,c.lease]);
 const roll=async()=>(await db.query("SELECT cockpit_business_rollup('synthetic-notion','2026-01-01','2027-01-01') AS x")).rows[0].x;
 const a=await claim();await stage(a,[row]);assert.equal((await roll()).available,false);assert.equal((await db.query('SELECT count(*) FROM people')).rows[0].count,'1');assert.equal((await db.query('SELECT count(*) FROM lead_registrations')).rows[0].count,'0');
 await register(lead('first_party','synthetic-backend',randomUUID(),'c'.repeat(64)));assert.equal((await db.query('SELECT count(*) FROM people')).rows[0].count,'1');
 await publish(a);assert.equal((await roll()).leads.known,1);
 const b=await claim();await stage(b,[]);await publish(b);assert.equal((await roll()).sourceRows,0);assert.equal((await roll()).leads.known,1);assert.equal((await roll()).leads.archivedRows,1);
 const c=await claim();await stage(c,[row]);await publish(c);assert.equal((await roll()).sourceRows,1);assert.equal((await roll()).leads.archivedRows,0);
 const malformed=await claim();await fails(()=>stage(malformed,[],{}),'23514');assert.equal((await roll()).sourceRows,1);
 assert.equal((await db.query("SELECT cockpit_claim_notion('synthetic-notion','other-profile') AS x")).rows[0].x.busy,true);
});
