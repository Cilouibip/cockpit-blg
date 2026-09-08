import type { Database, Row } from './db';
import { AppError } from './errors';
export interface SourceWindow {stream:string;profile:string;from:string;to:string;timezone:string;currency:string|null;currencyExponent:number|null;kind:'daily_bundle'|'exact_report'|'wix_report_daily'}
export interface SourceSnapshot { runs:Row[];aggregates:Row[];selections:{day:string;runId:string}[];validations:Record<string,{valid:boolean;totalMinor:number;hasBreakdown:boolean;wholeReportRowCount:number}>;exactRunId:string|null;latestAttempt:Row|null }
const cache=new WeakMap<Database,Map<string,{expires:number;value:Promise<SourceSnapshot>;settled:boolean}>>();
/** One database snapshot, bounded to the requested grain and period; no source API calls. */
export function readSourceSnapshot(db:Database,source:string,namespace:string,window:SourceWindow):Promise<SourceSnapshot>{
 let entries=cache.get(db);if(!entries){entries=new Map();cache.set(db,entries);}
 const now=Date.now();for(const [key,entry]of entries)if(entry.settled&&entry.expires<=now)entries.delete(key);
 const args={p_source:source,p_namespace:namespace,p_stream:window.stream,p_profile:window.profile,p_from:window.from,p_to:window.to,p_timezone:window.timezone,p_currency:window.currency,p_currency_exponent:window.currencyExponent,p_kind:window.kind};
 const key=JSON.stringify(args),hit=entries.get(key);if(hit&&(!hit.settled||hit.expires>now))return hit.value;
 while(entries.size>=128){const oldest=[...entries].find(([,entry])=>entry.settled);if(!oldest)throw new AppError('Trop de lectures simultanées. Réessaie dans un instant.',503,'source_window_busy');entries.delete(oldest[0]);}
 const value=db.rpc<SourceSnapshot>('cockpit_source_window',args).then(result=>{if(!result||!Array.isArray(result.runs)||!Array.isArray(result.aggregates)||!Array.isArray(result.selections)||!result.validations)throw new AppError('Lecture des observations indisponible.',503,'invalid_source_window');return result;});
 const entry={expires:now+30000,value,settled:false};entries.set(key,entry);value.then(()=>{entry.settled=true;},()=>{if(entries!.get(key)?.value===value)entries!.delete(key);});return value;
}
export function invalidateSourceSnapshots(db:Database){cache.delete(db);}

export function sourceAttempt(snapshot:SourceSnapshot):import('./ui-contract').SourceAttempt|null{
 const row=snapshot.latestAttempt;if(!row)return null;
 return {status:String(row.status),startedAt:row.started_at?String(row.started_at):null,finishedAt:row.finished_at?String(row.finished_at):null};
}
