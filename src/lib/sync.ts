import { getConfig } from './config';
import { database } from './db';
import { AppError } from './errors';
import { syncMeta } from '../connectors/meta';
import { startOfParisDay } from '../domain/dates';
import { Temporal } from '@js-temporal/polyfill';
import { synchronizeNotionChunk } from './sync-notion-business';
import { syncMetaAccountPeriod } from './sync-meta-account';
export async function synchronize(source:'meta'|'notion',from?:string,to?:string,options:{db?:ReturnType<typeof database>;env?:NodeJS.ProcessEnv;fetcher?:typeof fetch}={}){
  const config=getConfig();if(config.mode==='demo')throw new AppError('Les synchronisations réelles sont désactivées en mode test.',409,'demo_mode');
  if(source==='notion')return synchronizeNotionChunk(options);
  const today=Temporal.Now.plainDateISO('Europe/Paris');
  return syncMetaAccountPeriod(from??today.subtract({days:35}).toString(),to??today.add({days:1}).toString(),options);
}
export async function synchronizeMetaAds(from?:string,to?:string,options:{db?:ReturnType<typeof database>;env?:NodeJS.ProcessEnv;fetcher?:typeof fetch}={}){
  const source='meta' as const;
  const env=options.env??process.env,db=options.db??database();
  if(getConfig(env).mode==='demo')throw new AppError('Données de démonstration.',409,'demo_mode');
  await db.probe();
  const today=Temporal.Now.plainDateISO('Europe/Paris');
  const fromDay=from||today.subtract({days:35}).toString();const toDay=to||today.toString();
  if(Temporal.PlainDate.from(fromDay).until(Temporal.PlainDate.from(toDay)).days>93||fromDay>=toDay)throw new AppError('Choisis une période de 1 à 93 jours.',400,'invalid_period');
  const namespace=(env.META_AD_ACCOUNT_ID||'').replace(/^act_/,'');
  if(!namespace)throw new AppError('Les paramètres de cette source sont absents.',503,'source_missing');
  const start=startOfParisDay(fromDay);
  const end=startOfParisDay(toDay);
  const run=await db.rpc<string>('begin_sync_stream',{p_source:source,p_namespace:namespace,p_from:start,p_to:end,p_profile:`${env.META_API_VERSION||'v23.0'}-ad-day-none`,p_stream:'ad_daily',p_coverage_kind:'aggregate_period',p_date_from:fromDay,p_date_to:toDay});
  const commit=async(page:{records:unknown[];checkpoint:{cursor?:string}})=>{await db.rpc('import_meta_page',{p_run:run,p_records:page.records,p_cursor:page.checkpoint.cursor||null});};
  // Retry re-reads the bounded partition from the start. Prior pages cannot be lost under a new published run.
  const result=await syncMeta({accessToken:env.META_ACCESS_TOKEN,accountId:namespace,apiVersion:env.META_API_VERSION||'v23.0',from:fromDay,to:toDay,maxPages:20,commitPage:commit,fetcher:options.fetcher});
  const status=result.status==='not_configured'?'failed':result.status;
  await db.rpc('finish_sync',{p_run:run,p_status:status,p_read:result.counts.read,p_rejected:result.counts.rejected,p_complete:result.coverage.complete,p_error:result.safeError?result.safeError.replace(/[^A-Za-z0-9_ -]/g,'').slice(0,100):null});
  return {status,counts:result.counts,coverage:result.coverage,runId:run};
}
