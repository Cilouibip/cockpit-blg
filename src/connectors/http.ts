export class ConnectorError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); this.name = 'ConnectorError'; }
}

export function safeConnectorError(error: unknown): string {
  // No upstream response body, URL, stack, supplied string or Error.message enters UI/logs.
  return error instanceof ConnectorError && /^[A-Z_]{1,60}$/.test(error.code) ? `${error.code}${error.status ? ` (HTTP ${error.status})` : ''}` : 'CONNECTOR_FAILED';
}

export async function readJson(url: URL, init: RequestInit, options: { fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void>; attempts?: number; timeoutMs?: number } = {}): Promise<unknown> {
  const fetcher = options.fetcher ?? fetch;
  const attempts = Math.min(Math.max(options.attempts ?? 3, 1), 4);
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Response;
    try { response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(Math.min(Math.max(options.timeoutMs ?? 15_000, 1_000), 60_000)) }); }
    catch {
      if (attempt + 1 < attempts) { await sleep(250 * 2 ** attempt); continue; }
      throw new ConnectorError('NETWORK_ERROR');
    }
    if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
      const retry = response.headers.get('retry-after');
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : NaN;
      const delay = Number.isFinite(seconds) ? Math.min(seconds * 1000, 5_000) : 250 * 2 ** attempt;
      await response.body?.cancel(); await sleep(delay); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new ConnectorError(response.status === 401 || response.status === 403 ? 'ACCESS_DENIED' : 'UPSTREAM_HTTP_ERROR', response.status); }
    const declared = Number(response.headers.get('content-length'));
    if (declared > 2_000_000) { await response.body?.cancel(); throw new ConnectorError('RESPONSE_TOO_LARGE'); }
    try {
      // Bound the decoded response even when the remote endpoint omits Content-Length.
      const reader = response.body?.getReader();
      if (!reader) throw new ConnectorError('INVALID_RESPONSE');
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 2_000_000) { await reader.cancel(); throw new ConnectorError('RESPONSE_TOO_LARGE'); } chunks.push(value); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) { if (error instanceof ConnectorError) throw error; throw new ConnectorError('INVALID_RESPONSE'); }
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
