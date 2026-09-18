import type {Database,Row,SelectOptions,TableName} from './db';
import {shareSourceSnapshotCache} from './source-snapshots';

/** Per-request FIFO bound for database reads. No global cache, state or retry. */
export function limitDatabaseReads(db:Database,maxConcurrent=4):Database {
 if(!Number.isInteger(maxConcurrent)||maxConcurrent<1)throw new Error('INVALID_DATABASE_CONCURRENCY');
 let active=0;const waiting:(()=>void)[]=[];
 const acquire=():Promise<void>=>{
  if(active<maxConcurrent&&waiting.length===0){active++;return Promise.resolve();}
  return new Promise<void>(resolve=>waiting.push(()=>{active++;resolve();}));
 };
 const run=async<T>(read:()=>Promise<T>):Promise<T>=>{
  await acquire();
  try{return await read();}
  finally{active--;waiting.shift()?.();}
 };
 return shareSourceSnapshotCache({
  select(table:TableName,options?:SelectOptions):Promise<Row[]>{return run(()=>db.select(table,options));},
  upsert(table:TableName,rows:Row[],conflict?:string):Promise<void>{return db.upsert(table,rows,conflict);},
  rpc<T=unknown>(name:string,args:Row):Promise<T>{return run(()=>db.rpc<T>(name,args));},
  probe():Promise<void>{return run(()=>db.probe());},
 },db);
}
