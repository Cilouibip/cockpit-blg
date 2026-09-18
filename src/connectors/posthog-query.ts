import { ConnectorError, object, readJson } from './http';

interface QueryOptions {
  endpoint: URL;
  projectId: string;
  headers: Record<string, string>;
  query: string;
  name: string;
  deadline: number;
  signal: AbortSignal;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
}

/** Run a read-only query in PostHog's background worker, then retrieve its complete result.
 * Only validated query IDs enter the fixed, authenticated project URL.
 */
export async function readPostHogQuery(options: QueryOptions): Promise<unknown> {
  const now = options.clock ?? Date.now;
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const fetcher: typeof fetch = (input, init) => (options.fetcher ?? fetch)(input, {
    ...init, signal: AbortSignal.any([options.signal, ...(init?.signal ? [init.signal] : [])]),
  });
  const request = async (path: string, init: RequestInit) => {
    const remaining = options.deadline - now();
    if (options.signal.aborted || remaining < 1_000) throw new ConnectorError('POSTHOG_TIME_BUDGET');
    return object(await readJson(new URL(path, options.endpoint.origin), { ...init, headers: options.headers }, {
      fetcher, attempts: 1, timeoutMs: Math.min(15_000, remaining),
    }));
  };
  const path = `/api/projects/${options.projectId}/query/`;
  let payload = await request(path, { method: 'POST', body: JSON.stringify({
    query: { kind: 'HogQLQuery', query: options.query }, refresh: 'force_async', name: options.name,
  }) });
  let queryId: string | undefined;
  for (let poll = 0; poll <= 20; poll++) {
    if (payload.error) throw new ConnectorError('POSTHOG_QUERY_FAILED');
    const status = payload.query_status ? object(payload.query_status) : null;
    if (status?.error) throw new ConnectorError('POSTHOG_QUERY_FAILED');
    if (status?.team_id !== undefined && String(status.team_id) !== options.projectId) throw new ConnectorError('PROJECT_IDENTITY_MISMATCH');
    if (Array.isArray(payload.results) && (!status || status.complete === true)) return payload;
    if (!status) throw new ConnectorError('INVALID_POSTHOG_RESPONSE');
    if (typeof status.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(status.id) || (queryId && queryId !== status.id)) throw new ConnectorError('INVALID_POSTHOG_QUERY_ID');
    queryId = status.id;
    if (status.complete === true) {
      const result = object(status.results);
      if (result.error || !Array.isArray(result.results)) throw new ConnectorError('INVALID_POSTHOG_RESPONSE');
      return result;
    }
    const delay = poll === 0 ? 800 : 2_000;
    if (poll === 20 || options.signal.aborted || options.deadline - now() < delay + 1_000) throw new ConnectorError('POSTHOG_TIME_BUDGET');
    await sleep(delay);
    payload = await request(`${path}${queryId}/`, { method: 'GET' });
  }
  throw new ConnectorError('POSTHOG_TIME_BUDGET');
}
