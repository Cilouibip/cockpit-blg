import {contractsInPeriod,type SignedContract} from './finance-summary';
import {createHash} from 'node:crypto';
import {Temporal} from '@js-temporal/polyfill';
import type {Database,Row} from './db';
import {startOfParisDay} from '../domain/dates';
import {COMMERCE_COUNTERS,NOTION_COMMERCE_VERSION,type CommerceCounters,type CommerceReport} from './notion-commerce-report';
import {selectPaidSalesPeriod,confirmedSalesByOffer,OFFER_CATEGORIES,type PaidSalesReport} from './paid-sales';
import {notionCommerceConfig,notionCommerceProfile,type NotionCommerceConfig} from '../connectors/notion-commerce';
import type {DashboardFilters} from './ui-contract';
const STREAM='commerce_declared_snapshot',OVERVIEW='notion_commerce_overview',DAY='notion_commerce_day',MEMBERS='notion_commerce_membership',PAID_SALES='notion_commerce_paid_sales',CONTRACTS='notion_commerce_contracts';
/** Padded because source_aggregates sorts dimensions_key lexically when reconstructing detail chunks. */
export const paidSalesChunkKey=(index:number)=>'paid-sales:'+String(index).padStart(6,'0');
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const zero=()=>Object.fromEntries(COMMERCE_COUNTERS.map(k=>[k,0])) as CommerceCounters;
const paidSalesSummary=(report:CommerceReport)=>({confirmedByOffer:report.paidSales.confirmedByOffer,confirmedInitialSales:report.paidSales.confirmedInitialSales,reconciledInitialSales:report.paidSales.reconciledInitialSales,pendingInitialPaymentCases:report.paidSales.pendingInitialPaymentCases,excludedSubsequentPayments:report.paidSales.excludedSubsequentPayments,refundCases:report.paidSales.refundCases,coverage:report.paidSales.coverage});
function validPaidSales(report:PaidSalesReport):boolean {
 return report.details.every(d=>['confirmed','reconciled','pending','excluded'].includes(d.state)&&(!d.offerCategory||OFFER_CATEGORIES.includes(d.offerCategory)))
  &&report.confirmedInitialSales===report.details.filter(d=>d.state==='confirmed').length
  &&digest(report.confirmedByOffer)===digest(confirmedSalesByOffer(report.details));
}
function validCounts(value:unknown):value is CommerceCounters{return !!value&&typeof value==='object'&&COMMERCE_COUNTERS.every(k=>Number.isSafeInteger((value as CommerceCounters)[k])&&(value as CommerceCounters)[k]>=0);}
async function rowsForRun(db:Database,runId:string,metric:string,max=10000){const rows:Row[]=[];for(let from=0;from<max;from+=1000){const page=await db.select('source_aggregates',{eq:{sync_run_id:runId,metric_key:metric},order:'period_from,dimensions_key',from,limit:1000});rows.push(...page);if(page.length<1000)return rows;}throw Error('COMMERCE_REPORT_READ_LIMIT');}
/** Keeps each JSONB dimensions payload beneath the database's 4 kB limit. */
export function paidSalesDetailChunks(details:PaidSalesReport['details'],maxBytes=2800){const chunks:PaidSalesReport['details'][]=[];let current:PaidSalesReport['details']=[];for(const detail of details){const candidate=[...current,detail];if(current.length&&Buffer.byteLength(JSON.stringify({details:candidate}),'utf8')>maxBytes){chunks.push(current);current=[detail];}else current=candidate;if(Buffer.byteLength(JSON.stringify({details:current}),'utf8')>maxBytes)throw Error('PAID_SALES_DETAIL_TOO_LARGE');}if(current.length)chunks.push(current);return chunks;}
async function publications(db:Database,namespace:string,profile?:string,periodTo?:string){return db.select('sync_runs',{eq:{source:'notion',source_namespace:namespace,stream_key:STREAM,status:'complete',pagination_complete:'true',rows_rejected:'0',...(profile?{query_profile_key:profile}:{}),...(periodTo?{period_to:periodTo}:{})},order:'period_to,started_at,id',descending:true,limit:5});}
async function storedPublicationMatches(db:Database,run:Row,report:CommerceReport,memberKeys:string[],fingerprint:string){
 const overview=await rowsForRun(db,String(run.id),OVERVIEW),info=overview.length===1?overview[0].dimensions as Row:null;
 if(!info||info.reportFingerprint!==fingerprint||info.version!==NOTION_COMMERCE_VERSION||info.observedAt!==report.startedAt||info.readCompletedAt!==report.observedAt||info.startedAt!==report.startedAt||!info.coverage||!info.paidSalesSummary||digest(info.coverage)!==digest(report.coverage)||digest(info.paidSalesSummary)!==digest(paidSalesSummary(report))||!validCounts(info.totals)||digest(info.totals)!==digest(report.totals)||info.dailyCount!==report.daily.length||info.dailyHash!==digest(report.daily)||info.paidSalesHash!==digest(report.paidSales.details)||info.paidSalesCount!==report.paidSales.details.length||info.contractsCount!==report.contracts.length||info.contractsHash!==digest(report.contracts)||info.membershipHash!==report.membershipHash||info.sourceMemberCount!==memberKeys.length||info.sourceMemberHash!==digest(memberKeys))return false;
 const days=await rowsForRun(db,String(run.id),DAY),storedDays=days.map(r=>({date:String((r.dimensions as Row).date),counts:(r.dimensions as Row).counts}));
 if(days.length!==report.daily.length||digest(storedDays)!==digest(report.daily))return false;
 const paid=(await rowsForRun(db,String(run.id),PAID_SALES)).flatMap(r=>((r.dimensions as {details?:unknown}).details??[]));if(digest(paid)!==digest(report.paidSales.details))return false;
 const contracts=(await rowsForRun(db,String(run.id),CONTRACTS)).flatMap(r=>((r.dimensions as {contracts?:unknown}).contracts??[]));if(digest(contracts)!==digest(report.contracts))return false;
 const members=(await rowsForRun(db,String(run.id),MEMBERS)).flatMap(r=>((r.dimensions as {keys?:unknown}).keys??[])).sort();
 return Array.isArray(members)&&digest(members)===digest(memberKeys);
}
/** One full source report is the publication unit. Sparse days never revive rows from a previous report. */
export async function publishNotionCommerceReport(db:Database,config:NotionCommerceConfig,report:CommerceReport){
 if(!validPaidSales(report.paidSales)||report.version!==NOTION_COMMERCE_VERSION||!report.paginationComplete||!validCounts(report.totals)||report.daily.length>=1000||report.members.length>=10000)throw Error('COMMERCE_REPORT_INCOMPLETE');
 // Collection completion does not refresh families read in earlier passes.
 // Preserve completion separately; publication coverage stops at the oldest read.
 try{if(Temporal.Instant.compare(report.startedAt,report.observedAt)>0||Temporal.Instant.compare(report.startedAt,'1970-01-01T00:00:00Z')<=0)throw Error();}catch{throw Error('COMMERCE_OBSERVATION_INVALID');}
 const summed=zero();for(const day of report.daily){if(!validCounts(day.counts)||Temporal.PlainDate.from(day.date).toString()!==day.date)throw Error('INVALID_COMMERCE_DAY');for(const key of COMMERCE_COUNTERS)summed[key]+=day.counts[key];}
 if(new Set(report.daily.map(d=>d.date)).size!==report.daily.length||digest(summed)!==digest(report.totals))throw Error('COMMERCE_TOTALS_MISMATCH');
 const profile=notionCommerceProfile(config),namespace=config.parcours.dataSourceId,memberKeys=Object.entries(report.sourceMembers).flatMap(([family,ids])=>ids.map(id=>digest([namespace,family,id]))).sort();
 if(memberKeys.length>=29970)throw Error('COMMERCE_SOURCE_MEMBERS_LIMIT');
 if(new Set(memberKeys).size!==memberKeys.length)throw Error('DUPLICATE_COMMERCE_MEMBERS');
 const fingerprint=digest({profile,version:report.version,observedAt:report.startedAt,readCompletedAt:report.observedAt,startedAt:report.startedAt,totals:report.totals,paidSales:report.paidSales,contracts:report.contracts,coverage:report.coverage,daily:report.daily,membershipHash:report.membershipHash,memberKeys});
 for(const run of await publications(db,namespace,profile,report.startedAt))if(await storedPublicationMatches(db,run,report,memberKeys,fingerprint))return {status:'complete' as const,runId:String(run.id),profile,counts:report.totals,membershipHash:report.membershipHash};
 const previous=(await publications(db,namespace))[0];
 if(previous){const oldRows=await rowsForRun(db,String(previous.id),MEMBERS),oldKeys=oldRows.flatMap(r=>((r.dimensions as Row).keys as string[])??[]).sort(),overview=await rowsForRun(db,String(previous.id),OVERVIEW),info=overview.length===1?overview[0].dimensions as Row:null;if(!info||oldKeys.length!==info.sourceMemberCount||digest(oldKeys)!==info.sourceMemberHash)throw Error('COMMERCE_PREVIOUS_MEMBERSHIP_INVALID');if(oldKeys.some(k=>!memberKeys.includes(k)))throw Error('COMMERCE_HISTORICAL_SOURCE_MEMBER_MISSING');}
 let runId:string|undefined;
 try{
  runId=await db.rpc<string>('begin_sync_stream',{p_source:'notion',p_namespace:namespace,p_from:'1970-01-01T00:00:00Z',p_to:report.startedAt,p_profile:profile,p_coverage_kind:'source_snapshot',p_stream:STREAM});
  const base={source:'notion',source_namespace:namespace,report_profile_key:profile,sync_run_id:runId,timezone:'Europe/Paris',coverage_state:'partial',unit:'count',currency:null,currency_exponent:null,tax_basis:'unknown',definition_version:profile};
  const rows:Row[]=report.daily.map(d=>({...base,metric_key:DAY,period_from:startOfParisDay(d.date),period_to:startOfParisDay(Temporal.PlainDate.from(d.date).add({days:1}).toString()),dimensions_key:d.date,value:d.counts.firstAccompanimentsStarted,dimensions:{date:d.date,counts:d.counts},source_locator:'notion:declared-commerce-day'}));
  for(let i=0;i<memberKeys.length;i+=30)rows.push({...base,metric_key:MEMBERS,period_from:'1970-01-01T00:00:00Z',period_to:report.startedAt,dimensions_key:'membership:'+i,value:memberKeys.slice(i,i+30).length,dimensions:{keys:memberKeys.slice(i,i+30)},source_locator:'notion:declared-commerce-source-membership'});
  let paidOffset=0;for(const chunk of paidSalesDetailChunks(report.paidSales.details)){rows.push({...base,metric_key:PAID_SALES,period_from:'1970-01-01T00:00:00Z',period_to:report.startedAt,dimensions_key:paidSalesChunkKey(paidOffset),value:chunk.length,dimensions:{details:chunk},source_locator:'notion:paid-sales-classification'});paidOffset+=chunk.length;}
  for(let i=0;i<report.contracts.length;i+=3)rows.push({...base,metric_key:CONTRACTS,period_from:'1970-01-01T00:00:00Z',period_to:report.startedAt,dimensions_key:'contracts:'+String(i).padStart(6,'0'),value:report.contracts.slice(i,i+3).length,dimensions:{contracts:report.contracts.slice(i,i+3)},source_locator:'notion:parcours-closing-and-schedule-total'});
  rows.push({...base,metric_key:OVERVIEW,period_from:'1970-01-01T00:00:00Z',period_to:report.startedAt,dimensions_key:'all',value:report.totals.firstAccompanimentsStarted,dimensions:{version:report.version,observedAt:report.startedAt,readCompletedAt:report.observedAt,startedAt:report.startedAt,totals:report.totals,paidSalesSummary:paidSalesSummary(report),paidSalesCount:report.paidSales.details.length,paidSalesHash:digest(report.paidSales.details),contractsCount:report.contracts.length,contractsHash:digest(report.contracts),coverage:report.coverage,dailyCount:report.daily.length,dailyHash:digest(report.daily),membershipHash:report.membershipHash,sourceMemberCount:memberKeys.length,sourceFamilyCounts:Object.fromEntries(Object.entries(report.sourceMembers).map(([family,ids])=>[family,ids.length])),sourceMemberHash:digest(memberKeys),reportFingerprint:fingerprint},source_locator:'notion:declared-commerce-overview'});
  for(let i=0;i<rows.length;i+=100)await db.upsert('source_aggregates',rows.slice(i,i+100),'source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id');
  if(!await storedPublicationMatches(db,{id:runId},report,memberKeys,fingerprint))throw Error('COMMERCE_STAGED_REPORT_MISMATCH');
  await db.rpc('finish_sync',{p_run:runId,p_status:'complete',p_read:Object.values(report.coverage.sourceRows).reduce((a,b)=>a+b,0),p_rejected:0,p_complete:true,p_error:null});
  return {status:'complete' as const,runId,profile,counts:report.totals,membershipHash:report.membershipHash};
 }catch(e){if(runId)await db.rpc('finish_sync',{p_run:runId,p_status:'failed',p_read:0,p_rejected:0,p_complete:false,p_error:'COMMERCE_REPORT_FAILED'}).catch(()=>undefined);throw e;}
}
export interface CommerceDashboard {available:boolean;source:string;definitionState:'pending_business_choice';observedAt:string|null;counts:CommerceCounters|null;paidSales:PaidSalesReport|null;contracts?:SignedContract[]|null;coverage:CommerceReport['coverage']|null;reason:string;runId?:string;provisional?:boolean;periodCovered?:boolean}
/** Reads of one request share each publication row family; the memo never outlives the request. */
export type CommerceReadMemo=Map<string,Promise<Row[]>>;
export const commerceReadMemo=():CommerceReadMemo=>new Map();
function memoised(memo:CommerceReadMemo|undefined,key:string,load:()=>Promise<Row[]>):Promise<Row[]>{if(!memo)return load();let value=memo.get(key);if(!value){value=load();memo.set(key,value);}return value;}
export interface CommerceReadOptions {
 /** Attribution needs complete historical membership before applying its dates. */
 details?:'period'|'all-history';
 /** The caller must apply the conservative cutoff to every day it exposes.
  * This mode never supplies global counters for an incompletely covered period. */
 coverage?:'whole-period'|'per-day';
}
/** Indexed reads of a single immutable publication; no source call, write, or browser event. */
export async function readNotionCommerceReport(db:Database,filters:DashboardFilters,env:Record<string,string|undefined>=process.env,memo?:CommerceReadMemo,options:CommerceReadOptions={}):Promise<CommerceDashboard|null>{
 const config=notionCommerceConfig(env.NOTION_COMMERCE_CONFIG);if(!config)return null;
 const unavailable=(reason:string):CommerceDashboard=>({available:false,source:'Notion · achats déclarés et paiements rapprochés',definitionState:'pending_business_choice',observedAt:null,counts:null,paidSales:null,contracts:null,coverage:null,reason});
 if(filters.source!=='all'||filters.tunnel!=='all'||filters.campaign&&filters.campaign!=='all')return unavailable('Le rattachement de ces achats au filtre source, campagne ou parcours n’est pas établi.');
 const profile=notionCommerceProfile(config),namespace=config.parcours.dataSourceId,runs=await memoised(memo,'publications:'+namespace+':'+profile,()=>publications(db,namespace,profile));
 for(const run of runs){
  try{
  const id=String(run.id),rows=(metric:string)=>memoised(memo,id+':'+metric,()=>rowsForRun(db,id,metric));
  // The row families of a complete publication are immutable: read them together, validate them in order.
  const [overview,stored,paidRows,contractRows]=await Promise.all([rows(OVERVIEW),rows(DAY),rows(PAID_SALES),rows(CONTRACTS)]);
  if(overview.length!==1)continue;const info=overview[0].dimensions as Row;
  if(info.version!==NOTION_COMMERCE_VERSION||!validCounts(info.totals)||!Number.isSafeInteger(info.dailyCount)||Number(info.dailyCount)>=1000)continue;
  if(stored.length!==info.dailyCount)continue;
  const daily=stored.map(r=>({date:String((r.dimensions as Row).date),counts:(r.dimensions as Row).counts}));if(digest(daily)!==info.dailyHash||daily.some(d=>!validCounts(d.counts)))continue;
  const hasPaidSales=info.paidSalesSummary!==undefined||info.paidSalesCount!==undefined||info.paidSalesHash!==undefined;
  let paidSales:PaidSalesReport|null=null;
  if(hasPaidSales){
   if(!info.paidSalesSummary||!Number.isSafeInteger(info.paidSalesCount)||typeof info.paidSalesHash!=='string')continue;
   const paidDetails=paidRows.flatMap(r=>((r.dimensions as {details?:unknown}).details??[]));
   if(info.paidSalesCount!==paidDetails.length||info.paidSalesHash!==digest(paidDetails))continue;
   const historical={...((info.paidSalesSummary as Omit<PaidSalesReport,'details'>)),details:paidDetails as PaidSalesReport['details']};
   // Legacy summaries had no offer attribution; preserve their rows as unknown.
   historical.confirmedByOffer??=confirmedSalesByOffer(historical.details);
   if(!validPaidSales(historical))continue;
   paidSales=options.details==='all-history'?historical:selectPaidSalesPeriod(historical,filters.from,filters.to);
  }
  let contracts:SignedContract[]|null=null;
  if(info.contractsCount!==undefined||info.contractsHash!==undefined){
   const allContracts=contractRows.flatMap(r=>((r.dimensions as {contracts?:SignedContract[]}).contracts??[]));
   if(!Number.isSafeInteger(info.contractsCount)||allContracts.length!==info.contractsCount||digest(allContracts)!==info.contractsHash)continue;
   contracts=options.details==='all-history'?allContracts:contractsInPeriod(allContracts,filters.from,filters.to);
  }
  const counts=zero();for(const day of daily)if(day.date>=filters.from&&day.date<=filters.to)for(const key of COMMERCE_COUNTERS)counts[key]+=(day.counts as CommerceCounters)[key];
  // Legacy publications used completion for observedAt; their real collection
  // start is still available. Never turn that old cutoff into fresh coverage.
  const started=Temporal.Instant.from(String(info.startedAt)),observed=Temporal.Instant.from(String(info.observedAt));
  const observedAt=(Temporal.Instant.compare(started,observed)<0?started:observed).toString(),observedDay=Temporal.Instant.from(observedAt).toZonedDateTimeISO('Europe/Paris').toPlainDate().toString();
  const today=Temporal.Instant.fromEpochMilliseconds(Date.now()).toZonedDateTimeISO('Europe/Paris').toPlainDate().toString();
  // A snapshot taken before this entire period cannot establish a zero sale.
  // A current observed day retains its actual provisional values. An older
  // cutoff cannot establish full-period counts or zeroes across uncovered days.
  const periodCovered=!(filters.from>observedDay||(filters.to>=observedDay&&observedDay<today));
  if(!periodCovered&&options.coverage!=='per-day')return {...unavailable('La période demandée dépasse la dernière observation complète des achats.'),observedAt,runId:id,provisional:true,periodCovered:false};
  const coverage=info.coverage as CommerceReport['coverage'];
  const archiveNote=coverage?.retainedArchivedClients?` ${coverage.retainedArchivedClients} fiche Client conservée dans l’historique après confirmation de son statut archivé/corbeille dans Notion.`:'';
  return {available:true,source:'Notion · achats déclarés et paiements rapprochés',definitionState:'pending_business_choice',observedAt,counts:periodCovered?counts:null,paidSales,contracts,coverage,periodCovered,runId:String(run.id),provisional:filters.to>=observedDay,reason:'Sous-totaux des Parcours Notion disponibles. Personnes accompagnées, classement payeur, paiement rattaché et dates divergentes restent distincts ; historique métier non exhaustif.'+archiveNote};
  }catch(e){if(e instanceof TypeError||e instanceof RangeError)continue;throw e;}
 }
 return unavailable('Le rapport des achats déclarés n’a pas encore de publication complète pour ce profil.');
}
