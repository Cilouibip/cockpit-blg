import {Temporal} from '@js-temporal/polyfill';
import type {Row} from '../../src/lib/db';
/** Transport fixtures for existing reader unit tests. SQL selection is tested
 * separately against PostgreSQL, including malformed publications and volume. */
export function windowFixture(input:Row[],aggregates:Row[],args:Row){
 const start=(day:string)=>Temporal.PlainDate.from(day).toZonedDateTime('Europe/Paris').toInstant().epochMilliseconds;
 let runs=input.filter(r=>r.query_profile_key===args.p_profile&&r.pagination_complete===true&&(!r.status||['complete','empty'].includes(String(r.status))))
  .map(r=>({...r,started_at:r.started_at??r.finished_at,source_as_of:r.source_as_of??r.started_at??r.finished_at} as Row)).sort((a,b)=>String(b.source_as_of).localeCompare(String(a.source_as_of))||String(b.id).localeCompare(String(a.id)));
 if(args.p_kind==='exact_report')runs=runs.filter(r=>Date.parse(String(r.period_from))===start(String(args.p_from))&&Date.parse(String(r.period_to))===start(String(args.p_to))).slice(0,1);
 const rows=aggregates.filter(a=>runs.some(r=>r.id===a.sync_run_id));
 const validations:Record<string,{valid:boolean;totalMinor:number;hasBreakdown:boolean;wholeReportRowCount:number}>={},selections:{day:string;runId:string}[]=[];
 if(args.p_kind==='wix_report_daily'){
  for(const run of runs){const r=rows.filter(a=>a.sync_run_id===run.id),total=r.find(a=>a.metric_key==='wix_total_revenue'&&a.currency==='EUR'&&a.unit==='minor'&&a.tax_basis==='tax_inclusive');if(total)validations[String(run.id)]={valid:true,totalMinor:Number(total.value),hasBreakdown:r.filter(a=>a.metric_key==='wix_daily_revenue').reduce((n,a)=>n+Number(a.value),0)===Number(total.value),wholeReportRowCount:r.length};}
  for(let d=Temporal.PlainDate.from(String(args.p_from));d.toString()<String(args.p_to);d=d.add({days:1})){const r=runs.find(r=>validations[String(r.id)]?.hasBreakdown&&Date.parse(String(r.period_from))<=start(d.toString())&&Date.parse(String(r.period_to))>=start(d.add({days:1}).toString()));if(r)selections.push({day:d.toString(),runId:String(r.id)});}
 }
 return {runs,aggregates:rows,selections,validations,exactRunId:runs.find(r=>Date.parse(String(r.period_from))===start(String(args.p_from))&&Date.parse(String(r.period_to))===start(String(args.p_to)))?.id??null,latestAttempt:null};
}
