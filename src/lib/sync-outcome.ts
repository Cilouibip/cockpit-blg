type SourceResult = { status: string } | null;
/** HTTP success means all requested sources completed, not merely that the
 * handler ran. Empty reports carry no measured zero. No upstream errors leak. */
export function analyticsSyncOutcome(results: PromiseSettledResult<SourceResult>[]) {
  const sources = ['wix', 'posthog'].map((source, i) => {
    const result = results[i];
    const status = result?.status === 'fulfilled' ? result.value?.status : 'failed';
    return { source, status: ['complete','partial','empty'].includes(status ?? '') ? status! : 'failed' };
  });
  const complete = sources.every(s=>s.status==='complete');
  const failed = sources.every(s=>s.status==='failed');
  return { httpStatus: complete ? 200 : failed ? 502 : 207,
    body: { status: complete ? 'complete' : failed ? 'failed' : 'partial', sources } };
}
