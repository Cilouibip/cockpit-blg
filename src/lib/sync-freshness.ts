export type SyncRun=Record<string,unknown>;
const successful=(run:SyncRun)=>['complete','empty'].includes(String(run.status))&&run.pagination_complete!==false;
const timestamp=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
export function latestConnectionRun(runs:SyncRun[],source:string,streams:string[]):SyncRun|undefined {
  return runs.filter(run=>run.source===source&&streams.includes(String(run.stream_key))).sort((a,b)=>String(b.started_at).localeCompare(String(a.started_at)))[0];
}
/** Publication time and the oldest covered data are separate. Every stream in
 * a grouped card must have succeeded; Forms cannot conceal a failed Quiz import. */
export function connectionFreshness(runs:SyncRun[],source:string,streams:string[],now=Date.now()) {
  const last=latestConnectionRun(runs,source,streams);
  const publications=streams.map(stream=>runs.filter(run=>run.source===source&&run.stream_key===stream&&successful(run)).sort((a,b)=>(timestamp(b.finished_at)??0)-(timestamp(a.finished_at)??0))[0]);
  const allPublished=streams.length>0&&publications.every(Boolean);
  const publicationTimes=publications.map(run=>run?timestamp(run.finished_at):null);
  const asOfTimes=publications.map(run=>{
    if(!run)return null;
    const started=timestamp(run.started_at),finished=timestamp(run.finished_at),end=timestamp(run.period_to);
    if(started===null||finished===null)return null;
    return Math.min(started,finished,...(end!==null?[end]:[]));
  });
  const minTime=(values:(number|null)[])=>allPublished&&values.every(value=>value!==null)?new Date(Math.min(...values as number[])).toISOString():null;
  const lastSyncAt=minTime(publicationTimes),dataAsOf=minTime(asOfTimes);
  const latestByStream=streams.map(stream=>latestConnectionRun(runs,source,[stream]));
  const failed=latestByStream.some(run=>run?.status==='failed'||!!run?.error_code);
  const running=latestByStream.some(run=>run?.status==='running'||run?.status==='partial');
  const fresh=dataAsOf!==null&&now-Date.parse(dataAsOf)<3_600_000&&Date.parse(dataAsOf)<=now;
  return {last,lastSyncAt,dataAsOf,lastAttemptAt:last?.started_at?String(last.started_at):null,failed,running,fresh,allPublished};
}
