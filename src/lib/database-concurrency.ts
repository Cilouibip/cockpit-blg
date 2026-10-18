import type {Database,Row,SelectOptions,TableName} from './db';
import {shareSourceSnapshotCache} from './source-snapshots';

const heavyReads=new Set(['cockpit_business_rollup','cockpit_lead_entry_rollup_v2','cockpit_source_window']);

function readQueue(maxConcurrent:number){
 let active=0;const waiting:(()=>void)[]=[];
 const acquire=():Promise<void>=>{
  if(active<maxConcurrent&&waiting.length===0){active++;return Promise.resolve();}
  return new Promise<void>(resolve=>waiting.push(()=>{active++;resolve();}));
 };
 return async<T>(read:()=>Promise<T>):Promise<T>=>{
  await acquire();
  try{return await read();}
  finally{active--;waiting.shift()?.();}
 };
}

/** Per-request queues: heavy reports share one slot, other reads remain bounded. */
export function limitDatabaseReads(db:Database,maxConcurrent=4):Database {
 if(!Number.isInteger(maxConcurrent)||maxConcurrent<1)throw new Error('INVALID_DATABASE_CONCURRENCY');
 const run=readQueue(maxConcurrent),runHeavy=readQueue(1);
 return shareSourceSnapshotCache({
  select(table:TableName,options?:SelectOptions):Promise<Row[]>{return run(()=>db.select(table,options));},
  upsert(table:TableName,rows:Row[],conflict?:string):Promise<void>{return db.upsert(table,rows,conflict);},
  rpc<T=unknown>(name:string,args:Row,options?:Parameters<Database['rpc']>[2]):Promise<T>{
   const read=()=>run(()=>db.rpc<T>(name,args,options));
   // Wait outside the general queue so queued reports cannot starve light reads.
   return heavyReads.has(name)?runHeavy(read):read();
  },
  probe():Promise<void>{return run(()=>db.probe());},
 },db);
}
