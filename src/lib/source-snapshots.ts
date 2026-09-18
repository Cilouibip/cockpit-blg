import type { Database, Row } from './db';
import { AppError } from './errors';
export interface SourceWindow {stream:string;profile:string;from:string;to:string;timezone:string;currency:string|null;currencyExponent:number|null;kind:'daily_bundle'|'exact_report'|'wix_report_daily'}
export interface SourceSnapshot { runs:Row[];aggregates:Row[];selections:{day:string;runId:string}[];validations:Record<string,{valid:boolean;totalMinor:number;hasBreakdown:boolean;wholeReportRowCount:number}>;exactRunId:string|null;latestAttempt:Row|null }
const cache=new WeakMap<Database,Map<string,{expires:number;value:Promise<SourceSnapshot>;settled:boolean}>>();
const cacheOwners=new WeakMap<Database,Database>();
const cacheOwner=(db:Database)=>cacheOwners.get(db)??db;
/** A read wrapper keeps the source cache identity of the database it delegates to. */
export function shareSourceSnapshotCache(db:Database,owner:Database):Database {cacheOwners.set(db,cacheOwner(owner));return db;}
function snapshotArgs(source:string,namespace:string,window:SourceWindow){return {p_source:source,p_namespace:namespace,p_stream:window.stream,p_profile:window.profile,p_from:window.from,p_to:window.to,p_timezone:window.timezone,p_currency:window.currency,p_currency_exponent:window.currencyExponent,p_kind:window.kind};}
/** One database snapshot, bounded to the requested grain and period; no source API calls. */
export function readSourceSnapshot(db:Database,source:string,namespace:string,window:SourceWindow):Promise<SourceSnapshot>{
 const owner=cacheOwner(db);
 let entries=cache.get(owner);if(!entries){entries=new Map();cache.set(owner,entries);}
 const now=Date.now();for(const [key,entry]of entries)if(entry.settled&&entry.expires<=now)entries.delete(key);
 const args=snapshotArgs(source,namespace,window);
 const key=JSON.stringify(args),hit=entries.get(key);if(hit&&(!hit.settled||hit.expires>now))return hit.value;
 while(entries.size>=128){const oldest=[...entries].find(([,entry])=>entry.settled);if(!oldest)throw new AppError('Trop de lectures simultanées. Réessaie dans un instant.',503,'source_window_busy');entries.delete(oldest[0]);}
 const value=db.rpc<SourceSnapshot>('cockpit_source_window',args).then(result=>{if(!result||!Array.isArray(result.runs)||!Array.isArray(result.aggregates)||!Array.isArray(result.selections)||!result.validations)throw new AppError('Lecture des observations indisponible.',503,'invalid_source_window');return result;});
 const entry={expires:now+30000,value,settled:false};entries.set(key,entry);value.then(()=>{entry.settled=true;},()=>{if(entries!.get(key)?.value===value)entries!.delete(key);});return value;
}
export function invalidateSourceSnapshots(db:Database){cache.delete(cacheOwner(db));}
/** Refresh only the exact publication requested; other source caches remain intact. */
export function invalidateSourceWindow(db:Database,source:string,namespace:string,window:SourceWindow){cache.get(cacheOwner(db))?.delete(JSON.stringify(snapshotArgs(source,namespace,window)));}

export function sourceAttempt(snapshot:SourceSnapshot):import('./ui-contract').SourceAttempt|null{
 const row=snapshot.latestAttempt;if(!row)return null;
 return {status:String(row.status),startedAt:row.started_at?String(row.started_at):null,finishedAt:row.finished_at?String(row.finished_at):null};
}
