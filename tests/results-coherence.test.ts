import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAdFunnel} from '../src/lib/ad-funnel';
import {resultsDetails,applyResultsAcquisition} from '../src/lib/results-details';
import {buildDashboard,dashboardDetails} from '../src/lib/dashboard';
import {appointmentBooking,appointmentOutcome,isEffectiveAppointment,isUpcomingAppointment} from '../src/lib/appointment-semantics';
import {reconcileAcquisitionPeople} from '../src/lib/results-acquisition';
import type {DashboardFilters} from '../src/lib/ui-contract';
import type {Database,Row,TableName} from '../src/lib/db';

const AD='120200000000000111',B='120200000000000222',LINK='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const NOW='2026-09-19T12:00:00Z',env={WIX_SITE_ID:'site',NOTION_DATA_SOURCE_ID:'notion',NOTION_CLIENT_DATA_SOURCE_ID:'clients'};
const filters={from:'2026-09-01',to:'2026-09-18',source:'all' as const,tunnel:'all' as const,campaign:'',compare:false};
const observation=(id:string,person:string|null,at='2026-09-10T10:00:00Z',extra:Row={}):Row=>({id,external_id:id,family:'forms',source:'wix',source_namespace:'site',is_current:true,published_at:NOW,eligible:true,person_id:person,identity_state:person?'linked':'unresolved',occurred_at:at,occurred_day:at.slice(0,10),properties:{origin:{ad:AD,source:'fb'}},...extra});
const prospect=(id:string,person:string|null,business:Row={}):Row=>({id,external_id:id,source:'notion',source_namespace:'notion',person_id:person,business,archived:false});
const appointment=(id:string,prospect_id:string,extra:Row={}):Row=>({id,source:'notion',source_namespace:'notion',identity_basis:'notion_current_slot',prospect_id,scheduled_day:'2026-09-15',status:'unknown',...extra});
function fixture(extra:Partial<Record<TableName,Row[]>>={}){
 const tables:Partial<Record<TableName,Row[]>>={
  lead_source_observations:[],prospects:[],appointments:[],ads:[{id:'ad-db',external_id:AD,ad_name:'Annonce A',campaign_id:'120200000000000333'}],
  link_revisions:[{id:LINK,label:'Premier lien',campaign:'first',medium:'paid_social'},{id:OTHER,label:'Autre lien',campaign:'other',medium:'organic_social'}],
  sync_runs:[{id:'notion-read',source:'notion',source_namespace:'notion',stream_key:'prospects_business',status:'complete',pagination_complete:true,rows_rejected:0,started_at:NOW,finished_at:NOW,covered_to:NOW}],
  v_ad_daily:[{id:'day',ad_id:'ad-db',date:'2026-09-10',spend_minor:1234,impressions:100,outbound_clicks:7,currency:'EUR',currency_exponent:2,timezone:'Europe/Paris'}],...extra,
 };
 const calls:string[]=[];
 const db:Database={async select(table,options={}){
  calls.push(table);let rows=tables[table]??[];
  for(const [key,value] of Object.entries(options.eq??{}))rows=rows.filter(row=>String(row[key])===value);
  for(const [key,value] of Object.entries(options.gte??{}))rows=rows.filter(row=>String(row[key])>=value);
  for(const [key,value] of Object.entries(options.lt??{}))rows=rows.filter(row=>String(row[key])<value);
  for(const [key,value] of Object.entries(options.in??{}))rows=rows.filter(row=>value.includes(String(row[key])));
  rows=rows.slice(options.from??0,(options.from??0)+(options.limit??1000));
  return options.columns?rows.map(row=>Object.fromEntries(options.columns!.map(key=>[key,row[key]]))):rows;
 },async upsert(){assert.fail('No mutation');},async rpc(){assert.fail('No distant source/RPC');},async probe(){assert.fail();}};
 return {db,tables,calls};
}
const report=async(db:Database,scope:Partial<DashboardFilters>={})=>buildAdFunnel(db,{...filters,...scope},{env,now:NOW,includeCommerce:false});

test('Results list, first-contact card and server registrations agree without browser evidence; repeated and known people remain distinct',async()=>{
 const {db}=fixture({lead_source_observations:[observation('one','p1'),observation('repeat','p1'),observation('known','p2'),observation('unknown-source','p3',undefined,{properties:{}}),observation('unresolved',null),observation('test','test',undefined,{properties:{is_test:true,origin:{ad:AD}}})],prospects:[prospect('old','p2',{dates:{legacy:'2026-08-03'}})]});
 const funnel=await report(db),list=resultsDetails(funnel),row=list.details.find(row=>row.id==='ad:'+AD)!;
 assert.equal(row.leads,1);assert.equal(funnel.totals.uniqueLeads,2);assert.equal(funnel.totals.uniqueRegistrants,3);assert.equal(funnel.totals.registrations,5);assert.equal(funnel.totals.unresolvedIdentity,1);
 assert.equal(list.details.find(row=>row.id==='__unattributed__')?.leads,1);assert.match(row.coverage,/4 inscriptions confirmées/);
 const response=buildDashboard({leads:[],events:[],payments:[],appointments:[],deals:[],ads:[],revisions:[],runs:[],aggregates:[]},filters,'live');applyResultsAcquisition(response,funnel);
 assert.equal(response.metrics.find(m=>m.id==='leads')?.value,2);assert.equal(response.journeys.find(j=>j.id==='masterclass')?.steps.find(s=>s.id==='server-registrations')?.value,5);
 assert.deepEqual(await dashboardDetails(db,filters,0,funnel),list);
});

test('origin A before the period keeps the return via B; a link filter never selects another link on the same ad',async()=>{
 const {db}=fixture({lead_source_observations:[
  observation('old','p1','2026-08-20T08:00:00Z',{properties:{origin:{ad:AD,linkId:LINK}}}),
  observation('return','p1',undefined,{properties:{origin:{ad:B,linkId:OTHER},firstTouch:{ad:AD,linkId:LINK,at:'2026-08-20T07:00:00Z'}}}),
  observation('other','p2',undefined,{properties:{origin:{ad:AD,linkId:OTHER}}}),
 ]});
 const first=await report(db,{campaign:'link:first'});assert.equal(first.totals.registrations,1);assert.equal(first.totals.uniqueLeads,0);assert.equal(first.totals.spendMinor,null);assert.equal(first.linkDetails?.find(row=>row.key==='link:'+LINK)?.registrations,1);assert.equal(first.linkDetails?.find(row=>row.key==='link:'+LINK)?.uniqueLeads,0);
 const other=await report(db,{campaign:'link:other'});assert.equal(other.totals.registrations,1);assert.equal(other.totals.uniqueLeads,1);
 const byAd=await report(db,{campaign:'meta-ad:'+AD});assert.equal(byAd.totals.registrations,2);assert.equal(byAd.totals.uniqueLeads,1);
 assert.equal((await report(db,{campaign:'meta-ad:Annonce A'})).totals.registrations,0);
});

test('organic links remain organic, unknown origins remain in unknown, and a new ad ID works before catalogue import',async()=>{
 const {db}=fixture({lead_source_observations:[observation('organic','p1',undefined,{properties:{origin:{linkId:OTHER,source:'ig',medium:'organic_social'}}}),observation('none','p2',undefined,{properties:{}}),observation('new','p3',undefined,{properties:{origin:{ad:B}}})]});
 assert.equal((await report(db,{source:'organic'})).totals.uniqueLeads,1);assert.equal((await report(db,{source:'unknown'})).totals.uniqueLeads,1);
 const newId=await report(db,{campaign:'meta-ad:'+B});assert.equal(newId.totals.uniqueLeads,1);assert.match(newId.rows[0].label,/hors catalogue/);assert.equal(newId.totals.spendMinor,null);
});

test('reciprocal Client/Prospect bridge reuses confirmed identity and history; missing reciprocity and conflicting targets never merge',async()=>{
 const request=observation('entry','source-person',undefined,{identity_key:'synthetic-hmac'});
 const client=observation('client','source-person','2026-08-01T08:00:00Z',{source:'notion',source_namespace:'clients',family:'client_history',identity_key:'synthetic-hmac',properties:{prospectNamespace:'notion',prospectIds:['target']}});
 const target=prospect('target','target-person',{clientIds:['client'],dates:{legacy:'2026-07-02'}});
 assert.equal(reconcileAcquisitionPeople([request,client],[target],'notion')[0].person_id,'target-person');
 const funnel=await report(fixture({lead_source_observations:[request,client],prospects:[target]}).db);assert.equal(funnel.totals.uniqueLeads,0);assert.equal(funnel.totals.uniqueRegistrants,1);
 assert.equal(reconcileAcquisitionPeople([request,client],[{...target,business:{}}],'notion')[0].person_id,'source-person');
 const other=prospect('other','other-person',{clientIds:['client']});const ambiguous={...client,properties:{prospectNamespace:'notion',prospectIds:['target','other']}};
 assert.equal(reconcileAcquisitionPeople([request,ambiguous],[target,other],'notion')[0].person_id,'source-person');
});

test('Notion-only first contacts stay unattributed; archived prior evidence prevents a new lead and unchanged rows are not tied to latest run',async()=>{
 const {db}=fixture({lead_source_observations:[observation('repeat','old')],prospects:[{...prospect('old-record','old',{dates:{real:'2025-01-01'}}),archived:true,sync_run_id:'older-run'},prospect('new-record','notion-only',{acquisitionDay:'2026-09-10'})]});
 const result=await report(db);assert.equal(result.totals.uniqueLeads,1);assert.equal(result.rows.find(row=>row.key==='__unattributed__')?.uniqueLeads,1);assert.equal(result.rows.find(row=>row.adId===AD)?.uniqueLeads,0);
});

test('Paris midnight and repeat timestamps use the instant, not the stale UTC occurred_day',async()=>{
 const {db}=fixture({lead_source_observations:[observation('before','p1','2026-08-31T21:59:59.999Z'),observation('inside','p2','2026-08-31T22:00:00Z'),observation('after','p3','2026-09-01T22:00:00Z')]});
 const result=await report(db,{from:'2026-09-01',to:'2026-09-01'});assert.equal(result.totals.registrations,1);assert.equal(result.totals.uniqueLeads,1);
});

test('booking day, call day, attendance, cancellation and rescheduling stay distinct; no click or Meta event creates a booking',async()=>{
 const people=['attended','cancelled','rescheduled','noshow','future','undated'];
 const appointments=people.map(p=>appointment(p,p,p==='future'?{scheduled_at:'2026-09-20T08:00:00Z',scheduled_day:null}:p==='undated'?{scheduled_day:null}:{}));
 const prospects=people.map(p=>prospect(p,p,{scheduledDay:p==='future'?'2026-09-20':'2026-09-15',bookedDay:'2026-09-10',dates:{booked:'2026-09-10'},attendance:p==='attended'?'show_up':p==='noshow'?'no_show':p==='cancelled'?'cancelled':'unknown'}));
 appointments.find(a=>a.id==='rescheduled')!.status='rescheduled';
 const {db}=fixture({lead_source_observations:people.map(p=>observation(p,p)),appointments,prospects,events:[{event_name:'booking_clicked'},{event_name:'invitee_meeting_scheduled'}]});
 const result=await report(db);assert.equal(result.totals.appointmentsReserved,6);assert.equal(result.totals.appointmentsAttended,1);assert.equal(result.totals.appointmentsNoShow,1);assert.equal(result.totals.appointmentsCancelled,1);assert.equal(result.totals.appointmentsRescheduled,1);assert.equal(result.totals.appointmentsBooked,2);assert.equal(result.totals.leadsBooked,3);assert.equal(result.totals.rates.attendance.value,.5);
 assert.equal(result.coverage.appointments.bookingInstants,0);
});

test('explicit booking date supports deferred/email bookings but neither edit metadata nor date-only values prove same-visit sequencing',()=>{
 const a=appointment('one','p');
 assert.deepEqual(appointmentBooking(a,{scheduledDay:'2026-09-15',bookedDay:'2026-09-10',dates:{booked:'2026-09-10'}}),{at:null,day:'2026-09-10'});
 assert.deepEqual(appointmentBooking({...a,source_updated_at:NOW,last_edited_by:'bot'},null),{at:null,day:null});
 assert.equal(appointmentBooking(a,{scheduledDay:'2026-09-15',dates:{booked:'2026-09-09T23:00:00Z'}}).day,'2026-09-10');
 assert.equal(appointmentOutcome(a,{scheduledDay:'2026-09-16',attendance:'show_up'}),'unknown');
 assert.equal(isEffectiveAppointment({...a,scheduled_day:null},null),false);
 assert.equal(appointmentOutcome({...a,source_status:'RDV Reporté'},null),'rescheduled');
 assert.equal(isUpcomingAppointment({...a,scheduled_at:'2026-09-19T09:00:00Z'},NOW),false);
});

test('missing/stale Notion does not produce zero; a complete empty mirror does; explicit tests and archived current slots are excluded',async()=>{
 const one=observation('one','p1');
 const stale=fixture({lead_source_observations:[one],sync_runs:[]});const missing=await report(stale.db);
 assert.equal(resultsDetails(missing).details[0].appointments,null);assert.equal(missing.totals.rates.booking.value,null);
 const complete=await report(fixture({lead_source_observations:[one]}).db);assert.equal(resultsDetails(complete).details[0].appointments,0);
 const excluded=await report(fixture({lead_source_observations:[one,observation('test','test',undefined,{properties:{is_test:true}})],prospects:[{...prospect('p1','p1',{scheduledDay:'2026-09-15',attendance:'show_up'}),archived:true},prospect('test','test',{scheduledDay:'2026-09-15',attendance:'show_up'})],appointments:[appointment('old','p1'),appointment('test','test')]}).db);
 assert.equal(excluded.totals.appointmentsAttended,0);assert.equal(excluded.coverage.testing.appointmentsExcluded,1);
});

test('zero spend is measured only with compatible currency/timezone; missing partitions remain unknown',async()=>{
 const base=fixture({lead_source_observations:[observation('one','p1')]});base.tables.v_ad_daily![0].spend_minor=0;
 assert.equal(resultsDetails(await report(base.db)).details[0].spend,0);
 base.tables.v_ad_daily![0].currency='USD';assert.equal(resultsDetails(await report(base.db)).details[0].spend,null);
 base.tables.v_ad_daily=[];assert.equal(resultsDetails(await report(base.db)).details[0].spend,null);
});

test('published empty leads differ from an uninitialized source; unfinished profile observations cannot enter totals',async()=>{
 const source=fixture({lead_source_observations:[observation('unpublished','p1',undefined,{run_id:'running',mapping_profile:'profile'})]});assert.equal((await report(source.db)).available,false);
 source.tables.sync_runs!.push({id:'empty',source:'wix',source_namespace:'site',stream_key:'lead_entries_forms',status:'empty',pagination_complete:true,rows_rejected:0,finished_at:NOW});
 const empty=await report(source.db);assert.equal(empty.available,true);assert.equal(empty.totals.uniqueLeads,0);
});

test('Results pagination is stable, historical and new catalogue options are preserved, and no person or private source fields leave the report',async()=>{
 const ads=Array.from({length:73},(_,i)=>({id:'ad-'+i,external_id:String(BigInt(AD)+BigInt(i)),ad_name:'Annonce '+String(i).padStart(3,'0')}));
 const entries=ads.map((ad,i)=>observation('entry-'+i,'private-person-'+i,undefined,{identity_key:'private-hmac-'+i,properties:{origin:{ad:ad.external_id,visitor:'private-visitor'}}}));
 const {db}=fixture({ads,lead_source_observations:entries,v_ad_daily:[],link_revisions:[]});const result=await report(db),first=resultsDetails(result),second=resultsDetails(result,1);
 assert.equal(first.pagination.total,73);assert.equal(first.details.length,50);assert.equal(second.details.length,23);assert.equal(new Set([...first.details,...second.details].map(r=>r.id)).size,73);
 assert.equal(result.campaigns?.filter(c=>c.id.startsWith('meta-ad:')).length,73);
 assert.doesNotMatch(JSON.stringify({result,first,second}),/private-person|private-hmac|private-visitor|identity_key|person_id/);
 assert.ok(first.details.every(r=>r.clients===null),'paid sales never substitute for first accompaniments');
});

test('configuration and published mapping select one current family profile; paid origin without ad proof never becomes an ad identity',async()=>{
 const {db,tables}=fixture({lead_source_observations:[
  observation('old-profile','p1',undefined,{run_id:'old',mapping_profile:'old-profile',source_container_id:'form'}),
  observation('current','p1',undefined,{run_id:'current',mapping_profile:'current-profile',source_container_id:'form',properties:{origin:{source:'fb',medium:'paid_social'}}}),
 ]});
 tables.sync_runs!.push(...['old','current'].map((id,i)=>({id,query_profile_key:id+'-profile',source:'wix',source_namespace:'site',stream_key:'lead_entries_forms',status:'complete',pagination_complete:true,rows_rejected:0,finished_at:i?NOW:'2026-09-18T00:00:00Z',covered_to:NOW})));
 const value=await buildAdFunnel(db,filters,{env:{...env,WIX_LEAD_ENTRY_CONFIG:JSON.stringify({formIds:['form']})},now:NOW,includeCommerce:false});
 assert.equal(value.totals.registrations,1);assert.equal(value.totals.uniqueLeads,1);assert.equal(value.rows.find(r=>r.registrations)?.adId,null);assert.equal(value.rows.find(r=>r.registrations)?.source,'paid');
});


test('an explicit Notion reservation date without a current slot counts as booked on that day, never as attendance or a scheduled call',async()=>{
 const {db}=fixture({lead_source_observations:[observation('one','p')],prospects:[prospect('p','p',{bookedDay:'2026-09-12'})]});
 const value=await report(db);assert.equal(value.totals.appointmentsReserved,1);assert.equal(value.totals.appointmentsBooked,0);assert.equal(value.totals.appointmentsAttended,0);assert.equal(value.totals.leadsBooked,0);
});

test('publication after a long Notion scan does not refresh its earlier data cutoff',async()=>{
 const {db}=fixture({lead_source_observations:[observation('one','p')],sync_runs:[{id:'long-scan',source:'notion',source_namespace:'notion',stream_key:'prospects_business',status:'complete',pagination_complete:true,rows_rejected:0,started_at:'2026-09-18T00:00:00Z',period_to:'2026-09-18T00:00:00Z',finished_at:NOW}]});
 const value=await report(db);assert.equal(value.coverage.appointments.available,false);assert.equal(resultsDetails(value).details.find(r=>r.id==='ad:'+AD)?.appointments,null);
});


test('future requested range and late publication cannot make a scan started at 01:00 fresh at noon',async()=>{
 const {db}=fixture({lead_source_observations:[observation('one','p')],sync_runs:[{id:'long',source:'notion',source_namespace:'notion',stream_key:'prospects_business',status:'complete',pagination_complete:true,rows_rejected:0,started_at:'2026-09-19T01:00:00Z',finished_at:'2026-09-19T11:59:00Z',period_to:'2026-09-20T00:00:00Z',covered_to:'2026-09-20T00:00:00Z'}]});
 const value=await report(db,{to:'2026-09-19'});assert.equal(value.coverage.appointments.available,false);assert.equal(value.coverage.leads.complete,false,'one freshly published row cannot establish whole-stream coverage');
});
