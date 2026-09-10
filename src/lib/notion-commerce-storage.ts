import {createHash} from 'node:crypto';
import {Temporal} from '@js-temporal/polyfill';
import type {Database,Row} from './db';
import {startOfParisDay} from '../domain/dates';
import {COMMERCE_COUNTERS,NOTION_COMMERCE_VERSION,type CommerceCounters,type CommerceReport} from './notion-commerce-report';
import {selectPaidSalesPeriod,type PaidSalesReport} from './paid-sales';
import {notionCommerceConfig,notionCommerceProfile,type NotionCommerceConfig} from '../connectors/notion-commerce';
import type {DashboardFilters} from './ui-contract';
const STREAM='commerce_declared_snapshot',OVERVIEW='notion_commerce_overview',DAY='notion_commerce_day',MEMBERS='notion_commerce_membership',PAID_SALES='notion_commerce_paid_sales';
/** Padded because source_aggregates sorts dimensions_key lexically when reconstructing detail chunks. */
export const paidSalesChunkKey=(index:number)=>'paid-sales:'+String(index).padStart(6,'0');
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const zero=()=>Object.fromEntries(COMMERCE_COUNTERS.map(k=>[k,0])) as CommerceCounters;
function validCounts(value:unknown):value is CommerceCounters{return !!value&&typeof value==='object'&&COMMERCE_COUNTERS.every(k=>Number.isSafeInteger((value as CommerceCounters)[k])&&(value as CommerceCounters)[k]>=0);}
async function rowsForRun(db:Database,runId:string,metric:string,max=10000){const rows:Row[]=[];for(let from=0;from<max;from+=1000){const page=await db.select('source_aggregates',{eq:{sync_run_id:runId,metric_key:metric},order:'period_from,dimensions_key',from,limit:1000});rows.push(...page);if(page.length<1000)return rows;}throw Error('COMMERCE_REPORT_READ_LIMIT');}
/** Keeps each JSONB dimensions payload beneath the database's 4 kB limit. */
export function paidSalesDetailChunks(details:PaidSalesReport['details'],maxBytes=2800){const chunks:PaidSalesReport['details'][]=[];let current:PaidSalesReport['details']=[];for(const detail of details){const candidate=[...current,detail];if(current.length&&Buffer.byteLength(JSON.stringify({details:candidate}),'utf8')>maxBytes){chunks.push(current);current=[detail];}else current=candidate;if(Buffer.byteLength(JSON.stringify({details:current}),'utf8')>maxBytes)throw Error('PAID_SALES_DETAIL_TOO_LARGE');}if(current.length)chunks.push(current);return chunks;}
async function publications(db:Database,namespace:string,profile?:string,periodTo?:string){return db.select('sync_runs',{eq:{source:'notion',source_namespace:namespace,stream_key:STREAM,status:'complete',pagination_complete:'true',rows_rejected:'0',...(profile?{query_profile_key:profile}:{}),...(periodTo?{period_to:periodTo}:{})},order:'period_to,started_at,id',descending:true,limit:5});}
async function storedPublicationMatches(db:Database,run:Row,report:CommerceReport,memberKeys:string[],fingerprint:string){
 const overview=await rowsForRun(db,String(run.id),OVERVIEW),info=overview.length===1?overview[0].dimensions as Row:null;
 if(!info||info.reportFingerprint!==fingerprint||info.version!==NOTION_COMMERCE_VERSION||info.observedAt!==report.observedAt||!validCounts(info.totals)||digest(info.totals)!==digest(report.totals)||info.dailyCount!==report.daily.length||info.dailyHash!==digest(report.daily)||info.paidSalesHash!==digest(report.paidSales.details)||info.paidSalesCount!==report.paidSales.details.length||info.membershipHash!==report.membershipHash||info.sourceMemberCount!==memberKeys.length||info.sourceMemberHash!==digest(memberKeys))return false;
 const days=await rowsForRun(db,String(run.id),DAY),storedDays=days.map(r=>({date:String((r.dimensions as Row).date),counts:(r.dimensions as Row).counts}));
 if(days.length!==report.daily.length||digest(storedDays)!==digest(report.daily))return false;
 const paid=(await rowsForRun(db,String(run.id),PAID_SALES)).flatMap(r=>((r.dimensions as {details?:unknown}).details??[]));if(digest(paid)!==digest(report.paidSales.details))return false;
 const members=(await rowsForRun(db,String(run.id),MEMBERS)).flatMap(r=>((r.dimensions as {keys?:unknown}).keys??[])).sort();
 return Array.isArray(members)&&digest(members)===digest(memberKeys);
}
/** One full source report is the publication unit. Sparse days never revive rows from a previous report. */
export async function publishNotionCommerceReport(db:Database,config:NotionCommerceConfig,report:CommerceReport){
 if(report.version!==NOTION_COMMERCE_VERSION||!report.paginationComplete||!validCounts(report.totals)||report.daily.length>=1000||report.members.length>=10000)throw Error('COMMERCE_REPORT_INCOMPLETE');
 const summed=zero();for(const day of report.daily){if(!validCounts(day.counts)||Temporal.PlainDate.from(day.date).toString()!==day.date)throw Error('INVALID_COMMERCE_DAY');for(const key of COMMERCE_COUNTERS)summed[key]+=day.counts[key];}
 if(new Set(report.daily.map(d=>d.date)).size!==report.daily.length||digest(summed)!==digest(report.totals))throw Error('COMMERCE_TOTALS_MISMATCH');
 const profile=notionCommerceProfile(config),namespace=config.parcours.dataSourceId,memberKeys=Object.entries(report.sourceMembers).flatMap(([family,ids])=>ids.map(id=>digest([namespace,family,id]))).sort();
 if(memberKeys.length>=29970)throw Error('COMMERCE_SOURCE_MEMBERS_LIMIT');
 if(new Set(memberKeys).size!==memberKeys.length)throw Error('DUPLICATE_COMMERCE_MEMBERS');
 const fingerprint=digest({profile,version:report.version,observedAt:report.observedAt,startedAt:report.startedAt,totals:report.totals,paidSales:report.paidSales,coverage:report.coverage,daily:report.daily,membershipHash:report.membershipHash,memberKeys});
 for(const run of await publications(db,namespace,profile,report.observedAt))if(await storedPublicationMatches(db,run,report,memberKeys,fingerprint))return {status:'complete' as const,runId:String(run.id),profile,counts:report.totals,membershipHash:report.membershipHash};
 const previous=(await publications(db,namespace))[0];
 if(previous){const oldRows=await rowsForRun(db,String(previous.id),MEMBERS),oldKeys=oldRows.flatMap(r=>((r.dimensions as Row).keys as string[])??[]).sort(),overview=await rowsForRun(db,String(previous.id),OVERVIEW),info=overview.length===1?overview[0].dimensions as Row:null;if(!info||oldKeys.length!==info.sourceMemberCount||digest(oldKeys)!==info.sourceMemberHash)throw Error('COMMERCE_PREVIOUS_MEMBERSHIP_INVALID');if(oldKeys.some(k=>!memberKeys.includes(k)))throw Error('COMMERCE_HISTORICAL_SOURCE_MEMBER_MISSING');}
 let runId:string|undefined;
 try{
  runId=await db.rpc<string>('begin_sync_stream',{p_source:'notion',p_namespace:namespace,p_from:'1970-01-01T00:00:00Z',p_to:report.observedAt,p_profile:profile,p_coverage_kind:'source_snapshot',p_stream:STREAM});
  const base={source:'notion',source_namespace:namespace,report_profile_key:profile,sync_run_id:runId,timezone:'Europe/Paris',coverage_state:'partial',unit:'count',currency:null,currency_exponent:null,tax_basis:'unknown',definition_version:profile};
  const rows:Row[]=report.daily.map(d=>({...base,metric_key:DAY,period_from:startOfParisDay(d.date),period_to:startOfParisDay(Temporal.PlainDate.from(d.date).add({days:1}).toString()),dimensions_key:d.date,value:d.counts.firstAccompanimentsStarted,dimensions:{date:d.date,counts:d.counts},source_locator:'notion:declared-commerce-day'}));
  for(let i=0;i<memberKeys.length;i+=30)rows.push({...base,metric_key:MEMBERS,period_from:'1970-01-01T00:00:00Z',period_to:report.observedAt,dimensions_key:'membership:'+i,value:memberKeys.slice(i,i+30).length,dimensions:{keys:memberKeys.slice(i,i+30)},source_locator:'notion:declared-commerce-source-membership'});
  let paidOffset=0;for(const chunk of paidSalesDetailChunks(report.paidSales.details)){rows.push({...base,metric_key:PAID_SALES,period_from:'1970-01-01T00:00:00Z',period_to:report.observedAt,dimensions_key:paidSalesChunkKey(paidOffset),value:chunk.length,dimensions:{details:chunk},source_locator:'notion:paid-sales-classification'});paidOffset+=chunk.length;}
  rows.push({...base,metric_key:OVERVIEW,period_from:'1970-01-01T00:00:00Z',period_to:report.observedAt,dimensions_key:'all',value:report.totals.firstAccompanimentsStarted,dimensions:{version:report.version,observedAt:report.observedAt,startedAt:report.startedAt,totals:report.totals,paidSalesSummary:{confirmedInitialSales:report.paidSales.confirmedInitialSales,reconciledInitialSales:report.paidSales.reconciledInitialSales,pendingInitialPaymentCases:report.paidSales.pendingInitialPaymentCases,excludedSubsequentPayments:report.paidSales.excludedSubsequentPayments,refundCases:report.paidSales.refundCases,coverage:report.paidSales.coverage},paidSalesCount:report.paidSales.details.length,paidSalesHash:digest(report.paidSales.details),coverage:report.coverage,dailyCount:report.daily.length,dailyHash:digest(report.daily),membershipHash:report.membershipHash,sourceMemberCount:memberKeys.length,sourceFamilyCounts:Object.fromEntries(Object.entries(report.sourceMembers).map(([family,ids])=>[family,ids.length])),sourceMemberHash:digest(memberKeys),reportFingerprint:fingerprint},source_locator:'notion:declared-commerce-overview'});
  for(let i=0;i<rows.length;i+=100)await db.upsert('source_aggregates',rows.slice(i,i+100),'source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id');
  const stored=await rowsForRun(db,runId,DAY),days=stored.map(r=>({date:String((r.dimensions as Row).date),counts:(r.dimensions as Row).counts}));if(digest(days)!==digest(report.daily))throw Error('COMMERCE_STAGED_DAYS_MISMATCH');
  const members=(await rowsForRun(db,runId,MEMBERS)).flatMap(r=>(r.dimensions as {keys:string[]}).keys).sort();if(digest(members)!==digest(memberKeys))throw Error('COMMERCE_STAGED_MEMBERS_MISMATCH');
  const paid=(await rowsForRun(db,runId,PAID_SALES)).flatMap(r=>((r.dimensions as {details?:unknown}).details??[]));if(digest(paid)!==digest(report.paidSales.details))throw Error('COMMERCE_STAGED_PAID_SALES_MISMATCH');
  if((await rowsForRun(db,runId,OVERVIEW)).length!==1)throw Error('COMMERCE_STAGED_OVERVIEW_MISSING');
  await db.rpc('finish_sync',{p_run:runId,p_status:'complete',p_read:Object.values(report.coverage.sourceRows).reduce((a,b)=>a+b,0),p_rejected:0,p_complete:true,p_error:null});
  return {status:'complete' as const,runId,profile,counts:report.totals,membershipHash:report.membershipHash};
 }catch(e){if(runId)await db.rpc('finish_sync',{p_run:runId,p_status:'failed',p_read:0,p_rejected:0,p_complete:false,p_error:'COMMERCE_REPORT_FAILED'}).catch(()=>undefined);throw e;}
}
export interface CommerceDashboard {available:boolean;source:string;definitionState:'pending_business_choice';observedAt:string|null;counts:CommerceCounters|null;paidSales:PaidSalesReport|null;coverage:CommerceReport['coverage']|null;reason:string;runId?:string;provisional?:boolean}
/** Indexed reads of a single immutable publication; no source call, write, or browser event. */
export async function readNotionCommerceReport(db:Database,filters:DashboardFilters,env:Record<string,string|undefined>=process.env):Promise<CommerceDashboard|null>{
 const config=notionCommerceConfig(env.NOTION_COMMERCE_CONFIG);if(!config)return null;
 const unavailable=(reason:string):CommerceDashboard=>({available:false,source:'Notion · achats déclarés et paiements rapprochés',definitionState:'pending_business_choice',observedAt:null,counts:null,paidSales:null,coverage:null,reason});
 if(filters.source!=='all'||filters.tunnel!=='all'||filters.campaign&&filters.campaign!=='all')return unavailable('Le rattachement de ces achats au filtre source, campagne ou parcours n’est pas établi.');
 const profile=notionCommerceProfile(config),runs=await publications(db,config.parcours.dataSourceId,profile);
 for(const run of runs){
  try{
  const overview=await rowsForRun(db,String(run.id),OVERVIEW);if(overview.length!==1)continue;const info=overview[0].dimensions as Row;
  if(info.version!==NOTION_COMMERCE_VERSION||!validCounts(info.totals)||!Number.isSafeInteger(info.dailyCount)||Number(info.dailyCount)>=1000)continue;
  const stored=await rowsForRun(db,String(run.id),DAY);if(stored.length!==info.dailyCount)continue;
  const daily=stored.map(r=>({date:String((r.dimensions as Row).date),counts:(r.dimensions as Row).counts}));if(digest(daily)!==info.dailyHash||daily.some(d=>!validCounts(d.counts)))continue;
  const hasPaidSales=info.paidSalesSummary!==undefined||info.paidSalesCount!==undefined||info.paidSalesHash!==undefined;
  let paidSales:PaidSalesReport|null=null;
  if(hasPaidSales){
   if(!info.paidSalesSummary||!Number.isSafeInteger(info.paidSalesCount)||typeof info.paidSalesHash!=='string')continue;
   const paidDetails=(await rowsForRun(db,String(run.id),PAID_SALES)).flatMap(r=>((r.dimensions as {details?:unknown}).details??[]));
   if(info.paidSalesCount!==paidDetails.length||info.paidSalesHash!==digest(paidDetails))continue;
   paidSales=selectPaidSalesPeriod({...((info.paidSalesSummary as Omit<PaidSalesReport,'details'>)),details:paidDetails as PaidSalesReport['details']},filters.from,filters.to);
  }
  const counts=zero();for(const day of daily)if(day.date>=filters.from&&day.date<=filters.to)for(const key of COMMERCE_COUNTERS)counts[key]+=(day.counts as CommerceCounters)[key];
  const observedAt=String(info.observedAt),observedDay=Temporal.Instant.from(observedAt).toZonedDateTimeISO('Europe/Paris').toPlainDate().toString();
  return {available:true,source:'Notion · achats déclarés et paiements rapprochés',definitionState:'pending_business_choice',observedAt,counts,paidSales,coverage:info.coverage as CommerceReport['coverage'],runId:String(run.id),provisional:filters.to>=observedDay,reason:'Sous-totaux des Parcours Notion disponibles. Personnes accompagnées, classement payeur, paiement rattaché et dates divergentes restent distincts ; historique métier non exhaustif.'};
  }catch(e){if(e instanceof TypeError||e instanceof RangeError)continue;throw e;}
 }
 return unavailable('Le rapport des achats déclarés n’a pas encore de publication complète pour ce profil.');
}
