import { Temporal } from '@js-temporal/polyfill';
import { readMetaAccountAnalytics, metaAccountDays, META_ACCOUNT_PROFILE, META_ACCOUNT_STREAM } from '../connectors/meta-account-analytics';
import { database, type Database, type Row } from './db';
import { invalidateSourceSnapshots } from './source-snapshots';

export type MetaEnvironment=Record<string,string|undefined>;
export function metaAccountEnvironment(env:MetaEnvironment=process.env) {
  return {accountId:env.META_AD_ACCOUNT_ID?.replace(/^act_/,''),accessToken:env.META_ACCESS_TOKEN,apiVersion:env.META_API_VERSION??'v23.0',
    currency:env.COCKPIT_CURRENCY??'EUR',timezone:env.COCKPIT_TIMEZONE??'Europe/Paris',currencyExponent:Number(env.COCKPIT_CURRENCY_EXPONENT??2)};
}
export function metaDayStart(day:string,timezone:string){return Temporal.PlainDate.from(day).toZonedDateTime({timeZone:timezone,plainTime:'00:00'}).toInstant().toString();}

export async function syncMetaAccountPeriod(from:string,to:string,options:{db?:Database;env?:MetaEnvironment;reader?:typeof readMetaAccountAnalytics;fetcher?:typeof fetch}={}) {
  const env=options.env??process.env,config=metaAccountEnvironment(env),db=options.db??database();
  metaAccountDays(from,to);
  if(env.COCKPIT_MODE==='demo')return {status:'not_configured',runId:null,counts:{read:0,accepted:0,rejected:0,pages:0},coverage:{complete:false,reason:'Mode démonstration.'}};
  if(!config.accountId||!config.accessToken)return {status:'not_configured',runId:null,counts:{read:0,accepted:0,rejected:0,pages:0},coverage:{complete:false,reason:'Connexion Meta non configurée.'}};
  const runId=await db.rpc<string>('begin_sync_stream',{p_source:'meta',p_namespace:config.accountId,p_from:metaDayStart(from,config.timezone),p_to:metaDayStart(to,config.timezone),p_profile:META_ACCOUNT_PROFILE,p_coverage_kind:'aggregate_period',p_stream:META_ACCOUNT_STREAM,p_date_from:from,p_date_to:to});
  try {
    const report=await(options.reader??readMetaAccountAnalytics)({...config,from,to,fetcher:options.fetcher});
    if(report.coverage.complete&&report.status==='complete'){
      const rows:Row[]=[];
      for(const day of report.days){
        const start=metaDayStart(day.date,report.timezone),end=metaDayStart(Temporal.PlainDate.from(day.date).add({days:1}).toString(),report.timezone);
        for(const [metric,value]of [['spend_minor',day.spendMinor],['impressions',day.impressions],['outbound_clicks',day.outboundClicks]]as const)
          rows.push({source:'meta',source_namespace:config.accountId,metric_key:`meta_${metric}`,period_from:start,period_to:end,dimensions_key:'account',report_profile_key:META_ACCOUNT_PROFILE,sync_run_id:runId,timezone:report.timezone,coverage_state:'complete',value,
            unit:metric==='spend_minor'?'minor':'count',currency:metric==='spend_minor'?report.currency:null,currency_exponent:metric==='spend_minor'?report.currencyExponent:null,tax_basis:'unknown',
            dimensions:{date:day.date,scope:'account',rowReported:day.rowReported,clickEvidence:day.clickEvidence,observedAt:report.observedAt},definition_version:META_ACCOUNT_PROFILE,source_locator:`meta:account:daily:${day.date}`});
      }
      await db.upsert('source_aggregates',rows,'source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id');
    }
    const status=report.status==='not_configured'?'failed':report.status;
    await db.rpc('finish_sync',{p_run:runId,p_status:status,p_read:report.counts.read,p_rejected:report.counts.rejected,p_complete:report.coverage.complete,p_error:report.safeError?.replace(/[^A-Za-z0-9_ -]/g,'').slice(0,100)??null});
    invalidateSourceSnapshots(db);return {status,runId,counts:report.counts,coverage:report.coverage};
  }catch{
    await db.rpc('finish_sync',{p_run:runId,p_status:'failed',p_read:0,p_rejected:0,p_complete:false,p_error:'META_ACCOUNT_IMPORT_FAILED'}).catch(()=>undefined);
    return {status:'failed',runId,counts:{read:0,accepted:0,rejected:0,pages:0},coverage:{complete:false,reason:'Import Meta échoué ; dernier relevé complet conservé.'}};
  }
}
