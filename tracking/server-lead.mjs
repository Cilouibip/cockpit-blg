import { createHmac } from 'node:crypto';

/** Invoke only AFTER a successful save in Wix/the authoritative backend. Never import in browser code. */
export async function sendSavedLead({ endpoint, secret, registration, fetcher = fetch }) {
  if (secret.length < 32 || new URL(endpoint).protocol !== 'https:') throw new Error('Invalid server ingestion configuration');
  // registration.event_id and external_id come from a durable outbox row created with the lead save.
  // Retrying an outbox row reuses both identifiers; do not generate them here.
  const body = JSON.stringify({ ...registration, event_name: 'lead_registered', schema_version: 1 });
  for (let attempt = 0; attempt < 3; attempt++) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    try {
      const response = await fetcher(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-blg-timestamp': timestamp, 'x-blg-signature': signature }, body, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (response.ok) return { delivered: true };
      if (response.status < 500 && response.status !== 429) return { delivered: false, retryable: false };
    } catch { /* No URL, body, email or upstream error is logged. */ }
    await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
  }
  return { delivered: false, retryable: true };
}
