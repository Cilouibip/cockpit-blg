import type {AdFunnelReport,AdFunnelRow} from './ad-funnel';
import type {DashboardResponse,DetailsResponse,DetailRow} from './ui-contract';

/** Existing Results list contract, projected from the same acquisition engine as the advertising detail. */
export function resultsDetails(report:AdFunnelReport,page=0):DetailsResponse&{campaigns:DashboardResponse['campaigns']} {
 if(!Number.isInteger(page)||page<0||page>100000)throw new Error('INVALID_RESULTS_PAGE');
 const observed=(value:number)=>value>0||report.coverage.appointments.available===true?value:null;
 const active=(row:AdFunnelRow)=>row.registrations>0||row.uniqueLeads>0||row.appointmentsBooked>0||row.appointmentsCancelled>0||row.appointmentsRescheduled>0||row.appointmentsReserved>0||row.spendMinor!==null||row.impressions!==null||row.outboundClicks!==null||report.filters.campaign===`meta-ad:${row.adId}`;
 const linkIds=new Set(report.linkDetails?.map(row=>row.key)??[]);
 const details:DetailRow[]=[...report.rows.filter(row=>active(row)&&!linkIds.has(row.key)),...(report.linkDetails??[])].map(row=>({
  id:row.key,label:row.label,source:row.source,
  leads:report.available&&(row.uniqueLeads>0||row.unresolvedIdentity===0&&report.coverage.leads.complete!==false)?row.uniqueLeads:null,
  appointments:observed(row.appointmentsAttended),clients:null,spend:row.spendMinor===null?null:row.spendMinor/100,
  coverage:[`${row.registrations} inscriptions confirmées · ${row.uniqueRegistrants} personnes inscrites · ${row.uniqueLeads} premiers contacts connus.`,
   row.knownBefore?`${row.knownBefore} personnes déjà connues.`:null,
   row.unresolvedIdentity?`${row.unresolvedIdentity} inscriptions sans identité rapprochée, conservées sans inventer un nouveau lead.`:null,
   `Première origine mesurée conservée ; essais explicitement identifiés ${report.filters.includeTests?'inclus':'exclus'}. Les lignes publicité et lien peuvent décrire les mêmes personnes : ne pas les additionner.`,
   `${row.appointmentsReserved} réservations datées dans la période ; ${row.appointmentsBooked} créneaux non annulés prévus dans la période ; ${row.appointmentsCancelled} annulés et ${row.appointmentsRescheduled} reportés.`,
   report.coverage.appointments.reason,
   'RDV réalisés = présences classées par Notion à la date du créneau. Clients : premiers accompagnements non attribuables à cette ligne ; les ventes ne les remplacent pas.',
  ].filter(Boolean).join(' '),
 })).sort((a,b)=>a.label.localeCompare(b.label)||a.id.localeCompare(b.id));
 return {details:details.slice(page*50,(page+1)*50),pagination:{page,pageSize:50,total:details.length},campaigns:report.campaigns??[]};
}

/** Keep the approved first-contact meaning, and the known/unavailable distinction, under every filter. */
export function applyResultsAcquisition(response:DashboardResponse,report:AdFunnelReport):void {
 const lead=response.metrics.find(m=>m.id==='leads');
 if(lead){
  const count=report.totals.uniqueLeads;
  const value=report.available&&(count>0||report.totals.unresolvedIdentity===0&&report.coverage.leads.complete!==false)?count:null;
  Object.assign(lead,{value,source:'Wix + Notion · premiers contacts',updatedAt:report.coverage.leads.observedAt,definition:report.definitions.uniqueLeads,
   coverage:`${report.totals.registrations} inscriptions confirmées · ${report.totals.uniqueRegistrants} personnes inscrites · ${report.totals.knownBefore} déjà connues · ${report.totals.unresolvedIdentity} inscriptions sans identité rapprochée. Première origine mesurée ; essais explicites ${report.filters.includeTests?'inclus':'exclus'}.`,completeness:'partial',unavailableReason:value===null?'Les inscriptions ou leurs identités ne permettent pas encore ce décompte.':undefined});
 }
 // These counts remain distinct from the browser's “confirmation displayed” signal.
 for(const journey of response.journeys.filter(j=>['quiz','masterclass'].includes(j.id))){
  const tunnel=journey.id as 'quiz'|'masterclass';
  const sourceStep={id:'server-registrations',label:'Inscriptions confirmées dans Wix',value:report.available?report.totals.registrationsByTunnel[tunnel]:null,source:'Wix · inscriptions publiées',coverage:'Soumissions confirmées dans la période, répétitions conservées ; essais explicites exclus. Le signal de confirmation affiché dans le navigateur reste séparé.'};
  const at=journey.steps.findIndex(s=>s.id==='server-registrations');if(at<0)journey.steps.push(sourceStep);else journey.steps[at]=sourceStep;
 }
 const metrics=[...response.metrics,...response.pillars.flatMap(p=>p.metrics)];
 for(const [id,count] of [['appointments',report.totals.appointmentsAttended],['booked',report.totals.appointmentsReserved],['cancelled',report.totals.appointmentsCancelled],['no_show',report.totals.appointmentsNoShow]] as const){
  const metric=metrics.find(m=>m.id===id);if(!metric)continue;
  const value=count>0||report.coverage.appointments.available?count:null;
  Object.assign(metric,{value,source:'Notion · suivi commercial',updatedAt:report.coverage.appointments.observedAt??null,completeness:'partial',
   definition:id==='booked'?'Fiches avec une date de réservation explicite dans la période, distincte du jour du call.':id==='appointments'?'Présences classées dans Notion, à la date prévue du rendez-vous. Aucun clic ni signal Meta ne compte comme présence.':metric.definition,
   coverage:report.coverage.appointments.reason??'Créneaux courants du miroir Notion ; historique des créneaux remplacés non reconstitué.',unavailableReason:value===null?report.coverage.appointments.reason??'Le miroir des rendez-vous ne couvre pas cette période.':undefined});
 }
 const showup=metrics.find(m=>m.id==='showup');
 if(showup){const rate=report.totals.rates.attendance;Object.assign(showup,{value:rate.value===null?null:rate.value*100,numerator:rate.numerator,denominator:rate.denominator,updatedAt:report.coverage.appointments.observedAt??null,coverage:report.coverage.appointments.reason??'Présences / (présences + absences), même sélection et essais exclus.',unavailableReason:rate.reason});}
 // A provisional zero from an incomplete account read is not a measured zero for the period.
 const spend=metrics.find(m=>m.id==='spend');
 if(spend?.value===0&&spend.completeness==='partial'&&((spend.missingDays?.length??0)>0||(spend.provisionalDays?.length??0)>0)){
  spend.value=null;spend.unavailableReason='La période publicitaire n’est pas encore entièrement disponible.';
 }
}
