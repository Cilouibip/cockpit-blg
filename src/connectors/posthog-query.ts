import { createHash, randomUUID } from 'node:crypto';
import { ConnectorError, object, readJson } from './http';

/** Server-side checkpoint. Any browser transport must authenticate/sign this
 * object before passing it back; it is not a bearer token or a result. */
export interface PostHogQueryContinuation {
  version: 1;
  id: string;
  origin: string;
  projectId: string;
  queryHash: string;
  startedAt: number;
  /** Recovery GET slots are reserved durably before HTTP until the ID is acknowledged. */
  lookupAttempts?: number;
  registered?: boolean;
}

export class PostHogQueryPending extends ConnectorError {
  readonly retryAfterMs = 1_500;
  constructor(readonly continuation: PostHogQueryContinuation) {
    super('POSTHOG_QUERY_PENDING');
  }
}

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
  /** Opt in to a resumable pending result when this HTTP invocation runs out
   * of time. Default callers keep the existing bounded-failure contract. */
  resumable?: boolean;
  resume?: PostHogQueryContinuation;
  onContinuation?: (continuation: PostHogQueryContinuation) => void | Promise<void>;
  /** PostHog execution mode. `force_async` (default) always starts a new
   * background calculation. `async` returns fresh cached results for the same
   * query when PostHog has them, otherwise starts the same background
   * calculation (https://posthog.com/docs/api/queries). */
  refresh?: 'force_async' | 'async';
}

/** Run a read-only query in PostHog's background worker, then retrieve its complete result.
 * Only validated query IDs enter the fixed, authenticated project URL.
 */
export async function readPostHogQuery(options: QueryOptions): Promise<unknown> {
  const now = options.clock ?? Date.now;
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const queryHash = createHash('sha256').update(options.query).digest('hex');
  const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value);
  let continuation: PostHogQueryContinuation | undefined;
  if (options.resume !== undefined) {
    const resume = options.resume;
    if (!resume || resume.version !== 1 || !validId(resume.id) || resume.origin !== options.endpoint.origin ||
        resume.projectId !== options.projectId || resume.queryHash !== queryHash ||
        (resume.lookupAttempts !== undefined && (!Number.isInteger(resume.lookupAttempts) || resume.lookupAttempts < 0 || resume.lookupAttempts > 3)) ||
        (resume.registered !== undefined && typeof resume.registered !== 'boolean') ||
        !Number.isSafeInteger(resume.startedAt) || resume.startedAt > now() || now() - resume.startedAt > 10 * 60_000) {
      throw new ConnectorError('INVALID_POSTHOG_CONTINUATION');
    }
    continuation = { ...resume };
  }
  const timeBudget = (): never => {
    if (options.resumable && continuation) throw new PostHogQueryPending({ ...continuation });
    throw new ConnectorError('POSTHOG_TIME_BUDGET');
  };
  let retryAfterMs=250;
  let transportCode:string|undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const signal=AbortSignal.any([options.signal,...(init?.signal?[init.signal]:[])]);
    const classifyTransport=(error:unknown,headersReceived=false)=>{
      // Never retain upstream strings, response bodies or request credentials.
      const code=(error as {cause?:{code?:string}})?.cause?.code;
      transportCode=options.signal.aborted?'POSTHOG_CANCELLED':signal.aborted?'POSTHOG_REQUEST_TIMEOUT':
        !headersReceived&&(code==='ENOTFOUND'||code==='EAI_AGAIN')?'POSTHOG_DNS_ERROR':code==='ECONNRESET'?'POSTHOG_CONNECTION_RESET':'POSTHOG_TRANSPORT_ERROR';
    };
    try {
      const response=await (options.fetcher??fetch)(input,{...init,signal});
      const retry=response.headers.get('retry-after');
      retryAfterMs=retry&&/^\d+$/.test(retry)?Number(retry)*1000:250;
      if(!response.ok||!response.body)return response;
      // fetch resolves at headers. Preserve transport errors from the body too,
      // before readJson normalizes them. JSON parsing stays outside this stream
      // and a fully received malformed document remains INVALID_RESPONSE.
      const reader=response.body.getReader();
      const body=new ReadableStream<Uint8Array>({
        async pull(controller){try{const {done,value}=await reader.read();if(done)controller.close();else controller.enqueue(value);}
          catch(error){classifyTransport(error,true);controller.error(error);}},
        cancel(reason){return reader.cancel(reason);},
      });
      return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    } catch(error) {
      classifyTransport(error);throw error;
    }
  };
  const request = async (path: string, init: RequestInit) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = options.deadline - now();
      if (options.signal.aborted && now() < options.deadline) throw new ConnectorError('POSTHOG_CANCELLED');
      if (options.signal.aborted || remaining < 1_000) throw new ConnectorError('POSTHOG_TIME_BUDGET');
      transportCode=undefined;retryAfterMs=250;
      try {
        return object(await readJson(new URL(path, options.endpoint.origin), { ...init, headers: options.headers }, {
          fetcher, attempts: 1, timeoutMs: Math.min(20_000, remaining),
        }));
      } catch (error) {
        const transient = error instanceof ConnectorError && (error.code === 'NETWORK_ERROR' || (error.code === 'INVALID_RESPONSE' && !!transportCode) || (error.code === 'UPSTREAM_HTTP_ERROR' && (error.status===429||(error.status ?? 0) >= 500)));
        // A lost POST acknowledgement may already have started an expensive query.
        // Only DNS failures and explicit rate limiting are safe to resubmit.
        const uncertainSubmission = init.method === 'POST' && transient &&
          transportCode !== 'POSTHOG_DNS_ERROR' && !(error instanceof ConnectorError && error.status === 429);
        // Respect Retry-After; do not issue an early retry if it cannot fit.
        if (attempt || uncertainSubmission || !transient || options.signal.aborted || options.deadline - now() < retryAfterMs+1_000) {
          if(transportCode && error instanceof ConnectorError && ['NETWORK_ERROR','INVALID_RESPONSE'].includes(error.code))throw new ConnectorError(transportCode);
          throw error;
        }
        await sleep(retryAfterMs);
      }
    }
    throw new ConnectorError('POSTHOG_TIME_BUDGET');
  };
  const path = `/api/projects/${options.projectId}/query/`;
  const clientQueryId = continuation?.id ?? randomUUID();
  const startedAt = continuation?.startedAt ?? now();
  let payload: Record<string, unknown>;
  let queryId: string | undefined = continuation?.id;
  let submissionError: ConnectorError | undefined;
  let recoveryDelay = 0;
  let placeholder = !!continuation;

  if (continuation) {
    // Enter the same polling loop without submitting another query. The local
    // placeholder can never be returned as a successful result.
    payload = { query_status: { id: continuation.id, complete: false } };
  } else try {
    continuation = { version: 1, id: clientQueryId, origin: options.endpoint.origin, projectId: options.projectId, queryHash, startedAt, lookupAttempts:0, registered:false };
    await options.onContinuation?.({ ...continuation });
    payload = await request(path, { method: 'POST', body: JSON.stringify({
      query: { kind: 'HogQLQuery', query: options.query }, refresh: options.refresh ?? 'force_async', name: options.name,
      client_query_id: clientQueryId,
    }) });
  } catch (error) {
    const recoverable = error instanceof ConnectorError && (
      ['POSTHOG_REQUEST_TIMEOUT', 'POSTHOG_CONNECTION_RESET', 'POSTHOG_TRANSPORT_ERROR'].includes(error.code) ||
      (error.code === 'POSTHOG_CANCELLED' && now() >= options.deadline) ||
      (error.code === 'UPSTREAM_HTTP_ERROR' && (error.status ?? 0) >= 500)
    );
    if (!recoverable || (options.signal.aborted && now() < options.deadline)) throw error;
    if (options.resumable && options.deadline - now() < 1_000) timeBudget();
    submissionError = error as ConnectorError;
    recoveryDelay = retryAfterMs;
    queryId = clientQueryId;
    // PostHog accepts client_query_id before running the query. Recover that
    // same job; never infer success from this local pending placeholder.
    placeholder = true;
    payload = { query_status: { id: clientQueryId, complete: false } };
  }
  for (let poll = 0; poll <= 20; poll++) {
    if (payload.error) throw new ConnectorError('POSTHOG_QUERY_FAILED');
    const status = payload.query_status ? object(payload.query_status) : null;
    const immediateResult = Array.isArray(payload.results) && (!status || status.complete === true);
    if (status?.error) throw new ConnectorError('POSTHOG_QUERY_FAILED');
    if (status?.team_id !== undefined && String(status.team_id) !== options.projectId) throw new ConnectorError('PROJECT_IDENTITY_MISMATCH');
    if (status && (status.id !== undefined || queryId || !immediateResult) &&
        (!validId(status.id) || (queryId && queryId !== status.id))) throw new ConnectorError('INVALID_POSTHOG_QUERY_ID');
    if (queryId && !status) throw new ConnectorError('INVALID_POSTHOG_RESPONSE');
    if (!placeholder && (status && validId(status.id) || immediateResult) && (continuation?.id !== (status?.id ?? clientQueryId) || !continuation?.registered)) {
      continuation = { ...continuation!, id: (status?.id ?? clientQueryId) as string, registered:true };
      await options.onContinuation?.({ ...continuation });
    }
    if (immediateResult) return payload;
    if (!status) throw new ConnectorError('INVALID_POSTHOG_RESPONSE');
    queryId = status.id as string;
    if (status.complete === true) {
      const result = object(status.results);
      if (result.error || !Array.isArray(result.results)) throw new ConnectorError('INVALID_POSTHOG_RESPONSE');
      return result;
    }
    const delay = poll === 0 ? Math.max(800, recoveryDelay) : 2_000;
    if (options.signal.aborted && now() < options.deadline) throw new ConnectorError('POSTHOG_CANCELLED');
    if (poll === 20 || options.deadline - now() < delay + 1_000) timeBudget();
    await sleep(delay);
    try {
      if(!continuation!.registered){
        if((continuation!.lookupAttempts??0)>=3)throw new ConnectorError('POSTHOG_QUERY_MISSING');
        continuation={...continuation!,lookupAttempts:(continuation!.lookupAttempts??0)+1};
        await options.onContinuation?.({...continuation});
      }
      payload = await request(`${path}${queryId}/`, { method: 'GET' });
      placeholder = false;
      submissionError = undefined;
    } catch (error) {
      // Registration can lag an interrupted submission. Allow three bounded
      // reads of the same ID; an absent job remains a failure, never an empty result.
      if (!continuation!.registered && error instanceof ConnectorError && error.status === 404) {
        if ((continuation!.lookupAttempts??0) < 3) continue;
        throw submissionError ?? error;
      }
      if (error instanceof ConnectorError && (error.code === 'POSTHOG_TIME_BUDGET' ||
          (['POSTHOG_REQUEST_TIMEOUT', 'POSTHOG_CANCELLED'].includes(error.code) && options.deadline - now() < 1_000))) timeBudget();
      throw error;
    }
  }
  throw new ConnectorError('POSTHOG_TIME_BUDGET');
}
