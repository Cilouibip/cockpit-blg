import type { Database, Row, TableName, SelectOptions } from '../../src/lib/db';
export function memoryKpiDatabase(initial: Partial<Record<TableName,Row[]>> = {}, clock: ()=>string = ()=>new Date().toISOString()) {
 const tables = new Map<TableName,Row[]>(Object.entries(initial) as [TableName,Row[]][]);let sequence=0;
 const get=(table:TableName)=>{let rows=tables.get(table);if(!rows){rows=[];tables.set(table,rows);}return rows;};
 const select=(table:TableName,o:SelectOptions={})=>get(table).filter(row=>Object.entries(o.eq??{}).every(([k,v])=>String(row[k])===v)&&Object.entries(o.in??{}).every(([k,v])=>v.includes(String(row[k])))&&Object.entries(o.gte??{}).every(([k,v])=>String(row[k])>=v)&&Object.entries(o.lt??{}).every(([k,v])=>String(row[k])<v)).sort((a,b)=>{for(const key of (o.order??'id').split(',')){const cmp=String(a[key]??'').localeCompare(String(b[key]??''));if(cmp)return o.descending?-cmp:cmp;}return 0;}).slice(o.from??0,(o.from??0)+(o.limit??1000));
 const db:Database={select:async(t,o)=>structuredClone(select(t,o)),upsert:async(t,rows,conflict='id')=>{for(const row of rows){const keys=conflict.split(','),prior=get(t).find(r=>keys.every(k=>r[k]===row[k]));if(prior)Object.assign(prior,structuredClone(row));else get(t).push({id:`row-${++sequence}`,...structuredClone(row)});}},rpc:async<T>(name:string,args:Row):Promise<T>=>{
  if(name==='begin_sync_stream'){const id=`run-${++sequence}`;get('sync_runs').push({id,source:args.p_source,source_namespace:args.p_namespace,stream_key:args.p_stream,query_profile_key:args.p_profile,period_from:args.p_from,period_to:args.p_to,started_at:clock(),status:'running'});return id as T;}
  if(name==='finish_sync'){const row=get('sync_runs').find(r=>r.id===args.p_run);if(!row)throw Error('RUN_MISSING');Object.assign(row,{status:args.p_status,finished_at:clock(),pagination_complete:args.p_complete,rows_rejected:args.p_rejected,error_code:args.p_error});return null as T;}
  throw Error('UNEXPECTED_RPC');
 },probe:async()=>{}};
 return {db,tables,get,select};
}
