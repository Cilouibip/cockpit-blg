import { getConfig } from './config';
import { database } from './db';
import { AppError } from './errors';
import { syncMeta } from '../connectors/meta';
import { syncNotion, BLG_NOTION_FIELDS } from '../connectors/notion';
import { startOfParisDay } from '../domain/dates';
import { Temporal } from '@js-temporal/polyfill';
export async function synchronize(source:'meta'|'notion',from?:string,to?:string){
  const config=getConfig();if(config.mode==='demo')throw new AppError('Les synchronisations réelles sont désactivées en mode test.',409,'demo_mode');
  const db=database();await db.probe();
  const today=Temporal.Now.plainDateISO('Europe/Paris');
  const fromDay=from||today.subtract({days:35}).toString();const toDay=to||today.toString();
  if(Temporal.PlainDate.from(fromDay).until(Temporal.PlainDate.from(toDay)).days>93||fromDay>=toDay)throw new AppError('Choisis une période de 1 à 93 jours.',400,'invalid_period');
  const namespace=source==='meta'?(process.env.META_AD_ACCOUNT_ID||'').replace(/^act_/,''):process.env.NOTION_DATA_SOURCE_ID||'';
  if(!namespace)throw new AppError('Les paramètres de cette source sont absents.',503,'source_missing');
  const start=source==='notion'?'1970-01-01T00:00:00.000Z':startOfParisDay(fromDay);
  const end=source==='notion'?new Date().toISOString():startOfParisDay(toDay);
  const run=await db.rpc<string>('begin_sync',{p_source:source,p_namespace:namespace,p_from:start,p_to:end,p_profile:source==='meta'?`${process.env.META_API_VERSION||'v23.0'}-ad-day-none`:'notion-commercial-v1',p_coverage_kind:source==='notion'?'source_snapshot':'aggregate_period',p_date_from:source==='meta'?fromDay:null,p_date_to:source==='meta'?toDay:null});
  const commit=async(page:{records:unknown[];checkpoint:{cursor?:string}})=>{await db.rpc(source==='meta'?'import_meta_page':'import_notion_page',{p_run:run,p_records:page.records,p_cursor:page.checkpoint.cursor||null});};
  // Retry re-reads the bounded partition from the start. Prior pages cannot be lost under a new published run.
  const result=source==='meta'?await syncMeta({accessToken:process.env.META_ACCESS_TOKEN,accountId:namespace,apiVersion:process.env.META_API_VERSION||'v23.0',from:fromDay,to:toDay,maxPages:20,commitPage:commit}):await syncNotion({token:process.env.NOTION_TOKEN,dataSourceId:namespace,fields:BLG_NOTION_FIELDS,mappingVersion:'blg-commercial-2026-09-07',from:start,to:end,maxPages:20,commitPage:commit});
  const status=result.status==='not_configured'?'failed':result.status;
  await db.rpc('finish_sync',{p_run:run,p_status:status,p_read:result.counts.read,p_rejected:result.counts.rejected,p_complete:result.coverage.complete,p_error:result.safeError?result.safeError.replace(/[^A-Za-z0-9_ -]/g,'').slice(0,100):null});
  return {status,counts:result.counts,coverage:result.coverage,runId:run};
}
