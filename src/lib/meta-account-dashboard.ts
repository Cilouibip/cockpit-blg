import { Temporal } from '@js-temporal/polyfill';
import { META_ACCOUNT_PROFILE, META_ACCOUNT_STREAM, metaAccountDays } from '../connectors/meta-account-analytics';
import type { Database, Row } from './db';
import { readSourceSnapshot,sourceAttempt } from './source-snapshots';
import { metaAccountEnvironment, metaDayStart, type MetaEnvironment } from './sync-meta-account';

export interface StoredMetaDay {
  date:string;spendMinor:number|null;impressions:number|null;outboundClicks:number|null;observedAt:string;provisional:boolean;
}
export interface MetaAccountPeriod {
  source:'Meta';status:'complete'|'partial'|'missing';currency:string;timezone:string;observedAt:string|null;
  totals:{spendMinor:number|null;impressions:number|null;outboundClicks:number|null;ctrPercent:number|null;cpmMinor:number|null;cpcMinor:number|null};
  daily:StoredMetaDay[];
  coverage:{complete:boolean;totalDays:number;coveredDays:number;missingDays:string[];provisionalDays:string[];unknownClickDays:string[]};
  ratioCoverage:{from:string|null;to:string|null;observedAt:string|null;complete:boolean;provisional:boolean;contiguous:boolean;comparisonEligible:boolean;numerators:{spendMinor:number|null;outboundClicks:number|null};denominators:{impressions:number|null;outboundClicks:number|null}};
  reason:string|null;latestAttempt?:import('./ui-contract').SourceAttempt|null;
}
const number=(value:unknown)=>value===null||value===undefined?null:Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):null;
function sum(days:StoredMetaDay[],key:'spendMinor'|'impressions'|'outboundClicks'){
  const known=days.filter(d=>d[key]!==null);if(!known.length)return null;
  const value=known.reduce((n,d)=>n+BigInt(d[key]!),0n);return value>BigInt(Number.MAX_SAFE_INTEGER)?null:Number(value);
}
/** Additive day aggregates only. Reads the last completed report for each day;
 * a failed refresh cannot supersede it. No source API is called here. */
export async function readMetaAccountPeriod(db:Database,from:string,to:string,options:{env?:MetaEnvironment}={}):Promise<MetaAccountPeriod>{
  const config=metaAccountEnvironment(options.env),dates=metaAccountDays(from,to,3660);
  const result:MetaAccountPeriod={source:'Meta',status:'missing',currency:config.currency,timezone:config.timezone,observedAt:null,
    totals:{spendMinor:null,impressions:null,outboundClicks:null,ctrPercent:null,cpmMinor:null,cpcMinor:null},daily:[],
    ratioCoverage:{from:null,to:null,observedAt:null,complete:false,provisional:false,contiguous:false,comparisonEligible:false,numerators:{spendMinor:null,outboundClicks:null},denominators:{impressions:null,outboundClicks:null}},
    coverage:{complete:false,totalDays:dates.length,coveredDays:0,missingDays:[...dates],provisionalDays:[],unknownClickDays:[]},reason:'Totaux quotidiens du compte Meta non importés pour cette période.'};
  if(!config.accountId)return result;
  const snapshot=await readSourceSnapshot(db,'meta',config.accountId,{stream:META_ACCOUNT_STREAM,profile:META_ACCOUNT_PROFILE,from,to,timezone:config.timezone,currency:config.currency,currencyExponent:config.currencyExponent,kind:'daily_bundle'}),runs=new Map(snapshot.runs.filter(r=>r.stream_key===META_ACCOUNT_STREAM&&r.query_profile_key===META_ACCOUNT_PROFILE).map(r=>[String(r.id),r]));
  result.latestAttempt=sourceAttempt(snapshot);
  const groups=new Map<string,{day:string;run:Row;rows:Map<string,Row>}>();
  for(const row of snapshot.aggregates){
    const run=runs.get(String(row.sync_run_id)),dimensions=row.dimensions as Row|undefined,day=dimensions?.date;
    if(!run||row.report_profile_key!==META_ACCOUNT_PROFILE||row.dimensions_key!=='account'||dimensions?.scope!=='account'||typeof day!=='string'||!dates.includes(day)||row.timezone!==config.timezone)continue;
    const next=Temporal.PlainDate.from(day).add({days:1}).toString();
    if(Date.parse(String(row.period_from))!==Date.parse(metaDayStart(day,config.timezone))||Date.parse(String(row.period_to))!==Date.parse(metaDayStart(next,config.timezone)))continue;
    if(row.metric_key==='meta_spend_minor'&&(row.currency!==config.currency||Number(row.currency_exponent)!==config.currencyExponent||row.unit!=='minor'))continue;
    if(row.metric_key!=='meta_spend_minor'&&row.unit!=='count')continue;
    const key=`${day}:${row.sync_run_id}`;let group=groups.get(key);if(!group){group={day,run,rows:new Map()};groups.set(key,group);}group.rows.set(String(row.metric_key),row);
  }
  for(const day of dates){
    const candidates=[...groups.values()].filter(g=>g.day===day&&['meta_spend_minor','meta_impressions','meta_outbound_clicks'].every(k=>g.rows.has(k)))
      .sort((a,b)=>String(b.run.source_as_of??b.run.started_at).localeCompare(String(a.run.source_as_of??a.run.started_at))||String(b.run.started_at).localeCompare(String(a.run.started_at))||String(b.run.id).localeCompare(String(a.run.id)));
    const group=candidates[0];if(!group)continue;
    const spend=group.rows.get('meta_spend_minor')!,impressions=group.rows.get('meta_impressions')!,outbound=group.rows.get('meta_outbound_clicks')!;
    const observedAt=String((spend.dimensions as Row)?.observedAt??group.run.source_as_of??group.run.started_at);
    if(!Number.isFinite(Date.parse(observedAt)))continue;
    const end=metaDayStart(Temporal.PlainDate.from(day).add({days:1}).toString(),config.timezone);
    result.daily.push({date:day,spendMinor:number(spend.value),impressions:number(impressions.value),outboundClicks:number(outbound.value),observedAt,provisional:Date.parse(observedAt)<Date.parse(end)});
  }
  const covered=new Set(result.daily.map(d=>d.date));result.coverage.coveredDays=covered.size;result.coverage.missingDays=dates.filter(d=>!covered.has(d));
  result.coverage.provisionalDays=result.daily.filter(d=>d.provisional).map(d=>d.date);result.coverage.unknownClickDays=result.daily.filter(d=>d.outboundClicks===null).map(d=>d.date);
  result.observedAt=result.daily.length?result.daily.map(d=>d.observedAt).sort()[0]:null;
  result.totals.spendMinor=sum(result.daily,'spendMinor');result.totals.impressions=sum(result.daily,'impressions');result.totals.outboundClicks=sum(result.daily,'outboundClicks');
  result.coverage.complete=!result.coverage.missingDays.length&&!result.coverage.provisionalDays.length&&result.daily.every(d=>d.spendMinor!==null&&d.impressions!==null&&d.outboundClicks!==null);
  // A common temporal cutoff is a valid observed ratio. Missing metrics on an
  // active day are different: never drop those days to fabricate a denominator.
  const first=result.daily[0]?.date,last=result.daily.at(-1)?.date;
  const contiguous=!!first&&!!last&&metaAccountDays(first,Temporal.PlainDate.from(last).add({days:1}).toString(),3660).length===result.daily.length;
  const knownSpend=result.daily.length>0&&result.daily.every(d=>d.spendMinor!==null),knownImpressions=result.daily.length>0&&result.daily.every(d=>d.impressions!==null),knownClicks=result.daily.length>0&&result.daily.every(d=>d.outboundClicks!==null);
  const {spendMinor,impressions,outboundClicks}=result.totals;
  result.ratioCoverage={from:first??null,to:last?Temporal.PlainDate.from(last).add({days:1}).toString():null,observedAt:result.observedAt,complete:result.coverage.complete,provisional:result.coverage.provisionalDays.length>0,contiguous,comparisonEligible:result.coverage.complete,
    numerators:{spendMinor:knownSpend?spendMinor:null,outboundClicks:knownClicks?outboundClicks:null},denominators:{impressions:knownImpressions?impressions:null,outboundClicks:knownClicks?outboundClicks:null}};
  if(contiguous&&knownImpressions&&impressions!==null&&impressions>0){
    result.totals.ctrPercent=knownClicks&&outboundClicks!==null?100*outboundClicks/impressions:null;
    result.totals.cpmMinor=knownSpend&&spendMinor!==null?1000*spendMinor/impressions:null;
  }
  if(contiguous&&knownClicks&&knownSpend&&outboundClicks!==null&&outboundClicks>0&&spendMinor!==null)result.totals.cpcMinor=spendMinor/outboundClicks;
  if(result.coverage.complete){
    result.status='complete';result.reason=null;
  }else if(result.daily.length){
    result.status='partial';result.reason=[result.coverage.missingDays.length?`${result.coverage.missingDays.length} jour(s) non importé(s)`:null,
      result.coverage.provisionalDays.length?`${result.coverage.provisionalDays.length} jour(s) relevé(s) avant leur clôture`:null,
      result.coverage.unknownClickDays.length?`${result.coverage.unknownClickDays.length} jour(s) sans clics sortants renseignés`:null,
      result.daily.some(d=>d.spendMinor===null||d.impressions===null)?'Dépenses ou impressions partiellement renseignées':null,
      contiguous?`Ratios observés sur le périmètre commun du ${first} au ${last} ; comparaison désactivée`:'Jours importés discontinus : ratios indisponibles'].filter(Boolean).join(' ; ');
  }
  return result;
}
