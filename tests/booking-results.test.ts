import test from 'node:test';
import assert from 'node:assert/strict';
import type {Database,Row,SelectOptions,TableName} from '../src/lib/db';
import {ORGANIC,UNATTRIBUTED,type AdFunnelReport,type AdFunnelRow} from '../src/lib/ad-funnel';
import {buildBookingResults} from '../src/lib/booking-results';
import {EXCLUDED_TEST_SESSION_IDS} from '../src/lib/traffic-scope';

const AD='120248712470690714',NOW='2026-09-18T12:00:00Z';
const filters={from:'2026-09-01',to:'2026-09-30',tunnel:'all' as const,source:'all' as const,campaign:'',includeTests:false};

const emptyRate={value:null,numerator:0,denominator:0,reason:'fixture'};
function funnelRow(overrides:Partial<AdFunnelRow>):AdFunnelRow{return {
 key:'ad:'+AD,kind:'ad',source:'paid',label:'Annonce C1',campaignLabel:'Masterclass',adId:AD,campaignId:'campaign-1',adsetId:null,creativeId:null,linkIds:[],links:[],tunnels:['masterclass'],
 spendMinor:12000,impressions:100,outboundClicks:10,visitors:{quiz:null,masterclass:null},pageviews:{quiz:null,masterclass:null},visitorsWithFirstOrigin:null,
 optin:{quiz:null,masterclass:null,all:null,unlinkableVisitors:null,registrationsWithoutVisitor:0,registrationsOutsideCohort:0},registrations:0,registrationsByTunnel:{quiz:0,masterclass:0},uniqueRegistrants:0,uniqueLeads:0,uniqueLeadsByTunnel:{quiz:0,masterclass:0},knownBefore:0,unresolvedIdentity:0,leadsBooked:0,
 appointmentsReserved:0,appointmentsBooked:0,appointmentsAttended:0,appointmentsNoShow:0,appointmentsCancelled:0,appointmentsRescheduled:0,appointmentsUpcoming:0,appointmentsUnknown:0,
 firstSalesConfirmed:null,firstSalesReconciled:null,firstSalesPending:null,cashMinor:null,refundsMinor:null,attributionBasis:{firstTouch:0,arrival:0},rates:{optin:emptyRate,booking:emptyRate,attendance:emptyRate},...overrides,
};}
function fixtureFunnel(rows:AdFunnelRow[],totals:Partial<AdFunnelReport['totals']>={}):AdFunnelReport{
 const total=funnelRow({key:'total',adId:null,label:'Total'});const {key:_key,kind:_kind,source:_source,label:_label,campaignLabel:_campaign,adId:_ad,campaignId:_campaignId,adsetId:_adset,creativeId:_creative,linkIds:_links,links:_linkRows,tunnels:_tunnels,...baseTotals}=total;
 return {available:true,period:{from:filters.from,to:filters.to,timezone:'Europe/Paris'},generatedAt:NOW,filters:{tunnel:'all',source:'all',campaign:'',includeTests:false},rows,totals:{...baseTotals,...totals},campaigns:[],linkDetails:[],notices:[],definitions:{},coverage:{
  leads:{available:true,complete:true,observedAt:NOW,families:['forms'],rows:1,withFirstTouch:0,withVisitor:0},meta:{lastDay:'2026-09-18',ads:1,adsWithoutCreative:0},
  appointments:{rows:1,linkedPeople:1,attendanceFromBusiness:1,observedAt:NOW,available:true,reason:null,bookingDates:1,bookingInstants:1},
  commerce:{available:false,reason:null,observedAt:null,paidSaleRows:null,clientsLinked:null,clientsUnlinked:null,moneyRowsUnavailable:null},visits:{available:false,reason:null,observedAt:null,legacyMasterclassViews:null},
  optin:{available:false,reason:null,observedAt:null,entryPeriod:{from:filters.from,to:filters.to},visitorsLinkable:null,visitorsUnlinkable:null,registrationsInCohort:0,registrationsWithoutVisitor:0,registrationsOutsideCohort:0},
  testing:{includeTests:false,registrationsExcluded:0,appointmentsExcluded:0,salesExcluded:0,visitsScoped:true,cohortScoped:true},
 }};
}

function observation(person:string,origin:Row,extra:Row={}):Row{return {id:'obs-'+person,external_id:'entry-'+person,is_current:true,published_at:'2026-09-18T11:00:00Z',eligible:true,family:'forms',person_id:person,identity_state:'linked',occurred_at:'2026-09-02T09:00:00Z',occurred_day:'2026-09-02',source_namespace:'site',properties:{origin},...extra};}
function prospect(id:string,person:string,name:string,business:Row,extra:Row={}):Row{return {id,source:'notion',source_namespace:'notion',person_id:person,display_name:name,source_status:'RDV Programmé',business,archived:false,...extra};}
function appointment(id:string,prospectId:string,day:string,status='unknown',extra:Row={}):Row{return {id,prospect_id:prospectId,source:'notion',source_namespace:'notion',identity_basis:'notion_current_slot',scheduled_at:day+'T10:00:00Z',scheduled_day:day,status,...extra};}

function database(tables:Record<string,Row[]>):Database{return {
 async select(table:TableName,options:SelectOptions={}){
  let rows=[...(tables[table]??[])];
  for(const [key,value] of Object.entries(options.eq??{}))rows=rows.filter(row=>String(row[key])===String(value));
  for(const [key,values] of Object.entries(options.in??{}))rows=rows.filter(row=>values.includes(String(row[key])));
  for(const [key,value] of Object.entries(options.gte??{}))rows=rows.filter(row=>String(row[key])>=value);
  for(const [key,value] of Object.entries(options.lt??{}))rows=rows.filter(row=>String(row[key])<value);
  rows=rows.slice(options.from??0,(options.from??0)+(options.limit??1000));
  return options.columns?rows.map(row=>Object.fromEntries(options.columns!.map(column=>[column,row[column]]))):rows;
 },async upsert(){assert.fail('read only');},async rpc(){assert.fail('no rpc');},async probe(){},
};}
const baseTables=(additions:Partial<Record<string,Row[]>>):Record<string,Row[]>=>({appointments:[],prospects:[],lead_source_observations:[],sync_runs:[],...additions});

test('sépare date de réservation, date du call et issue tout en reprenant le total booked publié',async()=>{
 const paid=funnelRow({appointmentsReserved:3,appointmentsBooked:3,appointmentsAttended:1,appointmentsUpcoming:1,appointmentsCancelled:1,appointmentsRescheduled:1});
 const organic=funnelRow({key:ORGANIC,kind:'organic',source:'organic',label:'Hors publicité',adId:null,campaignId:null,campaignLabel:null,spendMinor:null,appointmentsReserved:1,appointmentsBooked:1,appointmentsUpcoming:1});
 const prospects=[
  prospect('pr-future','p-future','Camille', {scheduledDay:'2026-09-28',bookedDay:'2026-09-10',dates:{booked:'2026-09-10T08:00:00Z'},attendance:'scheduled'}),
  prospect('pr-done','p-done','Alex', {scheduledDay:'2026-09-05',bookedDay:'2026-08-30',dates:{booked:'2026-08-30T08:00:00Z'},attendance:'show_up'}),
  prospect('pr-organic','p-organic','Sam', {scheduledDay:'2026-09-29',bookedDay:'2026-09-11',dates:{booked:'2026-09-11'},attendance:'scheduled'}),
  prospect('pr-cancelled','p-cancelled','Noa', {scheduledDay:'2026-09-20',bookedDay:'2026-09-12',dates:{booked:'2026-09-12'},attendance:'cancelled'},{source_status:'RDV Annulé'}),
  prospect('pr-moved','p-moved','Lou', {scheduledDay:'2026-09-22',bookedDay:'2026-09-13',dates:{booked:'2026-09-13'},attendance:'scheduled'},{source_status:'RDV Reporté'}),
 ];
 const appointments=[appointment('a-future','pr-future','2026-09-28'),appointment('a-done','pr-done','2026-09-05'),appointment('a-organic','pr-organic','2026-09-29'),appointment('a-cancelled','pr-cancelled','2026-09-20','cancelled'),appointment('a-moved','pr-moved','2026-09-22','rescheduled')];
 const observations=[observation('p-future',{ad:AD}),observation('p-done',{ad:AD}),observation('p-organic',{source:'instagram',medium:'organic_social'}),observation('p-cancelled',{ad:AD}),observation('p-moved',{ad:AD})];
 const report=await buildBookingResults(database(baseTables({appointments,prospects,lead_source_observations:observations})),filters,{now:NOW,funnel:fixtureFunnel([paid,organic],{appointmentsReserved:4,appointmentsBooked:3,appointmentsAttended:1,appointmentsUpcoming:2,appointmentsCancelled:1,appointmentsRescheduled:1,spendMinor:12000})});
 assert.equal(report.summary.booked,4,'le compteur reprend appointmentsReserved du moteur Résultats');
 assert.equal(report.summary.attended,1);assert.equal(report.summary.scheduled,2);
 assert.equal(report.rows.length,5);
 const future=report.rows.find(row=>row.id==='a-future')!;assert.equal(future.reservedInPeriod,true);assert.equal(future.scheduledInPeriod,true);assert.equal(future.outcome,'scheduled');assert.equal(future.displayName,'Camille');
 const done=report.rows.find(row=>row.id==='a-done')!;assert.equal(done.reservedInPeriod,false);assert.equal(done.scheduledInPeriod,true);assert.equal(done.outcome,'attended');
 assert.equal(report.rows.find(row=>row.id==='a-cancelled')!.effective,false);assert.equal(report.rows.find(row=>row.id==='a-moved')!.effective,false);
 assert.ok(report.rows.every(row=>!('email' in row)&&!('phone' in row)));
});

test('le prix est une moyenne agrégée publicitaire et exclut organique, annulations et reports',async()=>{
 const paid=funnelRow({spendMinor:12000}),organic=funnelRow({key:ORGANIC,kind:'organic',source:'organic',label:'Organique',adId:null,campaignId:null,campaignLabel:null,spendMinor:null});
 const prospects=[
  prospect('paid-ok','paid-ok','Paid OK',{scheduledDay:'2026-09-28',bookedDay:'2026-09-10',dates:{booked:'2026-09-10'},attendance:'scheduled'}),
  prospect('paid-cancel','paid-cancel','Paid annulé',{scheduledDay:'2026-09-20',bookedDay:'2026-09-11',dates:{booked:'2026-09-11'},attendance:'cancelled'}),
  prospect('organic','organic','Organique',{scheduledDay:'2026-09-21',bookedDay:'2026-09-12',dates:{booked:'2026-09-12'},attendance:'scheduled'}),
 ];
 const appointments=[appointment('ok','paid-ok','2026-09-28'),appointment('cancel','paid-cancel','2026-09-20','cancelled'),appointment('organic','organic','2026-09-21')];
 const observations=[observation('paid-ok',{ad:AD}),observation('paid-cancel',{ad:AD}),observation('organic',{source:'instagram'})];
 const report=await buildBookingResults(database(baseTables({appointments,prospects,lead_source_observations:observations})),filters,{now:NOW,funnel:fixtureFunnel([paid,organic],{spendMinor:12000})});
 assert.deepEqual({spend:report.cost.spendMinor,count:report.cost.eligibleAttributedBookings,average:report.cost.averagePerBookingMinor,reason:report.cost.reason},{spend:12000,count:1,average:12000,reason:null});
 assert.equal(report.cost.byAds[0].averagePerBookingMinor,12000);assert.equal(report.cost.byAds[0].eligibleAttributedBookings,1);
 assert.ok(report.rows.every(row=>!('averagePerBookingMinor' in row)),'aucun prix n’est attaché à une personne');
 const incomplete=await buildBookingResults(database(baseTables({appointments:[appointments[0]],prospects:[prospects[0]],lead_source_observations:[observations[0]]})),filters,{now:NOW,funnel:fixtureFunnel([funnelRow({spendMinor:null})],{spendMinor:null})});
 assert.equal(incomplete.cost.averagePerBookingMinor,null);assert.match(incomplete.cost.reason!,/incomplètes/);
});

test('une couverture périmée conserve personnes et compteurs mais bloque tous les ratios de coût',async()=>{
 const p=prospect('stale','stale','Donnée connue',{scheduledDay:'2026-09-28',bookedDay:'2026-09-10',dates:{booked:'2026-09-10'},attendance:'scheduled'}),stale=fixtureFunnel([funnelRow({spendMinor:9967,appointmentsReserved:1,appointmentsBooked:1,appointmentsUpcoming:1})],{spendMinor:9967,appointmentsReserved:1,appointmentsBooked:1,appointmentsUpcoming:1});
 stale.available=false;stale.coverage.leads.available=false;stale.coverage.leads.complete=false;stale.coverage.appointments.available=false;stale.coverage.appointments.reason='Miroir à actualiser.';
 const report=await buildBookingResults(database(baseTables({prospects:[p],appointments:[appointment('stale','stale','2026-09-28')],lead_source_observations:[observation('stale',{ad:AD})]})),filters,{now:NOW,funnel:stale});
 assert.equal(report.rows.length,1);assert.equal(report.rows[0].displayName,'Donnée connue');assert.equal('personId' in report.rows[0],false);
 assert.equal(report.summary.booked,1);assert.equal(report.cost.spendMinor,9967);assert.equal(report.cost.eligibleAttributedBookings,1);assert.equal(report.cost.averagePerBookingMinor,null);assert.equal(report.cost.reason,'Coût en attente de la mise à jour des rendez-vous.');
 assert.equal(report.cost.byAds[0].averagePerBookingMinor,null);assert.equal(report.cost.byAds[0].reason,'Coût en attente de la mise à jour des rendez-vous.');
});

test('une date de réservation sans ligne de créneau reste visible sans inventer la date du call',async()=>{
 const p=prospect('booking-only','booking-only','Robin',{bookedDay:'2026-09-14',dates:{booked:'2026-09-14T08:30:00Z'},attendance:'unknown'});
 const report=await buildBookingResults(database(baseTables({prospects:[p],lead_source_observations:[observation('booking-only',{ad:AD})]})),filters,{now:NOW,funnel:fixtureFunnel([funnelRow({appointmentsReserved:1})],{appointmentsReserved:1,spendMinor:12000})});
 assert.equal(report.rows.length,1);assert.equal(report.rows[0].id,'booking:booking-only');assert.equal(report.rows[0].reservedInPeriod,true);assert.equal(report.rows[0].scheduledInPeriod,false);assert.equal(report.rows[0].scheduledDay,null);assert.equal(report.rows[0].outcome,'unknown');
});

test('un créneau courant supprimé garde la réservation historique mais affiche son annulation explicite sans coût',async()=>{
 const p=prospect('cancelled-slot','cancelled-slot','Cas synthétique',{scheduledDay:null,bookedDay:'2026-09-14',dates:{booked:'2026-09-14T08:30:00Z'},attendance:'cancelled'},{source_status:'RDV Annulé'});
 const removed={...appointment('removed-slot','cancelled-slot','2026-09-20'),scheduled_at:null,scheduled_day:null,status:'unknown',source_status:'RDV Annulé'};
 const report=await buildBookingResults(database(baseTables({prospects:[p],appointments:[removed],lead_source_observations:[observation('cancelled-slot',{ad:AD})]})),filters,{now:NOW,funnel:fixtureFunnel([funnelRow({appointmentsReserved:1,spendMinor:5000})],{appointmentsReserved:1,spendMinor:5000})});
 assert.equal(report.summary.booked,1);assert.equal(report.rows.length,1);assert.equal(report.rows[0].reservedInPeriod,true);assert.equal(report.rows[0].scheduledInPeriod,false);assert.equal(report.rows[0].outcome,'cancelled');assert.equal(report.rows[0].effective,false);
 assert.equal(report.cost.eligibleAttributedBookings,0);assert.equal(report.cost.averagePerBookingMinor,null);
});

test('le fallback fiche sans appointment restitue annulation ou report explicite, sans classer un état inconnu',async()=>{
 const cases=[
  {id:'cancelled-only',status:'RDV Annulé',attendance:'cancelled',expected:'cancelled'},
  {id:'moved-only',status:'RDV Reporté',attendance:'unknown',expected:'rescheduled'},
  {id:'unknown-only',status:'À rappeler',attendance:'unknown',expected:'unknown'},
 ] as const;
 const prospects=cases.map(item=>prospect(item.id,item.id,'Cas '+item.id,{bookedDay:'2026-09-14',dates:{booked:'2026-09-14'},attendance:item.attendance},{source_status:item.status}));
 const report=await buildBookingResults(database(baseTables({prospects,lead_source_observations:cases.map(item=>observation(item.id,{ad:AD}))})),filters,{now:NOW,funnel:fixtureFunnel([funnelRow({appointmentsReserved:3,spendMinor:9000})],{appointmentsReserved:3,spendMinor:9000})});
 for(const item of cases)assert.equal(report.rows.find(row=>row.id==='booking:'+item.id)?.outcome,item.expected);
 assert.equal(report.rows.find(row=>row.id==='booking:cancelled-only')?.effective,false);assert.equal(report.rows.find(row=>row.id==='booking:moved-only')?.effective,false);assert.equal(report.rows.find(row=>row.id==='booking:unknown-only')?.effective,true);
});

test('un statut courant de fiche ne se transmet pas à un ancien créneau daté',async()=>{
 const p=prospect('historical','historical','Ancien créneau',{scheduledDay:null,bookedDay:'2026-09-14',dates:{booked:'2026-09-14'},attendance:'cancelled'},{source_status:'RDV Annulé'}),historical=appointment('historical-slot','historical','2026-09-16','unknown',{identity_basis:'stable_booking',source_status:'RDV Programmé'});
 const report=await buildBookingResults(database(baseTables({prospects:[p],appointments:[historical],lead_source_observations:[observation('historical',{ad:AD})]})),filters,{now:NOW,funnel:fixtureFunnel([funnelRow({appointmentsReserved:1,appointmentsBooked:1,appointmentsUnknown:1})],{appointmentsReserved:1,appointmentsBooked:1,appointmentsUnknown:1,spendMinor:5000})});
 assert.equal(report.rows[0].scheduledDay,'2026-09-16');assert.equal(report.rows[0].outcome,'unknown');
});

test('la lecture pagine au-delà de 1000 lignes et ignore un doublon exact sans tronquer',async()=>{
 const count=1001,prospects:Row[]=[],appointments:Row[]=[],observations:Row[]=[];
 for(let index=0;index<count;index++){
  const person='p-'+index,id='pr-'+index;prospects.push(prospect(id,person,'Personne '+index,{scheduledDay:'2026-09-25',bookedDay:'2026-09-10',dates:{booked:'2026-09-10'},attendance:'scheduled'}));appointments.push(appointment('a-'+index,id,'2026-09-25'));observations.push(observation(person,{ad:AD},{id:'obs-'+index,external_id:'entry-'+index}));
 }
 appointments.push({...appointments[0]});
 const report=await buildBookingResults(database(baseTables({appointments,prospects,lead_source_observations:observations})),filters,{now:NOW,funnel:fixtureFunnel([funnelRow({appointmentsReserved:count,appointmentsBooked:count,appointmentsUpcoming:count})],{appointmentsReserved:count,appointmentsBooked:count,appointmentsUpcoming:count,spendMinor:12000})});
 assert.equal(report.coverage.appointmentRowsRead,count+1);assert.equal(report.coverage.prospectRowsRead,count);assert.equal(report.rows.length,count);assert.equal(new Set(report.rows.map(row=>row.id)).size,count);
});

test('les filtres du funnel bornent les lignes et un funnel d’un autre périmètre est refusé',async()=>{
 const paidProspect=prospect('paid','paid','Paid',{scheduledDay:'2026-09-25',bookedDay:'2026-09-10',dates:{booked:'2026-09-10'},attendance:'scheduled'}),organicProspect=prospect('org','org','Org',{scheduledDay:'2026-09-25',bookedDay:'2026-09-10',dates:{booked:'2026-09-10'},attendance:'scheduled'});
 const tables=baseTables({prospects:[paidProspect,organicProspect],appointments:[appointment('paid','paid','2026-09-25'),appointment('org','org','2026-09-25')],lead_source_observations:[observation('paid',{ad:AD}),observation('org',{source:'instagram'})]});
 const organicFilter={...filters,source:'organic' as const},organicFunnel=fixtureFunnel([funnelRow({key:ORGANIC,kind:'organic',source:'organic',label:'Organique',adId:null,campaignId:null,campaignLabel:null,spendMinor:null})]);organicFunnel.filters.source='organic';
 const report=await buildBookingResults(database(tables),organicFilter,{now:NOW,funnel:organicFunnel});assert.deepEqual(report.rows.map(row=>row.id),['org']);assert.equal(report.cost.averagePerBookingMinor,null);
 await assert.rejects(()=>buildBookingResults(database(tables),filters,{now:NOW,funnel:organicFunnel}),/BOOKING_RESULTS_FUNNEL_SCOPE_MISMATCH/);
});

test('les essais explicites et les rendez-vous inconnus restent distincts',async()=>{
 const regular=prospect('unknown','unknown','Inconnu',{scheduledDay:'2026-09-08',bookedDay:'2026-09-02',dates:{booked:'2026-09-02'},attendance:'unknown'}),testProspect=prospect('test','test','Test',{scheduledDay:'2026-09-09',bookedDay:'2026-09-03',dates:{booked:'2026-09-03'},attendance:'scheduled'});
 const report=await buildBookingResults(database(baseTables({prospects:[regular,testProspect],appointments:[appointment('unknown','unknown','2026-09-08'),appointment('test','test','2026-09-09')],lead_source_observations:[observation('unknown',{ad:AD}),observation('test',{ad:AD},{properties:{origin:{ad:AD},sid:EXCLUDED_TEST_SESSION_IDS[0]}})]})),filters,{now:NOW,funnel:fixtureFunnel([funnelRow({appointmentsReserved:1,appointmentsBooked:1,appointmentsUnknown:1})],{appointmentsReserved:1,appointmentsBooked:1,appointmentsUnknown:1,spendMinor:12000})});
 assert.deepEqual(report.rows.map(row=>row.id),['unknown']);assert.equal(report.rows[0].outcome,'unknown');assert.equal(report.coverage.rowsExcludedAsTests,1);
});

test('la lecture complète sans funnel garde les compteurs du moteur et filtre deux liens distincts d’une même publicité',async()=>{
 const LINK_A='11111111-1111-4111-8111-111111111111',LINK_B='22222222-2222-4222-8222-222222222222',dayFilters={from:'2026-09-18',to:'2026-09-18',tunnel:'all' as const,source:'all' as const,campaign:'',includeTests:false};
 const pA=prospect('pr-a','p-a','Lien A',{scheduledDay:'2026-09-21',bookedDay:'2026-09-18',dates:{booked:'2026-09-18T08:00:00Z'},attendance:'scheduled'}),pB=prospect('pr-b','p-b','Lien B',{scheduledDay:'2026-09-22',bookedDay:'2026-09-18',dates:{booked:'2026-09-18T08:05:00Z'},attendance:'scheduled'}),pNoWix=prospect('pr-no-wix','p-no-wix','Sans demande Wix',{scheduledDay:'2026-09-18',bookedDay:'2026-09-18',dates:{booked:'2026-09-18T08:10:00Z'},attendance:'show_up'});
 const obsA=observation('p-a',{ad:AD,linkId:LINK_A,source:'meta',medium:'paid_social'},{mapping_profile:'forms-v1'}),obsB=observation('p-b',{ad:AD,linkId:LINK_B,source:'meta',medium:'paid_social'},{mapping_profile:'forms-v1'});
 const completeRun=(id:string,source:string,stream:string,profile:string):Row=>({id,source,source_namespace:source==='notion'?'notion':'site',stream_key:stream,status:'complete',pagination_complete:true,rows_rejected:0,finished_at:'2026-09-18T11:35:00Z',source_as_of:'2026-09-18T11:30:00Z',covered_to:'2026-09-19T00:00:00Z',period_to:'2026-09-19T00:00:00Z',started_at:'2026-09-18T11:30:00Z',query_profile_key:profile});
 const tables=baseTables({
  prospects:[pA,pB,pNoWix],appointments:[appointment('a-link-a','pr-a','2026-09-21'),appointment('a-link-b','pr-b','2026-09-22'),appointment('a-no-wix','pr-no-wix','2026-09-18')],lead_source_observations:[obsA,obsB],
  ads:[{id:'ad-uuid',external_id:AD,ad_name:'Même publicité',campaign_id:'campaign-1',campaign_name:'Masterclass',creative_id:'creative-1'}],
  v_ad_daily:[{id:'daily',ad_id:'ad-uuid',date:'2026-09-18',spend_minor:9000,impressions:1000,outbound_clicks:20,currency:'EUR',currency_exponent:2,timezone:'Europe/Paris'}],
  link_revisions:[{id:LINK_A,label:'Lien A',campaign:'alpha',tunnel:'masterclass',medium:'paid_social'},{id:LINK_B,label:'Lien B',campaign:'beta',tunnel:'masterclass',medium:'paid_social'}],
  sync_runs:[completeRun('notion-run','notion','prospects_business','notion-v1'),completeRun('forms-run','wix','lead_entries_forms','forms-v1')],
 });
 const all=await buildBookingResults(database(tables),dayFilters,{now:NOW,env:{NOTION_DATA_SOURCE_ID:'notion',WIX_SITE_ID:'site'}});
 assert.equal(all.summary.booked,3);assert.equal(all.rows.filter(row=>row.reservedInPeriod).length,3);assert.equal(all.summary.attended,1);assert.deepEqual(all.rows.filter(row=>row.scheduledInPeriod&&row.outcome==='attended').map(row=>row.id),['a-no-wix']);
 assert.equal(all.summary.scheduled,0,'les deux calls futurs hors période ne sont pas déplacés au jour de réservation');
 const linkFilters={...dayFilters,campaign:'link:alpha'};
 const onlyA=await buildBookingResults(database(tables),linkFilters,{now:NOW,env:{NOTION_DATA_SOURCE_ID:'notion',WIX_SITE_ID:'site'}});
 assert.deepEqual(onlyA.rows.map(row=>row.id),['a-link-a']);assert.equal(onlyA.summary.booked,1);assert.equal(onlyA.cost.averagePerBookingMinor,null,'la dépense totale d’une publicité ne se répartit pas sur un seul lien');
});
