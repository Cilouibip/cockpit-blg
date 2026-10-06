export class ConnectorError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); this.name = 'ConnectorError'; }
}

export function safeConnectorError(error: unknown): string {
  // No upstream response body, URL, stack, supplied string or Error.message enters UI/logs.
  return error instanceof ConnectorError && /^[A-Z_]{1,60}$/.test(error.code) ? `${error.code}${error.status ? ` (HTTP ${error.status})` : ''}` : 'CONNECTOR_FAILED';
}

export interface ReadJsonOptions {
  fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void>; attempts?: number; timeoutMs?: number;
  /** Source-specific reviewed transient response. Inspect a bounded clone only;
   * no response body, supplied message or URL becomes an error/log. */
  retryOnResponse?: (response: Response) => Promise<boolean>;
}
// Discarding an upstream body is best effort: a stream's cancel hook may never
// settle. It cannot delay a deadline, retry or the original safe failure.
function discardBody(body: { cancel(reason?: unknown): Promise<unknown> } | null | undefined): void {
  try { void body?.cancel().catch(() => undefined); } catch { /* Original connector result wins. */ }
}
export async function readJson(url: URL, init: RequestInit, options: ReadJsonOptions = {}): Promise<unknown> {
  const fetcher = options.fetcher ?? fetch;
  const attempts = Math.min(Math.max(options.attempts ?? 3, 1), 4);
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const callerSignal = init.signal;
  const checkCancellation = () => { if (callerSignal?.aborted) throw new ConnectorError('CONNECTOR_ABORTED'); };
  async function backoff(delay: number): Promise<void> {
    checkCancellation();
    if (!callerSignal) { await sleep(delay); return; }
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { if (timer) clearTimeout(timer); callerSignal!.removeEventListener('abort', onAbort); };
      const onAbort = () => { cleanup(); reject(new ConnectorError('CONNECTOR_ABORTED')); };
      callerSignal.addEventListener('abort', onAbort, { once: true });
      if (callerSignal.aborted) { onAbort(); return; }
      if (!options.sleep) timer = setTimeout(() => { cleanup(); resolve(); }, delay);
      else Promise.resolve().then(() => { checkCancellation(); return sleep(delay); }).then(
        () => { cleanup(); resolve(); },
        error => { cleanup(); reject(error); },
      );
    });
    checkCancellation();
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    checkCancellation();
    let response: Response;
    const timeout = AbortSignal.timeout(Math.min(Math.max(options.timeoutMs ?? 15_000, 1_000), 60_000));
    try { response = await fetcher(url, { ...init, redirect: 'error', signal: callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout }); }
    catch {
      checkCancellation();
      if (attempt + 1 < attempts) { await backoff(250 * 2 ** attempt); continue; }
      throw new ConnectorError('NETWORK_ERROR');
    }
    checkCancellation();
    const retryable = response.status === 429 || response.status >= 500 || (!response.ok && attempt + 1 < attempts && await options.retryOnResponse?.(response) === true);
    checkCancellation();
    if (retryable && attempt + 1 < attempts) {
      const retry = response.headers.get('retry-after');
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : NaN;
      const delay = Number.isFinite(seconds) ? Math.min(seconds * 1000, 5_000) : 250 * 2 ** attempt;
      discardBody(response.body); await backoff(delay); continue;
    }
    if (!response.ok) { discardBody(response.body); throw new ConnectorError(response.status === 401 || response.status === 403 ? 'ACCESS_DENIED' : 'UPSTREAM_HTTP_ERROR', response.status); }
    const declared = Number(response.headers.get('content-length'));
    if (declared > 2_000_000) { discardBody(response.body); throw new ConnectorError('RESPONSE_TOO_LARGE'); }
    try {
      // Bound the decoded response even when the remote endpoint omits Content-Length.
      const reader = response.body?.getReader();
      if (!reader) throw new ConnectorError('INVALID_RESPONSE');
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 2_000_000) { discardBody(reader); throw new ConnectorError('RESPONSE_TOO_LARGE'); } chunks.push(value); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      checkCancellation();
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) { checkCancellation(); if (error instanceof ConnectorError) throw error; throw new ConnectorError('INVALID_RESPONSE'); }
  }
  throw new ConnectorError('RETRY_EXHAUSTED');
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConnectorError('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
export function text(value: unknown): string | null { return typeof value === 'string' ? value : null; }
export function integer(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : null;
}
