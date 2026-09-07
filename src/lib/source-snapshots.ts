import type { Database, Row, TableName } from './db';
import { AppError } from './errors';

export interface SourceSnapshot { runs: Row[]; aggregates: Row[] }
const cache = new WeakMap<Database, Map<string, { expires: number; value: Promise<SourceSnapshot> }>>();
async function pages(db: Database, table: TableName, eq: Record<string,string>) {
 const rows: Row[]=[];
 for(let from=0;from<100000;from+=1000){
  const page=await db.select(table,{eq,from,limit:1000});rows.push(...page);
  if(page.length<1000)return rows;
 }
 throw new AppError('Historique trop volumineux pour cette lecture.',422,'read_limit');
}
/** Only stored aggregates, never source APIs or CRM records. A short server cache
 * shares the same completed snapshots across current/comparison filter reads. */
export function readSourceSnapshot(db:Database,source:string,namespace:string):Promise<SourceSnapshot>{
 let entries=cache.get(db);if(!entries){entries=new Map();cache.set(db,entries);}
 const key=`${source}:${namespace}`,hit=entries.get(key);if(hit&&hit.expires>Date.now())return hit.value;
 const value=Promise.all([
  pages(db,'sync_runs',{source,source_namespace:namespace,status:'complete'}),
  pages(db,'source_aggregates',{source,source_namespace:namespace,coverage_state:'complete'}),
 ]).then(([runs,aggregates])=>({runs:runs.filter(r=>r.pagination_complete===true),aggregates}));
 entries.set(key,{expires:Date.now()+30000,value});
 value.catch(()=>{if(entries!.get(key)?.value===value)entries!.delete(key);});
 return value;
}
export function invalidateSourceSnapshots(db:Database){cache.delete(db);}
