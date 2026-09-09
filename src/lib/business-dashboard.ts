import type {Database} from './db';
import {AppError} from './errors';
import type {DashboardResponse,DashboardFilters,Metric} from './ui-contract';
import {readWixTransactionCount} from './wix-transaction-counts';
import {readMetaAccountPeriod} from './meta-account-dashboard';
import {readNotionCommerceReport} from './notion-commerce-storage';
import {readLeadDefinitions} from './lead-entry-dashboard';
export interface BusinessRollup {
 available:boolean;observedAt:string|null;sourceRows:number;
 leads:{rows:number;known:number;unresolved:number;creationOnly:number;archivedRows?:number};
 appointments:{total:number;attended:number;explicitFinished:number;noShow:number;cancelled:number;unknown:number;booked:number;closed:number};
}
export function applyNotionBusiness(response:DashboardResponse,r:BusinessRollup,filters:DashboardFilters){
 const scope=filters.source==='all'&&filters.tunnel==='all'&&(!filters.campaign||filters.campaign==='all');
 const metrics=[...response.metrics,...response.pillars.flatMap(p=>p.metrics)];
 const set=(id:string,value:number|null,extras:Partial<Metric>)=>{const m=metrics.find(m=>m.id===id);if(!m)return;Object.assign(m,{value,...extras});if(value!==null)delete m.unavailableReason;};
 const source='Notion · suivi commercial',dateDefinition='Dates métier : acquisition réelle, puis source historique, puis Wix. Les dates de création seules sont exclues.';
 const reason=!scope?'Les identités et dates CRM ne sont pas encore rapprochées avec ce filtre.':!r.available?'Le suivi commercial Notion enrichi n’a pas encore été publié.':undefined;
 const available=scope&&r.available;
 set('leads',available?r.leads.known:null,{source,updatedAt:r.observedAt,definition:`Contacts identifiés distincts selon le suivi Notion, avec une date métier d’acquisition dans la période. L’exhaustivité de l’historique métier reste à rapprocher. ${dateDefinition}`,coverage:`${r.leads.rows} fiches datées · ${r.leads.known} contacts identifiés · ${r.leads.unresolved} sans identité rapprochée · ${r.leads.creationOnly} fiches à date de création seule · ${r.leads.archivedRows??0} fiches archivées conservées dans l’historique.`,completeness:'partial',unavailableReason:reason});
 const a=r.appointments,coverage=`${a.total} rendez-vous datés dans le suivi courant · ${a.attended} présences selon Notion, dont ${a.explicitFinished} explicitement terminés · ${a.noShow} absences · ${a.cancelled} annulations · ${a.unknown} autres statuts. Les créneaux remplacés ne sont pas reconstitués.`;
 set('appointments',available?a.attended:null,{source,updatedAt:r.observedAt,definition:'Présences classées par le suivi Notion, à la date prévue du RDV. Classification source conservée ; aucun historique d’occurrences distinctes déduit.',coverage,completeness:'partial',unavailableReason:reason});
 const denominator=a.attended+a.noShow;
 set('showup',available&&denominator>0?a.attended/denominator*100:null,{source,updatedAt:r.observedAt,numerator:available?a.attended:null,denominator:available?denominator:null,definition:'Présences selon Notion / (présences selon Notion + absences), même période de RDV prévus. Annulations et autres statuts exclus.',coverage,completeness:'partial',unavailableReason:reason??'Aucune présence ou absence classée sur cette période.'});
 const conversion=response.pillars.find(p=>p.id==='conversion');
 if(conversion)for(const [id,label,value]of [['booked','RDV pris',a.booked],['no_show','Absences',a.noShow],['cancelled','RDV annulés',a.cancelled],['closed_observed','Closings enregistrés',a.closed]] as const){
  const metric:Metric={id,label,value:available?value:null,unit:'count',source,updatedAt:r.observedAt,definition:id==='booked'?'Fiches avec une date de réservation dans la période.':id==='closed_observed'?'Fiches actuellement Closé avec une date de closing dans la période ; ce volume ne représente pas les nouveaux clients.':'Classification courante Notion, par date prévue.',coverage,completeness:'partial',unavailableReason:available?undefined:reason};
  const index=conversion.metrics.findIndex(m=>m.id===id);if(index<0)conversion.metrics.push(metric);else conversion.metrics[index]=metric;
 }
 return response;
}
const missing:BusinessRollup={available:false,observedAt:null,sourceRows:0,leads:{rows:0,known:0,unresolved:0,creationOnly:0},appointments:{total:0,attended:0,explicitFinished:0,noShow:0,cancelled:0,unknown:0,booked:0,closed:0}};
/** Stored data only. Each source can be unavailable without hiding other available metrics. */
export async function applyStoredBusiness(response:DashboardResponse,db:Database,filters:DashboardFilters,to:string){
 const all=filters.source==='all'&&filters.tunnel==='all'&&(!filters.campaign||filters.campaign==='all');
 const namespace=process.env.NOTION_DATA_SOURCE_ID;
 let notion=missing;
 if(namespace)try{notion=await db.rpc<BusinessRollup>('cockpit_business_rollup',{p_namespace:namespace,p_from:filters.from,p_to:to});}catch(e){if(!(e instanceof AppError&&e.code==='schema_missing'))throw e;}
 if(namespace)applyNotionBusiness(response,notion,filters);
  const leadDefinitions=await readLeadDefinitions(db,filters,to);
 if(leadDefinitions){
  response.leadDefinitions=leadDefinitions;
  const leadMetric=response.metrics.find(metric=>metric.id==='leads'),value=all&&leadDefinitions.available?leadDefinitions.firstKnownAcquisitions:null;
  if(leadMetric)Object.assign(leadMetric,{value,source:'Wix + Notion · premiers contacts',updatedAt:leadDefinitions.observedAt,definition:'Personnes dont le premier contact connu avec BLG tombe dans la période. Les demandes répétées sont conservées mais ne créent pas un nouveau lead.',coverage:leadDefinitions.available?`${leadDefinitions.requestCount} demandes source · ${leadDefinitions.peopleWithRequests} personnes avec demande · ${leadDefinitions.knownBeforePeriod} déjà connues avant la période · ${leadDefinitions.unresolvedDatedRequests} demandes datées sans identité résolue.`:leadDefinitions.reason,completeness:leadDefinitions.available?'partial':undefined,unavailableReason:value===null?leadDefinitions.reason:undefined});
 }
 const commerce=await readNotionCommerceReport(db,filters);
 if(commerce){
  response.commerce=commerce;
  const clientMetric=response.metrics.find(metric=>metric.id==='new_clients');
  if(clientMetric){
   const value=commerce.available&&all?commerce.counts!.firstAccompanimentsStarted:null;
   Object.assign(clientMetric,{value,source:'Notion · démarrages Client',updatedAt:commerce.observedAt,definition:'Personnes qui commencent leur premier accompagnement à leur Démarrage Client effectif. Les binômes sont inclus.',coverage:commerce.available?`${commerce.counts!.firstAccompanimentsStarted} démarrages · ${commerce.coverage!.undatedClientStarts} sans date · ${commerce.coverage!.futureClientStarts} à venir non comptés.`:commerce.reason,completeness:commerce.available?'partial':undefined,unavailableReason:value===null?commerce.reason:undefined});
  }
 }
 const transactionIndex=response.metrics.findIndex(m=>m.id==='transactions');
 if(transactionIndex>=0){
  if(all)response.metrics[transactionIndex]=await readWixTransactionCount(db,filters.from,to);
  else Object.assign(response.metrics[transactionIndex],{value:null,unavailableReason:'Les reçus Wix ne sont pas reliés à ce filtre source, tunnel ou campagne.'});
 }
 const metaScope=filters.tunnel==='all'&&['all','paid'].includes(filters.source)&&(!filters.campaign||filters.campaign==='all');
 if(metaScope){
  const report=await readMetaAccountPeriod(db,filters.from,to);
  if(report.status!=='missing'){
   const metrics=[...response.metrics,...response.pillars.flatMap(p=>p.metrics)];
   const values={spend:report.totals.spendMinor===null?null:report.totals.spendMinor/100,impressions:report.totals.impressions,clicks:report.totals.outboundClicks,ctr:report.totals.ctrPercent,cpm:report.totals.cpmMinor===null?null:report.totals.cpmMinor/100,cpc:report.totals.cpcMinor===null?null:report.totals.cpcMinor/100};
   const ratioParts:Record<string,{numerator:number|null;denominator:number|null}>={ctr:{numerator:report.ratioCoverage.numerators.outboundClicks,denominator:report.ratioCoverage.denominators.impressions},cpm:{numerator:report.ratioCoverage.numerators.spendMinor===null?null:report.ratioCoverage.numerators.spendMinor/100,denominator:report.ratioCoverage.denominators.impressions},cpc:{numerator:report.ratioCoverage.numerators.spendMinor===null?null:report.ratioCoverage.numerators.spendMinor/100,denominator:report.ratioCoverage.denominators.outboundClicks}};
   for(const [id,value]of Object.entries(values)){const m=metrics.find(m=>m.id===id);if(!m)continue;Object.assign(m,{value,...ratioParts[id],source:'Meta · total du compte',updatedAt:report.observedAt,latestAttempt:report.latestAttempt,coverage:report.reason??'Jours complets réconciliés au total du compte.',completeness:report.coverage.complete?'complete':'partial',missingDays:report.coverage.missingDays,provisionalDays:report.coverage.provisionalDays,unavailableReason:value===null?report.reason??'Dénominateur nul ou données incomplètes.':undefined});}
   const byDay=new Map(report.daily.map(d=>[d.date,d.spendMinor]));response.series=response.series.map(d=>({...d,spend:byDay.get(d.date)==null?null:byDay.get(d.date)!/100}));
  }
 }
 return response;
}
