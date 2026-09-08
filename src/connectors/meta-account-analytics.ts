import { Temporal } from '@js-temporal/polyfill';
import { moneyFromDecimal } from '../domain/metrics';
import { ConnectorError, integer, object, readJson, safeConnectorError } from './http';

export const META_ACCOUNT_PROFILE = 'meta-account-day-v1';
export const META_ACCOUNT_STREAM = 'meta_account_daily';
export type MetaClickEvidence = 'explicit' | 'zero_delivery' | 'no_reported_activity' | 'omitted';
export interface MetaAccountDay {
  date: string; spendMinor: number | null; impressions: number | null; outboundClicks: number | null;
  clickEvidence: MetaClickEvidence; rowReported: boolean;
}
export interface MetaAccountConfig {
  from: string; to: string; accountId?: string; accessToken?: string; apiVersion?: string;
  currency?: string; timezone?: string; currencyExponent?: number; fetcher?: typeof fetch; now?: () => string;
}
export interface MetaAccountReport {
  source: 'meta'; profile: typeof META_ACCOUNT_PROFILE; accountId: string; from: string; to: string;
  currency: string; timezone: string; currencyExponent: number; observedAt: string;
  status: 'complete' | 'failed' | 'not_configured'; days: MetaAccountDay[];
  counts: {read:number;accepted:number;rejected:number;pages:number};
  coverage: {complete:boolean;reason?:string}; safeError?:string;
}
/** Calendar partitions are intentionally small enough for one account Insights page.
 * No raw ad, person or conversion data is requested. */
export function metaAccountDays(from:string,to:string,maxDays=93) {
  const start=Temporal.PlainDate.from(from),end=Temporal.PlainDate.from(to),days:string[]=[];
  if(start.toString()!==from||end.toString()!==to||Temporal.PlainDate.compare(start,end)>=0||start.until(end).days>maxDays)throw new ConnectorError('INVALID_PERIOD');
  for(let day=start;Temporal.PlainDate.compare(day,end)<0;day=day.add({days:1}))days.push(day.toString());
  return days;
}
function count(value:unknown) {
  if(value===undefined||value===null)return null;
  const result=integer(value);if(result===null)throw new ConnectorError('INVALID_META_COUNT');return result;
}
export async function readMetaAccountAnalytics(config:MetaAccountConfig):Promise<MetaAccountReport> {
  const accountId=(config.accountId??'').replace(/^act_/,'');
  const report:MetaAccountReport={source:'meta',profile:META_ACCOUNT_PROFILE,accountId,from:config.from,to:config.to,
    currency:config.currency??'EUR',timezone:config.timezone??'Europe/Paris',currencyExponent:config.currencyExponent??2,
    observedAt:config.now?.()??new Date().toISOString(),status:'not_configured',days:[],
    counts:{read:0,accepted:0,rejected:0,pages:0},coverage:{complete:false,reason:'Connexion Meta non configurée.'}};
  if(!accountId||!config.accessToken)return report;
  try {
    const days=metaAccountDays(config.from,config.to),version=config.apiVersion??'v23.0';
    if(!/^\d{1,30}$/.test(accountId)||!/^v\d+\.0$/.test(version)||Number(version.slice(1).split('.')[0])<23)throw new ConnectorError('INVALID_CONFIGURATION');
    Temporal.Instant.from(report.observedAt);
    const tomorrow=Temporal.Instant.from(report.observedAt).toZonedDateTimeISO(report.timezone).toPlainDate().add({days:1}).toString();
    if(config.to>tomorrow)throw new ConnectorError('FUTURE_PERIOD');
    const headers={Authorization:`Bearer ${config.accessToken}`},options={fetcher:config.fetcher,attempts:1,timeoutMs:20_000};
    const accountUrl=new URL(`https://graph.facebook.com/${version}/act_${accountId}`);
    accountUrl.searchParams.set('fields','account_id,currency,timezone_name');
    const account=object(await readJson(accountUrl,{method:'GET',headers},options));
    if(account.account_id!==accountId||account.currency!==report.currency||account.timezone_name!==report.timezone)throw new ConnectorError('ACCOUNT_IDENTITY_MISMATCH');
    const url=new URL(`https://graph.facebook.com/${version}/act_${accountId}/insights`);
    url.searchParams.set('fields','account_id,date_start,date_stop,spend,impressions,outbound_clicks');
    url.searchParams.set('level','account');url.searchParams.set('time_increment','1');url.searchParams.set('limit','100');
    url.searchParams.set('time_range',JSON.stringify({since:config.from,until:days.at(-1)}));
    const payload=object(await readJson(url,{method:'GET',headers},options));report.counts.pages=1;
    if(!Array.isArray(payload.data))throw new ConnectorError('INVALID_RESPONSE');
    // At most 93 unique days. Unexpected pagination cannot certify absent-day zeros.
    if(payload.paging&&object(payload.paging).next)throw new ConnectorError('UNEXPECTED_PAGINATION');
    const byDay=new Map<string,MetaAccountDay>();
    for(const raw of payload.data){
      report.counts.read++;const row=object(raw),day=row.date_start;
      if(row.account_id!==accountId||typeof day!=='string'||!days.includes(day)||row.date_stop!==day||byDay.has(day))throw new ConnectorError('INVALID_META_DAY');
      const spendMinor=row.spend===undefined||row.spend===null?null:moneyFromDecimal(String(row.spend),report.currency,report.currencyExponent).minor;
      const impressions=count(row.impressions);let outboundClicks:number|null=null,clickEvidence:MetaClickEvidence='omitted';
      if(row.outbound_clicks!==undefined&&row.outbound_clicks!==null){
        if(!Array.isArray(row.outbound_clicks))throw new ConnectorError('INVALID_META_COUNT');
        const outbound=row.outbound_clicks.map(object).filter(a=>a.action_type==='outbound_click');
        if(outbound.length>1)throw new ConnectorError('INVALID_META_COUNT');
        if(outbound.length){outboundClicks=count(outbound[0].value);if(outboundClicks!==null)clickEvidence='explicit';}
      }
      if(outboundClicks===null&&spendMinor===0&&impressions===0){outboundClicks=0;clickEvidence='zero_delivery';}
      byDay.set(day,{date:day,spendMinor,impressions,outboundClicks,clickEvidence,rowReported:true});
    }
    // A completed account/day query without filters reports activity for the exact
    // requested account. Missing days are absence of reported delivery, not an API
    // failure or a metric omitted from an otherwise active row.
    report.days=days.map(date=>byDay.get(date)??{date,spendMinor:0,impressions:0,outboundClicks:0,clickEvidence:'no_reported_activity',rowReported:false});
    report.counts.accepted=report.days.length;report.coverage={complete:true};report.status='complete';return report;
  }catch(error){report.status='failed';report.safeError=safeConnectorError(error);report.coverage={complete:false,reason:'Lecture Meta interrompue ; dernier relevé complet conservé.'};return report;}
}
