import type { Database, Row, TableName, SelectOptions } from '../../src/lib/db';
export function memoryKpiDatabase(initial: Partial<Record<TableName,Row[]>> = {}, clock: ()=>string = ()=>new Date().toISOString()) {
 const tables = new Map<TableName,Row[]>(Object.entries(initial) as [TableName,Row[]][]);let sequence=0;
 const get=(table:TableName)=>{let rows=tables.get(table);if(!rows){rows=[];tables.set(table,rows);}return rows;};
 const select=(table:TableName,o:SelectOptions={})=>get(table).filter(row=>Object.entries(o.eq??{}).every(([k,v])=>String(row[k])===v)&&Object.entries(o.in??{}).every(([k,v])=>v.includes(String(row[k])))&&Object.entries(o.gte??{}).every(([k,v])=>String(row[k])>=v)&&Object.entries(o.lt??{}).every(([k,v])=>String(row[k])<v)).sort((a,b)=>{for(const key of (o.order??'id').split(',')){const cmp=String(a[key]??'').localeCompare(String(b[key]??''));if(cmp)return o.descending?-cmp:cmp;}return 0;}).slice(o.from??0,(o.from??0)+(o.limit??1000));
 const db:Database={select:async(t,o)=>structuredClone(select(t,o)),upsert:async(t,rows,conflict='id')=>{for(const row of rows){const keys=conflict.split(','),prior=get(t).find(r=>keys.every(k=>r[k]===row[k]));if(prior)Object.assign(prior,structuredClone(row));else get(t).push({id:`row-${++sequence}`,...structuredClone(row)});}},rpc:async<T>(name:string,args:Row):Promise<T>=>{
  if(name==='begin_sync_stream'){const id=`run-${++sequence}`;get('sync_runs').push({id,source:args.p_source,source_namespace:args.p_namespace,stream_key:args.p_stream,query_profile_key:args.p_profile,period_from:args.p_from,period_to:args.p_to,started_at:clock(),status:'running'});return id as T;}
  if(name==='finish_sync'){const row=get('sync_runs').find(r=>r.id===args.p_run);if(!row)throw Error('RUN_MISSING');Object.assign(row,{status:args.p_status,finished_at:clock(),pagination_complete:args.p_complete,rows_rejected:args.p_rejected,error_code:args.p_error});return null as T;}
  // Publication d'état des flux KPI (migration 018) : même règle que la fonction SQL cockpit_publish_aggregate_state,
  // réduite aux tables du double. Identique = ligne courante confirmée, différente = mise à jour en place, nouvelle = promue,
  // absente du périmètre = retirée (is_current=false, conservée) ; rejeu d'une tentative terminée = accusé sans changement.
  if(name==='cockpit_publish_aggregate_state'){
   const run=get('sync_runs').find(r=>r.id===args.p_run);if(!run)throw Error('RUN_MISSING');
   if(['complete','empty'].includes(String(run.status)))return {status:run.status,duplicate:true,rowsWritten:run.rows_written} as T;
   const rows=get('source_aggregates'),metrics=String(args.p_metric_keys).replace(/[{}]/g,'').split(',');
   const key=(r:Row)=>['source','source_namespace','report_profile_key','metric_key','period_from','period_to','dimensions_key'].map(k=>String(r[k])).join('|');
   for(const row of rows.filter(r=>r.sync_run_id===run.id&&!r.is_current)){const current=rows.find(r=>r.is_current&&key(r)===key(row));if(current){Object.assign(current,{...row,id:current.id,is_current:true});rows.splice(rows.indexOf(row),1);}}
   // Réapparition (migration 022) : sans ligne courante, une ligne retirée de même clé (tentative terminée) redevient courante, même id.
   for(const row of rows.filter(r=>r.sync_run_id===run.id&&!r.is_current)){const retired=rows.filter(r=>!r.is_current&&r.sync_run_id!==run.id&&key(r)===key(row)&&['complete','empty'].includes(String(get('sync_runs').find(x=>x.id===r.sync_run_id)?.status))).at(-1);if(retired){Object.assign(retired,{...row,id:retired.id,is_current:true});rows.splice(rows.indexOf(row),1);}}
   const inScope=(r:Row)=>r.source===run.source&&r.source_namespace===run.source_namespace&&r.report_profile_key===run.query_profile_key&&metrics.includes(String(r.metric_key))&&String(r.period_from)>=String(run.period_from)&&String(r.period_to)<=String(run.period_to);
   for(const row of rows)if(row.is_current&&row.sync_run_id!==run.id&&inScope(row))row.is_current=false;
   for(const row of rows)if(row.sync_run_id===run.id)row.is_current=true;
   const current=rows.filter(r=>r.is_current&&r.sync_run_id===run.id).length;
   Object.assign(run,{status:current?'complete':'empty',finished_at:clock(),pagination_complete:true,rows_rejected:0,rows_written:current,error_code:null});
   return {status:run.status,duplicate:false,rowsWritten:current} as T;
  }
  throw Error('UNEXPECTED_RPC');
 },probe:async()=>{}};
 return {db,tables,get,select};
}
