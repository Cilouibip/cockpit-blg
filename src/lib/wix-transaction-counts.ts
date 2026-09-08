import {Temporal} from '@js-temporal/polyfill';
import {syncWixTransactions,type WixTransactionsBatch} from '../connectors/wix-transactions';
import {startOfParisDay} from '../domain/dates';
import {database,type Database,type Row} from './db';
import {AppError} from './errors';
import {readSourceSnapshot,invalidateSourceSnapshots,sourceAttempt} from './source-snapshots';
import type {Metric} from './ui-contract';
export const WIX_RECEIPTS_PROFILE='wix-positive-receipts-created-v1';
const sourceDay=(v:string)=>Temporal.Instant.from(v).toZonedDateTimeISO('Europe/Paris').toPlainDate().toString();
/** Counts observations only. Never emits settled cash events or invented effective dates. */
export function countPositiveWixReceipts(batch:WixTransactionsBatch){
 const days=new Map<string,{receipts:number;refunds:number}>();
 const receipts=batch.records.filter(r=>r.kind==='payment');
 const firstDay=receipts.length?receipts.map(r=>sourceDay(r.createdAt)).sort()[0]:null;
 const seen=new Set<string>();let included=0,excluded=0;
 for(const r of batch.records){
  if(seen.has(r.externalId))throw new AppError('Identifiant de transaction répété.',422,'duplicate_transaction');seen.add(r.externalId);
  const date=sourceDay(r.createdAt),day=days.get(date)??{receipts:0,refunds:0};
  if(r.kind==='payment'){
   if(r.amount.minor>0&&['APPROVED','REFUND','PARTIAL_REFUND'].includes(r.sourceStatus)){day.receipts++;included++;}else excluded++;
  }else if(r.sourceStatus==='SUCCEEDED')day.refunds++;
  days.set(date,day);
 }
 return {days,firstDay,included,excluded};
}
export async function synchronizeWixTransactionCounts(from:string,to:string,options:{db?:Database;env?:NodeJS.ProcessEnv;reader?:typeof syncWixTransactions}={}){
 const env=options.env??process.env,db=options.db??database(),namespace=env.WIX_SITE_ID;
 if(env.COCKPIT_MODE==='demo')throw new AppError('Données de démonstration.',409,'demo_mode');
 if(!namespace||!env.WIX_API_KEY)throw new AppError('La connexion Wix doit être renseignée.',503,'source_missing');
 const days=Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to)).days;
 if(days<1||days>367)throw new AppError('Période de 1 à 367 jours requise.',400,'invalid_period');
 const start=startOfParisDay(from),end=startOfParisDay(to);
 const runId=await db.rpc<string>('begin_sync_stream',{p_source:'wix',p_namespace:namespace,p_from:start,p_to:end,p_profile:WIX_RECEIPTS_PROFILE,p_coverage_kind:'aggregate_period',p_stream:'receipt_observations',p_date_from:from,p_date_to:to});
 let done=false;
 try{
  // Full parent traversal establishes the first observed Wix day and includes old receipts' refunds.
  const result=await(options.reader??syncWixTransactions)({apiKey:env.WIX_API_KEY,siteId:namespace,from:'1970-01-01T00:00:00Z',to:end,currencyExponents:{EUR:2},pageSize:1000,maxPages:20});
  const complete=result.status==='complete'&&result.snapshot.paginationComplete&&result.snapshot.fromBeginning;
  if(complete){
   const counts=countPositiveWixReceipts(result),rows:Row[]=[];
   if(counts.firstDay)for(let d=Temporal.PlainDate.from(from);Temporal.PlainDate.compare(d,Temporal.PlainDate.from(to))<0;d=d.add({days:1})){
    const date=d.toString();if(date<counts.firstDay)continue;
    const values=counts.days.get(date)??{receipts:0,refunds:0};
    for(const [metric,value]of [['wix_receipts_created',values.receipts],['wix_refunds_requested',values.refunds]] as const)rows.push({source:'wix',source_namespace:namespace,metric_key:metric,period_from:startOfParisDay(date),period_to:startOfParisDay(d.add({days:1}).toString()),dimensions_key:'all',report_profile_key:WIX_RECEIPTS_PROFILE,sync_run_id:runId,timezone:'Europe/Paris',coverage_state:'complete',value,unit:'count',currency:null,currency_exponent:null,tax_basis:'unknown',dimensions:{date,firstObservedDay:counts.firstDay,dateBasis:metric==='wix_receipts_created'?'transaction_created':'refund_requested',observedAt:result.snapshot.observedAt},definition_version:WIX_RECEIPTS_PROFILE,source_locator:`wix:transaction-observations:${metric}:${date}`});
   }
   if(rows.length)await db.upsert('source_aggregates',rows,'source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id');
  }
  const status=complete?'complete':result.status==='not_configured'?'failed':result.status;
  await db.rpc('finish_sync',{p_run:runId,p_status:status,p_read:result.counts.read,p_rejected:result.counts.rejected,p_complete:complete||status==='empty',p_error:result.safeError??null});done=true;invalidateSourceSnapshots(db);
  return{status,counts:result.counts,coverage:{complete,reason:'Reçus positifs par date de création Wix ; historique avant le premier jour Wix non couvert.'},runId};
 }finally{if(!done)await db.rpc('finish_sync',{p_run:runId,p_status:'failed',p_read:0,p_rejected:0,p_complete:false,p_error:'WIX_RECEIPTS_FAILED'}).catch(()=>undefined);}
}
export async function readWixTransactionCount(db:Database,from:string,to:string):Promise<Metric>{
 const metric:Metric={id:'transactions',label:'Transactions',value:null,unit:'count',source:'Wix · reçus positifs',definition:'Paiements positifs approuvés distincts, échéances et reçus ensuite remboursés inclus. Date de création Wix ; les remboursements séparés ne créent pas une transaction reçue.',coverage:'Observations transactionnelles non importées.',updatedAt:null,unavailableReason:'Le compteur des reçus positifs Wix n’a pas encore été importé.'};
 const namespace=process.env.WIX_SITE_ID;if(!namespace)return metric;
 const snap=await readSourceSnapshot(db,'wix',namespace,{stream:'receipt_observations',profile:WIX_RECEIPTS_PROFILE,from,to,timezone:'Europe/Paris',currency:null,currencyExponent:null,kind:'daily_bundle'}),runs=new Map(snap.runs.filter(r=>r.stream_key==='receipt_observations'&&r.query_profile_key===WIX_RECEIPTS_PROFILE).map(r=>[r.id,r]));
 metric.latestAttempt=sourceAttempt(snap);
 const missing:string[]=[],provisional:string[]=[],used:Row[]=[];let count=0,refunds=0;
 for(let d=Temporal.PlainDate.from(from);Temporal.PlainDate.compare(d,Temporal.PlainDate.from(to))<0;d=d.add({days:1})){
  const date=d.toString(),end=startOfParisDay(d.add({days:1}).toString());
  const rows=snap.aggregates.filter(r=>r.metric_key==='wix_receipts_created'&&r.report_profile_key===WIX_RECEIPTS_PROFILE&&r.unit==='count'&&r.dimensions_key==='all'&&r.timezone==='Europe/Paris'&&runs.has(r.sync_run_id)&&(r.dimensions as Row)?.date===date&&r.value!==null&&r.value!==undefined&&Number.isSafeInteger(Number(r.value))&&Number(r.value)>=0&&Date.parse(String(r.period_from))===Date.parse(startOfParisDay(date))&&Date.parse(String(r.period_to))===Date.parse(end)).sort((a,b)=>String(runs.get(b.sync_run_id)!.source_as_of).localeCompare(String(runs.get(a.sync_run_id)!.source_as_of))||String(runs.get(b.sync_run_id)!.started_at).localeCompare(String(runs.get(a.sync_run_id)!.started_at))||String(b.sync_run_id).localeCompare(String(a.sync_run_id)));
  const row=rows.find(candidate=>snap.aggregates.some(r=>r.sync_run_id===candidate.sync_run_id&&r.metric_key==='wix_refunds_requested'&&r.unit==='count'&&r.dimensions_key==='all'&&r.timezone==='Europe/Paris'&&r.report_profile_key===WIX_RECEIPTS_PROFILE&&r.value!==null&&r.value!==undefined&&Number.isSafeInteger(Number(r.value))&&Number(r.value)>=0&&r.period_from===candidate.period_from&&r.period_to===candidate.period_to&&(r.dimensions as Row)?.date===date));if(!row){missing.push(date);continue;}
  const observed=String((row.dimensions as Row).observedAt??runs.get(row.sync_run_id)!.source_as_of);if(Date.parse(observed)<Date.parse(end))provisional.push(date);
  count+=Number(row.value);used.push(row);
  refunds+=Number(snap.aggregates.find(r=>r.sync_run_id===row.sync_run_id&&r.metric_key==='wix_refunds_requested'&&(r.dimensions as Row)?.date===date)!.value);
 }
 if(used.length){metric.value=count;metric.updatedAt=used.map(r=>String((r.dimensions as Row).observedAt)).sort()[0];delete metric.unavailableReason;}
 metric.completeness=missing.length||provisional.length?'partial':'complete';metric.missingDays=missing;metric.provisionalDays=provisional;
 metric.coverage=`${count} reçus positifs connus · ${refunds} remboursements distincts · ${missing.length} jour(s) non couvert(s) · ${provisional.length} jour(s) provisoire(s). Date de création source, historique Wix limité à ses observations.`;
 if(!used.length)metric.unavailableReason='Aucun relevé de transactions Wix ne couvre ces dates. L’historique Notion reste à raccorder ; ceci ne vaut pas zéro transaction.';
 return metric;
}
