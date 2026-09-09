import { opaqueLimitKey } from './auth';
import type { Config } from './config';
import { database } from './db';
import { AppError } from './errors';
const localWindows=new Map<string,{count:number,end:number}>();
export async function rateLimit(config:Config,scope:string,identity:string,limit:number,seconds:number) {
  const key=opaqueLimitKey(scope,identity,config.sessionSecret);
  // The memory fallback is confined to localhost. Hosted requests use an atomic database limiter.
  if(config.local){const now=Date.now();for(const [k,v] of localWindows)if(v.end<=now)localWindows.delete(k);const bucket=localWindows.get(key)||{count:0,end:now+seconds*1000};bucket.count++;localWindows.set(key,bucket);if(bucket.count>limit)throw new AppError('Trop de demandes. Réessaie dans quelques minutes.',429,'rate_limited');return;}
  const allowed=await database().rpc<boolean>('consume_rate_limit',{p_key:key,p_limit:limit,p_seconds:seconds});
  if(!allowed)throw new AppError('Trop de demandes. Réessaie dans quelques minutes.',429,'rate_limited');
}
