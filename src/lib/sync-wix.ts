import { Temporal } from '@js-temporal/polyfill';
import { syncWixPaymentsAnalytics, WIX_PAYMENTS_ANALYTICS_MAPPING } from '../connectors/wix-payments-analytics';
import { startOfParisDay } from '../domain/dates';
import { database, type Database } from './db';
import { getConfig } from './config';
import { AppError } from './errors';
import type { Metric } from './ui-contract';
import { readSourceSnapshot, invalidateSourceSnapshots } from './source-snapshots';

type Options = { db?: Database; reader?: typeof syncWixPaymentsAnalytics; env?: NodeJS.ProcessEnv };
/** Publish a complete, reconciled source aggregate only after all pages were read.
 * Exact periods remain separate: a monthly total is never spread over days. */
export async function synchronizeWix(from: string, to: string, options: Options = {}) {
  const env = options.env ?? process.env;
  if (getConfig(env).mode === 'demo') throw new AppError('La synchronisation réelle est désactivée en démonstration.', 409, 'demo_mode');
  const days = Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to)).days;
  if (days < 1 || days > 367) throw new AppError('Choisis une période de 1 à 367 jours.', 400, 'invalid_period');
  const namespace = env.WIX_SITE_ID;
  if (!namespace || !env.WIX_API_KEY) throw new AppError('La connexion Wix doit être renseignée.', 503, 'source_missing');
  const db = options.db ?? database(), start = startOfParisDay(from), end = startOfParisDay(to);
  const runId = await db.rpc<string>('begin_sync', { p_source: 'wix', p_namespace: namespace, p_from: start, p_to: end,
    p_profile: WIX_PAYMENTS_ANALYTICS_MAPPING.version, p_coverage_kind: 'aggregate_period', p_date_from: from, p_date_to: to });
  let finished = false;
  try {
    const result = await (options.reader ?? syncWixPaymentsAnalytics)({ apiKey: env.WIX_API_KEY, siteId: namespace,
      from: start, to: end, timezone: 'Europe/Paris' });
    if (result.status === 'complete' && result.coverage.complete) {
      const daily = new Map<string, number>();
      for (const row of result.breakdown) {
        if (!row.dimensions.day || row.values.revenue === null) continue;
        const day = Temporal.Instant.from(row.dimensions.day).toZonedDateTimeISO('Europe/Paris').toPlainDate().toString();
        daily.set(day, (daily.get(day) ?? 0) + row.values.revenue);
      }
      const rows = result.records.map(record => ({
        source: 'wix', source_namespace: namespace, metric_key: record.metric, period_from: start, period_to: end,
        dimensions_key: 'all', report_profile_key: WIX_PAYMENTS_ANALYTICS_MAPPING.version, sync_run_id: runId,
        timezone: 'Europe/Paris', coverage_state: 'complete', value: record.amount?.minor ?? record.count,
        unit: record.amount ? 'minor' : 'count', currency: record.amount?.currency ?? null, currency_exponent: record.amount ? 2 : null,
        tax_basis: record.taxBasis === 'gross' ? 'tax_inclusive' : 'unknown', dimensions: {},
        definition_version: record.metric === 'net_cash' ? 'net-ttc-v1' : WIX_PAYMENTS_ANALYTICS_MAPPING.version,
        source_locator: `wix:analytics:${WIX_PAYMENTS_ANALYTICS_MAPPING.modelSlug}:${record.externalId}`,
      }));
      for (const [day, minor] of daily) {
        if (!Number.isSafeInteger(minor)) throw new AppError('Montant Wix hors limite.', 422, 'invalid_record');
        rows.push({ source:'wix',source_namespace:namespace,metric_key:'wix_daily_revenue',period_from:start,period_to:end,
          dimensions_key:`day:${day}`,report_profile_key:WIX_PAYMENTS_ANALYTICS_MAPPING.version,sync_run_id:runId,
          timezone:'Europe/Paris',coverage_state:'complete',value:minor,unit:'minor',currency:'EUR',currency_exponent:2,
          tax_basis:'tax_inclusive',dimensions:{date:day},definition_version:WIX_PAYMENTS_ANALYTICS_MAPPING.version,
          source_locator:`wix:analytics:${WIX_PAYMENTS_ANALYTICS_MAPPING.modelSlug}:day:${day}` });
      }
      await db.upsert('source_aggregates', rows, 'source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id');
    }
    const status = result.status === 'not_configured' ? 'failed' : result.status;
    await db.rpc('finish_sync', { p_run: runId, p_status: status, p_read: result.counts.read, p_rejected: result.counts.rejected,
      // An empty query completed its pagination, but carries no measured zero.
      p_complete: result.coverage.complete || result.status === 'empty',
      p_error: result.safeError?.replace(/[^A-Za-z0-9_ -]/g, '').slice(0,100) ?? null });
    finished = true;
    invalidateSourceSnapshots(db);
    return { status, counts: result.counts, coverage: result.coverage, runId, netAvailable: result.normalizedNetEligible };
  } finally {
    if (!finished) await db.rpc('finish_sync', { p_run: runId, p_status: 'failed', p_read: 0, p_rejected: 0, p_complete: false, p_error: 'WIX_IMPORT_FAILED' }).catch(() => undefined);
  }
}

/** Recompose arbitrary periods from complete, reconciled daily reports. Each
 * day belongs to one latest successful report, so overlaps never double-count.
 * Missing days inside a fully reconciled report mean no revenue that day;
 * missing report coverage never becomes zero. */
export async function readWixReportedPeriod(db: Database, from: string, to: string): Promise<{cash:Metric;dailyRevenue:{date:string;value:number}[]} | null> {
 const namespace=process.env.WIX_SITE_ID;if(!namespace)return null;
 const snapshot=await readSourceSnapshot(db,'wix',namespace);
 const validReports=snapshot.runs.filter(run=>run.query_profile_key===WIX_PAYMENTS_ANALYTICS_MAPPING.version).flatMap(run=>{
  const rows=snapshot.aggregates.filter(row=>row.sync_run_id===run.id&&row.report_profile_key===WIX_PAYMENTS_ANALYTICS_MAPPING.version&&
   row.currency==='EUR'&&row.currency_exponent===2&&row.unit==='minor'&&row.tax_basis==='tax_inclusive'&&row.timezone==='Europe/Paris'&&
   row.value!==null&&Number.isSafeInteger(Number(row.value))&&Date.parse(String(row.period_from))===Date.parse(String(run.period_from))&&Date.parse(String(row.period_to))===Date.parse(String(run.period_to)));
  const total=rows.find(row=>row.metric_key==='wix_total_revenue'&&row.dimensions_key==='all');if(!total)return [];
  const daily=new Map<string,number>();
  for(const row of rows.filter(row=>row.metric_key==='wix_daily_revenue')){
   const day=(row.dimensions as {date?:unknown})?.date;
   if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||daily.has(day))return [];
   const instant=Date.parse(startOfParisDay(day));if(instant<Date.parse(String(run.period_from))||instant>=Date.parse(String(run.period_to)))return [];
   daily.set(day,Number(row.value));
  }
  // Historical reports without their daily breakdown cannot answer subperiods.
  const hasBreakdown=[...daily.values()].reduce((n,v)=>n+BigInt(v),0n)===BigInt(Number(total.value));
  return [{run,daily,total:Number(total.value),hasBreakdown}];
 }).sort((a,b)=>String(b.run.finished_at).localeCompare(String(a.run.finished_at))||String(b.run.id).localeCompare(String(a.run.id)));
 const exact=validReports.find(({run})=>Date.parse(String(run.period_from))===Date.parse(startOfParisDay(from))&&Date.parse(String(run.period_to))===Date.parse(startOfParisDay(to)));
 const reports=validReports.filter(report=>report.hasBreakdown);
 const dailyRevenue:{date:string;value:number}[]=[],used=new Set<string>();let minor=0n,missing=0;
 for(let day=Temporal.PlainDate.from(from);Temporal.PlainDate.compare(day,Temporal.PlainDate.from(to))<0;day=day.add({days:1})){
  const date=day.toString(),at=Date.parse(startOfParisDay(date));
  const report=reports.find(({run})=>at>=Date.parse(String(run.period_from))&&Date.parse(startOfParisDay(day.add({days:1}).toString()))<=Date.parse(String(run.period_to)));
  if(!report){missing++;continue;}
  const value=report.daily.get(date)??0;minor+=BigInt(value);used.add(String(report.run.id));dailyRevenue.push({date,value:value/100});
 }
 if(!used.size&&!exact)return null;
 const safe=minor<=BigInt(Number.MAX_SAFE_INTEGER)&&minor>=BigInt(Number.MIN_SAFE_INTEGER);
 const dates=reports.filter(r=>used.has(String(r.run.id))).map(r=>String(r.run.finished_at)).sort();
 const exactFallback=missing>0&&exact;
 return {dailyRevenue,cash:{id:'cash',label:'CA encaissé',value:exactFallback?exactFallback.total/100:missing||!safe?null:Number(minor)/100,unit:'eur',source:'Wix · synthèse des paiements',
  definition:'Total TTC des paiements selon Wix, après remboursements, cartes cadeaux utilisées et rétrofacturations, avant frais de paiement. Inclut les paiements confirmés manuellement dans Wix.',
  coverage:exactFallback?'Total exact Wix importé ; détail quotidien partiel sur cette période.':missing?`${missing} jours sans rapport Wix importé sur cette période.`:'Historique quotidien Wix importé ; chaque journée est comptée une seule fois.',
  updatedAt:exactFallback?String(exactFallback.run.finished_at):dates[0],...(missing&&!exactFallback?{unavailableReason:'Historique Wix incomplet sur la période.'}:{})}};
}
