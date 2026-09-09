import test,{after,before,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import fs from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';

const base=new URL(process.env.TEST_DATABASE_URL||'postgresql://localhost:55440/postgres');
if(!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw Error('LOCAL_ONLY');
const name='lead_bridge_'+Date.now(),admin=new Client({connectionString:base.href}),target=new URL(base);
target.pathname='/'+name;
let db:Client;

before(async()=>{
 await admin.connect();await admin.query(`CREATE DATABASE ${name}`);
 db=new Client({connectionString:target.href});await db.connect();
 for(const file of fs.readdirSync('supabase/migrations').filter(file=>file.endsWith('.sql')).sort())await db.query(fs.readFileSync('supabase/migrations/'+file,'utf8'));
 await db.query("SET statement_timeout='8s'");
});
after(async()=>{await db?.end();await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();});
beforeEach(()=>db.query('BEGIN'));
afterEach(()=>db.query('ROLLBACK'));

type Claim={runId:string;lease:string};
const scope={forms:{profile:'synthetic-v1',containerIds:['form-included']},client_history:{profile:'synthetic-v1',containerIds:['client-included']}};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function claim(family:'forms'|'client_history',namespace=family==='forms'?'site':'clients'){return (await db.query('SELECT cockpit_claim_lead_entries($1,$2,$3) result',[namespace,family,'synthetic-v1'])).rows[0].result as Claim;}
async function stage(claimed:Claim,records:unknown[]){return (await db.query('SELECT cockpit_stage_lead_entries($1,$2,0,$3,NULL,true,$4,0) result',[claimed.runId,claimed.lease,JSON.stringify(records),records.length])).rows[0].result;}
async function publish(claimed:Claim){return (await db.query('SELECT cockpit_publish_lead_entries($1,$2) result',[claimed.runId,claimed.lease])).rows[0].result;}
async function importRows(family:'forms'|'client_history',records:unknown[],namespace?:string){const claimed=await claim(family,namespace);await stage(claimed,records);return publish(claimed);}
function form(identity:string,occurredAt='2026-06-10T10:00:00Z',containerId='form-included',namespace='site'){
 const value={source:'wix',sourceNamespace:namespace,family:'forms',externalId:randomUUID(),containerId,contactId:null,sourceStatus:'CONFIRMED',identityKey:identity,occurredAt,sourceUpdatedAt:'2026-08-01T00:00:00Z',eligible:true,properties:{dateBasis:'synthetic'}};
 return {...value,payloadHash:digest(value),sourcePayloadHash:digest(value)};
}
function client(identity:string,externalId:string,prospectIds:string[],namespace='clients',occurredAt:string|null=null){
 const value={source:'notion',sourceNamespace:namespace,family:'client_history',externalId,containerId:'client-included',contactId:null,sourceStatus:'current',identityKey:identity,occurredAt,sourceUpdatedAt:'2026-08-01T00:00:00Z',eligible:occurredAt!==null,properties:{dateBasis:occurredAt===null?'unavailable':'synthetic',prospectNamespace:'crm',prospectIds}};
 return {...value,payloadHash:digest(value),sourcePayloadHash:digest(value)};
}
async function prospect(person:string,externalId:string,clientIds:string[],acquisitionDay='2025-04-01',namespace='crm'){
 await db.query("INSERT INTO prospects(source,source_namespace,external_id,person_id,source_updated_at,connector_version,mapping_version,business) VALUES('notion',$1,$2,$3,now(),'synthetic','synthetic',$4)",[namespace,externalId,person,JSON.stringify({clientIds,acquisitionDay})]);
}
async function v2(from='2026-01-01',to='2027-01-01',activeScope:unknown=scope){return (await db.query('SELECT cockpit_lead_entry_rollup_v2($1,$2,$3,$4,$5,$6) result',['site','crm','clients',from,to,JSON.stringify(activeScope)])).rows[0].result;}
async function bridgeFixture(options:{formsFirst?:boolean;acquisitionDay?:string;requestDays?:string[];linked?:boolean;targets?:number;ownProspect?:boolean;clientDay?:string}={}){
 const identity='b'.repeat(64),targetPeople=Array.from({length:options.targets??1},()=>randomUUID()),clientId=randomUUID();
 await db.query('INSERT INTO people(id) SELECT unnest($1::uuid[])',[targetPeople]);
 const externalIds=targetPeople.map(()=>randomUUID());
 for(let index=0;index<targetPeople.length;index++)await prospect(targetPeople[index],externalIds[index],options.linked===false?[]:[clientId],options.acquisitionDay);
 const forms=(options.requestDays??['2026-06-10']).map(day=>form(identity,day+'T10:00:00Z'));
 const history=client(identity,clientId,externalIds,'clients',options.clientDay?options.clientDay+'T00:00:00Z':null);
 if(options.formsFirst===false){await importRows('client_history',[history]);await importRows('forms',forms);}else{await importRows('forms',forms);await importRows('client_history',[history]);}
 const sourcePerson=(await db.query("SELECT person_id FROM lead_source_observations WHERE family='forms' AND identity_key=$1 AND is_current",[identity])).rows[0].person_id as string;
 if(options.ownProspect)await prospect(sourcePerson,randomUUID(),[],'2026-06-09');
 return {identity,sourcePerson,targetPeople,clientId};
}

test('canonical read result is independent from client/forms import order, including a client without a start date',async()=>{
 await bridgeFixture({formsFirst:true});let result=await v2();
 assert.equal(result.firstKnownAcquisitions,0);assert.equal(result.knownBeforePeriod,1);assert.equal(result.peopleWithRequests,1);assert.equal(result.sourceRequestPeople,1);assert.equal(result.requestCount,1);assert.equal(result.reciprocalClientHistoryBridges,1);
 await db.query('ROLLBACK');await db.query('BEGIN');
 await bridgeFixture({formsFirst:false});result=await v2();
 assert.equal(result.firstKnownAcquisitions,0);assert.equal(result.knownBeforePeriod,1);assert.equal(result.peopleWithRequests,1);assert.equal(result.sourceRequestPeople,1);assert.equal(result.requestCount,1);
});

test('a 2025 Prospect and a 2024 Client remain known before the 2026 request in either import order',async()=>{
 await bridgeFixture({formsFirst:true,clientDay:'2024-04-01'});let result=await v2();
 assert.equal(result.firstKnownAcquisitions,0);assert.equal(result.knownBeforePeriod,1);
 await db.query('ROLLBACK');await db.query('BEGIN');
 await bridgeFixture({formsFirst:false,clientDay:'2024-04-01'});result=await v2();
 assert.equal(result.firstKnownAcquisitions,0);assert.equal(result.knownBeforePeriod,1);
});

test('a dated conflicting Client row is canonicalized before client_before',async()=>{
 await bridgeFixture({acquisitionDay:'2026-06-11',clientDay:'2024-04-01'});const result=await v2();
 assert.equal(result.firstKnownAcquisitions,0);assert.equal(result.earlierClientEvidence,1);assert.equal(result.knownBeforePeriod,1);
});

test('same-day and same-year evidence is canonicalized before distinct people and earliest acquisition',async()=>{
 await bridgeFixture({acquisitionDay:'2026-06-10'});const result=await v2();
 assert.equal(result.firstKnownAcquisitions,1);assert.equal(result.peopleWithRequests,1);assert.equal(result.sourceRequestPeople,1);assert.equal(result.requestCount,1);assert.equal(result.reciprocalClientHistoryBridges,1);
});

test('a person with a prior request stays one known-before-period person after canonicalization',async()=>{
 await bridgeFixture({requestDays:['2025-08-10','2026-06-10']});const result=await v2();
 assert.equal(result.firstKnownAcquisitions,0);assert.equal(result.knownBeforePeriod,1);assert.equal(result.peopleWithRequests,1);assert.equal(result.sourceRequestPeople,1);assert.equal(result.requestCount,1);
});

test('a one-way Client relation does not create a read-time bridge',async()=>{
 await bridgeFixture({linked:false});const result=await v2();
 assert.equal(result.firstKnownAcquisitions,1);assert.equal(result.knownBeforePeriod,0);assert.equal(result.reciprocalClientHistoryBridges,0);
});

test('multiple reciprocal targets remain unresolved as a bridge',async()=>{
 await bridgeFixture({targets:2});const result=await v2();
 assert.equal(result.firstKnownAcquisitions,1);assert.equal(result.knownBeforePeriod,0);assert.equal(result.reciprocalClientHistoryBridges,0);
});

test('two source identities pointing to different reciprocal targets do not bridge the shared person',async()=>{
 const sourcePerson=randomUUID(),firstTarget=randomUUID(),secondTarget=randomUUID(),firstIdentity='c'.repeat(64),secondIdentity='d'.repeat(64),firstClient=randomUUID(),secondClient=randomUUID(),firstProspect=randomUUID(),secondProspect=randomUUID();
 await db.query('INSERT INTO people(id) SELECT unnest($1::uuid[])',[[sourcePerson,firstTarget,secondTarget]]);
 await db.query("INSERT INTO person_identities(person_id,source,source_namespace,identity_kind,identity_key,state,evidence) VALUES($1,'identity','blg-email-v1','email_hmac',$2,'linked','synthetic'),($1,'identity','blg-email-v1','email_hmac',$3,'linked','synthetic')",[sourcePerson,firstIdentity,secondIdentity]);
 await prospect(firstTarget,firstProspect,[firstClient]);await prospect(secondTarget,secondProspect,[secondClient]);
 await importRows('forms',[form(firstIdentity),form(secondIdentity)]);
 await importRows('client_history',[client(firstIdentity,firstClient,[firstProspect]),client(secondIdentity,secondClient,[secondProspect])]);
 const result=await v2();
 assert.equal(result.firstKnownAcquisitions,1);assert.equal(result.knownBeforePeriod,0);assert.equal(result.peopleWithRequests,1);assert.equal(result.sourceRequestPeople,1);assert.equal(result.reciprocalClientHistoryBridges,0);
});

test('a source person with another Prospect is never bridged to a linked target',async()=>{
 await bridgeFixture({ownProspect:true});const result=await v2();
 assert.equal(result.firstKnownAcquisitions,1);
 assert.equal(result.knownBeforePeriod,0);
 assert.equal(result.reciprocalClientHistoryBridges,0);
});

test('other namespaces and excluded form containers cannot participate in the bridge or count',async()=>{
 const fixture=await bridgeFixture();
 await importRows('forms',[form(fixture.identity,'2026-06-10T10:00:00Z','form-excluded')]);
 await importRows('forms',[form(fixture.identity,'2026-06-10T10:00:00Z','form-included','other-site')],'other-site');
 const otherClient=client(fixture.identity,randomUUID(),[randomUUID()],'other-clients');
 await importRows('client_history',[otherClient],'other-clients');
 const result=await v2();
 assert.equal(result.firstKnownAcquisitions,0);assert.equal(result.requestCount,1);assert.equal(result.sourceRequestPeople,1);assert.equal(result.reciprocalClientHistoryBridges,1);
});

test('v2 is a stable security-invoker, service-role-only reader',async()=>{
 const result=(await db.query("SELECT has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('authenticated',p.oid,'execute') authenticated,has_function_privilege('service_role',p.oid,'execute') service_role,p.provolatile,p.prosecdef FROM pg_proc p WHERE p.oid='cockpit_lead_entry_rollup_v2(text,text,text,date,date,jsonb)'::regprocedure")).rows[0];
 assert.equal(result.anon,false);assert.equal(result.authenticated,false);assert.equal(result.service_role,true);assert.equal(result.provolatile,'s');assert.equal(result.prosecdef,false);
});
