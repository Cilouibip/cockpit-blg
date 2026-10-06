import { readJson, type ReadJsonOptions } from './http';

/** Exact HTTP400 service fault observed on the ad insights reader. Meta auth and
 * request errors remain terminal; an is_transient flag alone is insufficient. */
async function temporaryInsightsFault(response: Response): Promise<boolean> {
  if (response.status !== 400 || Number(response.headers.get('content-length')) > 16_384) return false;
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16_384) { void reader.cancel().catch(() => undefined); return false; }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const error = JSON.parse(new TextDecoder().decode(bytes))?.error;
    return error !== null && typeof error === 'object' && error.code === 2 && error.error_subcode === 1504044 && error.is_transient !== false;
  } catch { return false; }
  finally { reader.releaseLock(); }
}

export function readMetaJson(url: URL, init: RequestInit, options: Omit<ReadJsonOptions, 'retryOnResponse'> = {}): Promise<unknown> {
  const insights = url.protocol === 'https:' && url.hostname === 'graph.facebook.com' && /^\/v\d+\.0\/act_\d+\/insights$/.test(url.pathname);
  return readJson(url, init, { ...options, ...(insights ? { retryOnResponse: temporaryInsightsFault } : {}) });
}
