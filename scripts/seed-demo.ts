import { Client } from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { makeRevision } from '../src/lib/links';
import { getConfig } from '../src/lib/config';
import { Temporal } from '@js-temporal/polyfill';
process.loadEnvFile('.env.local');
const cfg=getConfig();if(cfg.mode!=='demo')throw new Error('LOCAL_DEMO_ONLY');
const db=new Client({connectionString:cfg.databaseUrl});await db.connect();
const existing=await db.query('SELECT count(*) FROM public.people');if(Number(existing.rows[0].count)){console.log('Données synthétiques déjà présentes, conservées.');await db.end();process.exit(0);}
const now=new Date().toISOString(),today=Temporal.Now.plainDateISO('Europe/Paris'),start=today.with({day:1});
const day=(i:number)=>start.add({days:i}).toString();const stamp=(i:number)=>day(i)+'T10:00:00.000Z';
await db.query('BEGIN');
try {
 const organic=makeRevision({placement:'instagram_bio',destination:'quiz',campaign:'Rentrée · démo',label:'Bio Instagram · test'});
 const paid=makeRevision({placement:'meta_ad',destination:'masterclass',campaign:'Rentrée · démo',label:'Publicité masterclass · test'});
 for(const r of [organic,paid])await db.query('SELECT save_tracked_link($1,$2,0)',[r.link_id,JSON.stringify(r)]);
 const metaRun=(await db.query("SELECT begin_sync('meta','demo-meta-account',$1,$2,'v23.0-ad-day-none','aggregate_period',$3,$4) AS id",[stamp(0),today.add({days:1}).toString()+'T00:00:00Z',day(0),today.add({days:1}).toString()])).rows[0].id;
 const records=[];
 for(let i=0;i<Math.min(today.day,14);i++)records.push({source:'meta',accountId:'demo-meta-account',externalId:`9001:${day(i)}`,adId:'9001',adName:'Annonce de démonstration',adsetId:'8001',campaignId:'7001',campaignName:'Acquisition · démo',date:day(i),currency:'EUR',timezone:'Europe/Paris',spendMinor:3600+i*173,impressions:1800+i*310,outboundClicks:46+i*7,reportedConversions:[],connectorVersion:'synthetic-v1',observedAt:now});
 await db.query('SELECT import_meta_page($1,$2,NULL)',[metaRun,JSON.stringify(records)]);await db.query("SELECT finish_sync($1,'complete',$2,0,true,NULL)",[metaRun,records.length]);
 const notionRun=(await db.query("SELECT begin_sync('notion','demo-notion',$1,$2,'notion-commercial-v1','source_snapshot') AS id",['1970-01-01T00:00:00Z',now])).rows[0].id;
 const prospectRecords=[];
 for(let i=0;i<12;i++)prospectRecords.push({source:'notion',accountId:'demo-notion',externalId:randomUUID(),personId:null,name:`Prospect démo ${String(i+1).padStart(2,'0')}`,status:['À contacter','RDV prévu','À relancer','Closé'][i%4],responsible:[i%2?'Responsable B · test':'Responsable A · test'],closer:[],appointmentAt:stamp(i%today.day),nextFollowUpAt:today.add({days:i%5+1}).toString(),appointmentStatus:'unknown',archived:false,notionUrl:null,mappingVersion:'synthetic-v1',connectorVersion:'synthetic-v1',observedAt:now,sourceUpdatedAt:now});
 await db.query('SELECT import_notion_page($1,$2,NULL)',[notionRun,JSON.stringify(prospectRecords)]);await db.query("SELECT finish_sync($1,'complete',12,0,true,NULL)",[notionRun]);
 const people:string[]=[];
 for(let i=0;i<14;i++){
  const emailKey=createHash('sha256').update('test-only-person-'+(i%12)).digest('hex');
  const tunnel=i%3?'quiz':'masterclass',link=tunnel==='quiz'?organic:paid;
  const journey=randomUUID(),session=randomUUID(),anonymous=randomUUID(),event=randomUUID();
  const lead={event_id:event,source:'first_party',source_account_id:'demo-backend',external_id:`registration-${i}`,identity:{namespace:'demo',external_id:`person-${i%12}`,email_hmac:emailKey},tunnel,registered_at:stamp(i%today.day),journey_id:journey,anonymous_id:anonymous,session_id:session,link_revision_id:link.id};
  await db.query('SELECT register_lead($1,$2)',[JSON.stringify(lead),createHash('sha256').update(JSON.stringify(lead)).digest('hex')]);
  const person=(await db.query("SELECT person_id FROM lead_registrations WHERE source_namespace='demo-backend' AND external_id=$1",[`registration-${i}`])).rows[0].person_id;people.push(person);
  const names=tunnel==='quiz'?['landing_arrival','quiz_started','quiz_completed','result_viewed']:['landing_arrival','video_started','bilan_clicked'];
  for(const name of names){const ev={event_id:randomUUID(),schema_version:1,occurred_at:stamp(i%today.day),anonymous_id:anonymous,session_id:session,journey_id:journey,tunnel,link_revision_id:link.id,page_version:'demo-v1',event_name:name,properties:name==='video_started'?{video_id:'demo-video',video_version:'demo-v1',playback_id:randomUUID()}:name==='quiz_completed'?{answered_count:12}:{}};await db.query('SELECT ingest_browser_event($1,$2)',[JSON.stringify(ev),createHash('sha256').update(JSON.stringify(ev)).digest('hex')]);}
 }
 for(let i=0;i<6;i++){const person=people[i];const attended=i<4;await db.query("INSERT INTO appointments(source,source_namespace,external_id,identity_basis,person_id,scheduled_at,attended_at,status,source_status,attendance_evidence,connector_version) VALUES('first_party','demo-bookings',$1,'stable_booking',$2,$3,$4,$5,$5,$6,'synthetic-v1')",[`appointment-${i}`,person,stamp(i%today.day),attended?stamp(i%today.day):null,attended?'attended':'no_show',attended?'synthetic explicit attendance':null]);}
 for(let i=0;i<3;i++){
  const deal=(await db.query("INSERT INTO deals(source,source_namespace,external_id,person_id,signed_at,status,contracted_minor,currency,currency_exponent,tax_basis,source_locator,connector_version) VALUES('wix','demo-payments',$1,$2,$3,'signed',180000,'EUR',2,'tax_inclusive','synthetic-v1','synthetic-v1') RETURNING id",[`deal-${i}`,people[i],stamp(i%today.day)])).rows[0].id;
  for(let part=0;part<2;part++)await db.query("INSERT INTO payments(source,source_namespace,external_id,person_id,deal_id,kind,status,effective_at,gross_minor,currency,currency_exponent,tax_basis,source_locator,reconciliation_state,installment_id,connector_version) VALUES('wix','demo-payments',$1,$2,$3,'receipt','settled',$4,60000,'EUR',2,'tax_inclusive','synthetic-v1','reconciled',$5,'synthetic-v1')",[`payment-${i}-${part}`,people[i],deal,stamp((i+part)%today.day),String(part)]);
 }
 const original=(await db.query("SELECT id FROM payments WHERE external_id='payment-0-0'")).rows[0].id;
 await db.query("INSERT INTO payments(source,source_namespace,external_id,person_id,kind,status,effective_at,gross_minor,currency,currency_exponent,tax_basis,source_locator,reconciliation_state,original_payment_id,connector_version) VALUES('wix','demo-payments','refund-0',$1,'refund','settled',$2,15000,'EUR',2,'tax_inclusive','synthetic-v1','reconciled',$3,'synthetic-v1')",[people[0],stamp(today.day-1),original]);
 await db.query('COMMIT');console.log('Données synthétiques créées : liens, parcours, prospects, RDV et échéances/remboursement.');
} catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
