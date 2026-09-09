export class SyncBudgetExpired extends Error {
  constructor(readonly phase:'source'|'write') { super(`sync_${phase}_budget_expired`);this.name='SyncBudgetExpired'; }
}

type Options={
  totalMs?:number;
  writeMarginMs?:number;
  signal?:AbortSignal;
  fetcher?:typeof fetch;
  now?:()=>number;
};

/** One invocation owns this budget. Source reads stop before the deadline so
 * confirmed pages and lease release can still be written. A cancelled HTTP
 * caller stops source work, but does not cancel that bounded cleanup window. */
export function createSyncExecutionBudget(options:Options={}) {
  const totalMs=options.totalMs??45_000,writeMarginMs=options.writeMarginMs??5_000;
  if(!Number.isSafeInteger(totalMs)||!Number.isSafeInteger(writeMarginMs)||totalMs<2||totalMs>2_147_483_647||writeMarginMs<1||writeMarginMs>=totalMs)throw new RangeError('invalid_sync_budget');
  const now=options.now??(()=>performance.now()),started=now(),workDeadline=started+totalMs-writeMarginMs,deadline=started+totalMs;
  const sourceController=new AbortController(),writeController=new AbortController();
  const sourceTimer=setTimeout(()=>sourceController.abort(new SyncBudgetExpired('source')),totalMs-writeMarginMs);
  const writeTimer=setTimeout(()=>writeController.abort(new SyncBudgetExpired('write')),totalMs);
  const sourceSignal=options.signal?AbortSignal.any([options.signal,sourceController.signal]):sourceController.signal;
  const fetcher=options.fetcher??fetch;
  const remaining=(end:number)=>Math.max(0,end-now());
  const transport=(phase:'source'|'write'):typeof fetch=>async(input,init={})=>{
    const phaseSignal=phase==='source'?sourceSignal:writeController.signal;
    if(phaseSignal.aborted||remaining(phase==='source'?workDeadline:deadline)<=0)throw new SyncBudgetExpired(phase);
    // Readers can supply their own per-request timeout. Retain both that limit
    // and the invocation deadline, including the signal on a Request object.
    const signals=[phaseSignal,...(input instanceof Request?[input.signal]:[]),...(init.signal?[init.signal]:[])];
    return fetcher(input,{...init,signal:AbortSignal.any(signals)});
  };
  return {
    sourceFetch:transport('source'),
    writeFetch:transport('write'),
    remainingWorkMs:()=>remaining(workDeadline),
    remainingTotalMs:()=>remaining(deadline),
    canStart(maxSourceMs:number){
      if(!Number.isFinite(maxSourceMs)||maxSourceMs<=0)throw new RangeError('invalid_sync_unit_budget');
      return !sourceSignal.aborted&&remaining(workDeadline)>=maxSourceMs;
    },
    dispose(){clearTimeout(sourceTimer);clearTimeout(writeTimer);sourceController.abort(new SyncBudgetExpired('source'));writeController.abort(new SyncBudgetExpired('write'));},
  };
}
