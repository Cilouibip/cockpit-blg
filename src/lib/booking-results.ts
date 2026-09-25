import {Temporal} from '@js-temporal/polyfill';
import type {Database,Row,TableName} from './db';
import {
 buildAdFunnel,canonicalRegistrationOrigins,originKeyFor,originMatchesSelection,UNATTRIBUTED,UNRESOLVED,
 type AdFunnelFilters,type AdFunnelOrigin,type AdFunnelReport,type AdFunnelRow,type FunnelTunnel,
} from './ad-funnel';
import {appointmentBooking,appointmentDay,appointmentOutcome,businessDay,isEffectiveAppointment,type AppointmentOutcome} from './appointment-semantics';
import {reconcileAcquisitionPeople} from './results-acquisition';
import {DEFAULT_TRAFFIC_SCOPE,isExcludedTestTraffic,type TrafficScope} from './traffic-scope';
import {wixLeadEntryConfig} from '../connectors/wix-lead-entries';

export interface BookingResultRow {
 id:string;
 prospectId:string;
 displayName:string;
 bookingAt:string|null;
 bookingDay:string|null;
 scheduledAt:string|null;
 scheduledDay:string|null;
 outcome:AppointmentOutcome;
 effective:boolean;
 reservedInPeriod:boolean;
 scheduledInPeriod:boolean;
 source:'paid'|'organic'|'unknown';
 attributionKey:string;
 attributionLabel:string;
 adId:string|null;
 campaignId:string|null;
 campaignLabel:string|null;
}

export interface BookingCostRow {
 attributionKey:string;
 label:string;
 adId:string;
 campaignId:string|null;
 spendMinor:number|null;
 eligibleAttributedBookings:number;
 averagePerBookingMinor:number|null;
 reason:string|null;
}

export interface BookingResultsReport {
 period:{from:string;to:string;timezone:string};
 generatedAt:string;
 filters:AdFunnelReport['filters'];
 summary:{
  /** Same published definition as Results metric `booked`: explicit booking date in the selected period. */
  booked:number|null;
  scheduled:number|null;
  attended:number|null;
  noShow:number|null;
  cancelled:number|null;
  rescheduled:number|null;
  unknown:number|null;
 };
 rows:BookingResultRow[];
 cost:{
  spendMinor:number|null;
  eligibleAttributedBookings:number;
  averagePerBookingMinor:number|null;
  reason:string|null;
  byAds:BookingCostRow[];
 };
 coverage:{
  available:boolean;
  reason:string|null;
  observedAt:string|null;
  appointmentRowsRead:number;
  prospectRowsRead:number;
  rowsExcludedAsTests:number;
  definitions:{booked:string;scheduled:string;attended:string;cost:string};
 };
}

export interface BookingResultsOptions {
 env?:Record<string,string|undefined>;
 now?:string;
 /** Reuse the exact advertising projection already read by the route. */
 funnel?:AdFunnelReport;
}

const record=(value:unknown):Row=>value&&typeof value==='object'&&!Array.isArray(value)?value as Row:{};
const inPeriod=(day:string|null,from:string,to:string)=>!!day&&day>=from&&day<=to;
const safeName=(value:unknown)=>typeof value==='string'&&value.trim()?value.trim().slice(0,240):'Nom non renseigné';

async function pages(db:Database,table:TableName,options:Parameters<Database['select']>[1],max=50_000):Promise<Row[]> {
 const rows:Row[]=[];
 for(let from=0;from<max;from+=1000){
  const page=await db.select(table,{...options,from,limit:1000});
  rows.push(...page);
  if(page.length<1000)return rows;
 }
 throw new Error('BOOKING_RESULTS_READ_LIMIT');
}

function assertMatchingFunnel(funnel:AdFunnelReport,filters:AdFunnelFilters):void {
 const expected={tunnel:filters.tunnel,source:filters.source??'all',campaign:filters.campaign??'',includeTests:filters.includeTests===true};
 if(funnel.period.from!==filters.from||funnel.period.to!==filters.to||Object.entries(expected).some(([key,value])=>funnel.filters[key as keyof typeof expected]!==value))throw new Error('BOOKING_RESULTS_FUNNEL_SCOPE_MISMATCH');
}

function sourceRuns(rows:Row[]){
 const completed=rows.filter(row=>['complete','empty'].includes(String(row.status))&&row.pagination_complete===true&&Number(row.rows_rejected??0)===0);
 const byId=new Map(completed.map(row=>[String(row.id),row]));
 const latestProfile=new Map<string,unknown>();
 for(const row of [...completed].sort((a,b)=>String(a.finished_at??a.started_at).localeCompare(String(b.finished_at??b.started_at))||String(a.id).localeCompare(String(b.id)))){
  if(String(row.stream_key).startsWith('lead_entries_'))latestProfile.set(row.source_namespace+':'+String(row.stream_key).slice(13),row.query_profile_key);
 }
 return {byId,latestProfile};
}

function publishedLeadRows(rows:Row[],prospects:Row[],runs:Row[],env:Record<string,string|undefined>):Row[] {
 const {byId,latestProfile}=sourceRuns(runs),entryConfig=wixLeadEntryConfig(env.WIX_LEAD_ENTRY_CONFIG);
 const allowedContainer=(row:Row)=>!entryConfig||row.family==='client_history'||row.family==='forms'&&entryConfig.formIds.includes(String(row.source_container_id))||row.family==='quiz'&&entryConfig.quiz?.collectionId===row.source_container_id;
 const published=(row:Row)=>!row.run_id||byId.has(String(row.run_id))&&row.mapping_profile===latestProfile.get(row.source_namespace+':'+row.family);
 return reconcileAcquisitionPeople(rows.filter(row=>row.published_at&&published(row)&&allowedContainer(row)&&(!env.NOTION_CLIENT_DATA_SOURCE_ID||row.family!=='client_history'||row.source_namespace===env.NOTION_CLIENT_DATA_SOURCE_ID)),prospects,env.NOTION_DATA_SOURCE_ID)
  .filter(row=>!env.WIX_SITE_ID||row.family==='client_history'||row.source_namespace===env.WIX_SITE_ID);
}

function requestState(rows:Row[],includeTests:boolean){
 const scope:TrafficScope={...DEFAULT_TRAFFIC_SCOPE,includeTests};
 const requests=rows.filter(row=>['forms','quiz'].includes(String(row.family))&&row.eligible===true&&row.person_id&&row.identity_state==='linked'&&row.occurred_at&&row.occurred_day);
 const isTest=(row:Row)=>{const properties=record(row.properties),origin=record(properties.origin),firstTouch=record(properties.firstTouch);return isExcludedTestTraffic(scope,properties,origin,firstTouch);};
 const retained=requests.filter(row=>!isTest(row));
 const excludedPeople=new Set(requests.filter(isTest).map(row=>String(row.person_id)));
 const retainedPeople=new Set(retained.map(row=>String(row.person_id)));
 const firstTunnel=new Map<string,FunnelTunnel>();
 for(const row of [...retained].sort((a,b)=>Temporal.Instant.compare(String(a.occurred_at),String(b.occurred_at))||String(a.id).localeCompare(String(b.id)))){
  const person=String(row.person_id);if(!firstTunnel.has(person))firstTunnel.set(person,row.family==='quiz'?'quiz':'masterclass');
 }
 return {excludedPeople,retainedPeople,firstTunnel};
}

function effectiveWithoutSlot(business:Row,sourceStatus:unknown):boolean {
 return !['cancelled'].includes(String(business.attendance??''))&&!['RDV Annulé','RDV Reporté'].includes(String(sourceStatus??''));
}

/** Presentation-only fallback for a current Notion slot that was explicitly removed. Never applies a current fiche status to a dated historical slot. */
function outcomeWithoutCurrentSlot(business:Row,...sourceStatuses:unknown[]):AppointmentOutcome {
 if(business.attendance==='cancelled'||sourceStatuses.some(status=>status==='RDV Annulé'))return 'cancelled';
 if(sourceStatuses.some(status=>status==='RDV Reporté'))return 'rescheduled';
 return 'unknown';
}

function reportRowFor(personId:string|null,origins:Map<string,{origin:AdFunnelOrigin;at:string}>,visible:Map<string,AdFunnelRow>,filters:AdFunnelFilters,ads:Map<string,Row>,revisions:Map<string,Row>):{key:string;row:AdFunnelRow}|null {
 const origin=personId?origins.get(personId)?.origin??null:null;
 const ad=origin?.adId?ads.get(origin.adId):undefined,revision=origin?.linkId?revisions.get(origin.linkId):undefined;
 if(!originMatchesSelection(origin,{source:filters.source??'all',campaign:filters.campaign??''},{linkCampaign:revision?.campaign?String(revision.campaign):null,linkMedium:revision?.medium?String(revision.medium):null,adCampaignId:ad?.campaign_id?String(ad.campaign_id):null,adCreativeId:ad?.creative_id?String(ad.creative_id):null}))return null;
 const key=personId?(origin?originKeyFor(origin):UNATTRIBUTED):UNRESOLVED;
 const row=visible.get(key);return row?{key,row}:null;
}

function detail(input:{id:string;prospect:Row;personId:string|null;booking:{at:string|null;day:string|null};scheduledAt:string|null;scheduledDay:string|null;outcome:AppointmentOutcome;effective:boolean;reportKey:string;reportRow:AdFunnelRow;from:string;to:string}):BookingResultRow {
 return {id:input.id,prospectId:String(input.prospect.id),displayName:safeName(input.prospect.display_name),bookingAt:input.booking.at,bookingDay:input.booking.day,
  scheduledAt:input.scheduledAt,scheduledDay:input.scheduledDay,outcome:input.outcome,effective:input.effective,reservedInPeriod:inPeriod(input.booking.day,input.from,input.to),scheduledInPeriod:inPeriod(input.scheduledDay,input.from,input.to),
  source:input.reportRow.source,attributionKey:input.reportKey,attributionLabel:input.reportRow.label,adId:input.reportRow.adId,campaignId:input.reportRow.campaignId,campaignLabel:input.reportRow.campaignLabel};
}

function average(spend:number,count:number):number|null{return Number.isSafeInteger(spend)&&count>0?Math.round(spend/count):null;}

/**
 * Private server projection for Results. It reads only the existing SQL mirrors.
 * Names are intentionally returned for the authenticated private UI; contact details never are.
 */
export async function buildBookingResults(db:Database,filters:AdFunnelFilters,options:BookingResultsOptions={}):Promise<BookingResultsReport> {
 const env=options.env??process.env,generatedAt=options.now??new Date().toISOString();
 const funnel=options.funnel??await buildAdFunnel(db,filters,{env,now:generatedAt,includeCommerce:false});
 assertMatchingFunnel(funnel,filters);
 const [appointments,prospects,leadRows,runs,ads,revisions]=await Promise.all([
  pages(db,'appointments',{order:'id'}),
  pages(db,'prospects',{order:'id',columns:['id','external_id','source','source_namespace','person_id','display_name','source_status','business','archived']}),
  pages(db,'lead_source_observations',{eq:{is_current:'true'},order:'occurred_day,id'}),
  pages(db,'sync_runs',{order:'started_at,id',columns:['id','source','source_namespace','stream_key','status','pagination_complete','rows_rejected','finished_at','source_as_of','covered_to','period_to','started_at','query_profile_key']}),
  pages(db,'ads',{order:'id',columns:['id','external_id','campaign_id','creative_id']}),
  pages(db,'link_revisions',{order:'id',columns:['id','campaign','medium']}),
 ]);
 const published=publishedLeadRows(leadRows,prospects,runs,env),origins=canonicalRegistrationOrigins(published,filters.includeTests===true);
 const request=requestState(published,filters.includeTests===true),testScope:TrafficScope={...DEFAULT_TRAFFIC_SCOPE,includeTests:filters.includeTests===true};
 const visible=new Map(funnel.rows.map(row=>[row.key,row])),prospectById=new Map(prospects.map(row=>[String(row.id),row])),adsByExternal=new Map(ads.map(row=>[String(row.external_id),row])),revisionsById=new Map(revisions.map(row=>[String(row.id),row]));
 const appointmentProspects=new Set<string>(),seenAppointments=new Set<string>(),rows:BookingResultRow[]=[];let excludedTests=0;
 for(const appointment of appointments){
  const id=String(appointment.id);if(seenAppointments.has(id))continue;seenAppointments.add(id);
  const prospect=appointment.prospect_id?prospectById.get(String(appointment.prospect_id)):undefined;if(!prospect)continue;
  appointmentProspects.add(String(prospect.id));
  const personId=appointment.person_id?String(appointment.person_id):prospect.person_id?String(prospect.person_id):null,business=record(prospect.business);
  if(prospect.archived===true||env.NOTION_DATA_SOURCE_ID&&appointment.source==='notion'&&appointment.source_namespace!==env.NOTION_DATA_SOURCE_ID)continue;
  if(isExcludedTestTraffic(testScope,business,appointment)||!testScope.includeTests&&personId&&request.excludedPeople.has(personId)&&!request.retainedPeople.has(personId)){excludedTests++;continue;}
  if(filters.tunnel!=='all'&&(!personId||request.firstTunnel.get(personId)!==filters.tunnel))continue;
  const attribution=reportRowFor(personId,origins,visible,filters,adsByExternal,revisionsById);if(!attribution)continue;
  const booking=appointmentBooking(appointment,business),scheduledDay=appointmentDay(appointment),semanticOutcome=appointmentOutcome(appointment,business,scheduledDay);
  const outcome=scheduledDay===null&&appointment.identity_basis==='notion_current_slot'&&semanticOutcome==='unknown'?outcomeWithoutCurrentSlot(business,appointment.source_status,prospect.source_status):semanticOutcome,effective=isEffectiveAppointment(appointment,business);
  const row=detail({id,prospect,personId,booking,scheduledAt:typeof appointment.scheduled_at==='string'?appointment.scheduled_at:null,scheduledDay,outcome,effective,reportKey:attribution.key,reportRow:attribution.row,from:filters.from,to:filters.to});
  if(row.reservedInPeriod||row.scheduledInPeriod)rows.push(row);
 }
 // An explicit booking date remains visible even when the current-slot mirror is absent.
 for(const prospect of prospects){
  if(prospect.archived===true||appointmentProspects.has(String(prospect.id))||env.NOTION_DATA_SOURCE_ID&&(prospect.source!=='notion'||prospect.source_namespace!==env.NOTION_DATA_SOURCE_ID))continue;
  const personId=prospect.person_id?String(prospect.person_id):null,business=record(prospect.business),dates=record(business.dates),bookingDay=businessDay(dates.booked)??businessDay(business.bookedDay);
  if(!inPeriod(bookingDay,filters.from,filters.to))continue;
  if(isExcludedTestTraffic(testScope,business)||!testScope.includeTests&&personId&&request.excludedPeople.has(personId)&&!request.retainedPeople.has(personId)){excludedTests++;continue;}
  if(filters.tunnel!=='all'&&(!personId||request.firstTunnel.get(personId)!==filters.tunnel))continue;
  const attribution=reportRowFor(personId,origins,visible,filters,adsByExternal,revisionsById);if(!attribution)continue;
  rows.push(detail({id:'booking:'+prospect.id,prospect,personId,booking:{at:typeof dates.booked==='string'&&dates.booked.length>10?dates.booked:null,day:bookingDay},scheduledAt:null,scheduledDay:null,outcome:outcomeWithoutCurrentSlot(business,prospect.source_status),effective:effectiveWithoutSlot(business,prospect.source_status),reportKey:attribution.key,reportRow:attribution.row,from:filters.from,to:filters.to}));
 }
 rows.sort((a,b)=>(b.bookingAt??b.bookingDay??b.scheduledAt??b.scheduledDay??'').localeCompare(a.bookingAt??a.bookingDay??a.scheduledAt??a.scheduledDay??'')||a.displayName.localeCompare(b.displayName)||a.id.localeCompare(b.id));

 const eligibleByKey=new Map<string,number>();
 for(const row of rows)if(row.reservedInPeriod&&row.effective&&row.source==='paid'&&row.adId)eligibleByKey.set(row.attributionKey,(eligibleByKey.get(row.attributionKey)??0)+1);
 const appointmentsCurrent=funnel.coverage.appointments.available===true,originsComplete=funnel.available===true&&funnel.coverage.leads.available===true&&funnel.coverage.leads.complete===true;
 const coverageCostReason=!appointmentsCurrent?'Coût en attente de la mise à jour des rendez-vous.':!originsComplete?'Coût en attente de la mise à jour des inscriptions et de leur origine.':null;
 const byAds:BookingCostRow[]=[];
 for(const reportRow of funnel.rows.filter(row=>row.source==='paid'&&row.adId&&((eligibleByKey.get(row.key)??0)>0||row.spendMinor!==null))){
  const count=eligibleByKey.get(reportRow.key)??0,reason=coverageCostReason??(reportRow.spendMinor===null?'Dépense publicitaire indisponible pour cette publicité.':count===0?'Aucune réservation attribuée éligible dans la période.':null);
  byAds.push({attributionKey:reportRow.key,label:reportRow.label,adId:reportRow.adId!,campaignId:reportRow.campaignId,spendMinor:reportRow.spendMinor,eligibleAttributedBookings:count,averagePerBookingMinor:reason?null:average(reportRow.spendMinor!,count),reason});
 }
 const eligibleAttributedBookings=[...eligibleByKey.values()].reduce((sum,value)=>sum+value,0);
 const relevantCosts=byAds.filter(row=>row.eligibleAttributedBookings>0),costIncomplete=relevantCosts.some(row=>row.spendMinor===null);
 const hasPaidScope=filters.source!=='organic'&&relevantCosts.length>0;
 const spendMinor=!hasPaidScope||costIncomplete?null:funnel.totals.spendMinor;
 const costReason=coverageCostReason??(!hasPaidScope?'Aucune réservation publicitaire attribuée éligible dans la période.':costIncomplete||spendMinor===null?'Les dépenses du périmètre publicitaire sont incomplètes.':eligibleAttributedBookings===0?'Aucune réservation publicitaire attribuée éligible dans la période.':null);
 const available=funnel.coverage.appointments.available===true,known=(value:number)=>available||value>0?value:null;
 return {
  period:funnel.period,generatedAt,filters:funnel.filters,
  summary:{booked:known(funnel.totals.appointmentsReserved),scheduled:known(funnel.totals.appointmentsUpcoming),attended:known(funnel.totals.appointmentsAttended),noShow:known(funnel.totals.appointmentsNoShow),cancelled:known(funnel.totals.appointmentsCancelled),rescheduled:known(funnel.totals.appointmentsRescheduled),unknown:known(funnel.totals.appointmentsUnknown)},
  rows,cost:{spendMinor,eligibleAttributedBookings,averagePerBookingMinor:costReason||spendMinor===null?null:average(spendMinor,eligibleAttributedBookings),reason:costReason,byAds},
  coverage:{available,reason:funnel.coverage.appointments.reason??null,observedAt:funnel.coverage.appointments.observedAt??null,appointmentRowsRead:appointments.length,prospectRowsRead:prospects.length,rowsExcludedAsTests:excludedTests,
   definitions:{booked:'Fiches avec une date de réservation explicite dans la période, distincte du jour du call.',scheduled:'Rendez-vous effectifs à venir dont le créneau tombe dans la période.',attended:'Présences classées dans Notion à la date prévue du rendez-vous.',cost:'Dépenses publicitaires du périmètre divisées par les réservations effectives attribuées à une publicité dans la période. Il s’agit d’une moyenne agrégée, jamais du coût réel d’une personne.'}},
 };
}
