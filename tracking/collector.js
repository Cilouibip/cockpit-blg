/** Copy to the page project. No deployment or mutation of existing analytics is performed here. */
export function createBLGCollector({ endpoint, tunnel, pageVersion, storage = globalThis.sessionStorage }) {
  const target = new URL(endpoint, location.origin);
  if (target.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(target.hostname)) throw new Error('HTTPS required');
  if (!['quiz', 'masterclass'].includes(tunnel) || !/^[a-zA-Z0-9._-]{1,64}$/.test(pageVersion)) throw new Error('Invalid collector configuration');
  const uuid = () => crypto.randomUUID();
  const validUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const load = key => { try { return storage.getItem(key); } catch { return null; } };
  const save = (key, value) => { try { storage.setItem(key, value); } catch { /* The in-memory journey remains usable. */ } };
  const persistentKey = 'blg:anonymous:v1';
  let anonymousId;
  try { anonymousId = localStorage.getItem(persistentKey); if (!validUuid(anonymousId)) { anonymousId = uuid(); localStorage.setItem(persistentKey, anonymousId); } } catch { anonymousId = uuid(); }
  const lastActive = Number(load('blg:last-active:v1') || 0);
  const cachedSession = load('blg:session:v1');
  let sessionId = Date.now() - lastActive < 30 * 60_000 && validUuid(cachedSession) ? cachedSession : uuid();
  let lastActivity = Date.now();
  save('blg:session:v1', sessionId); save('blg:last-active:v1', String(Date.now()));
  let journeyId = uuid();
  const parameters = new URLSearchParams(location.search);
  const revision = parameters.get('blg_link_id');
  const advertising = {};
  for (const key of ['ad_id', 'adset_id', 'campaign_id']) {
    const value = parameters.get(`meta_${key}`);
    if (value && /^\d{1,30}$/.test(value)) advertising[key] = value;
  }
  const context = () => ({ anonymous_id: anonymousId, session_id: sessionId, journey_id: journeyId, link_revision_id: validUuid(revision) ? revision : null });
  const pending = new Map();
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function deliver(body) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, credentials: 'omit', keepalive: true });
        if (response.ok) return true;
        if (response.status < 500 && response.status !== 429) return false;
      } catch { /* Retry the same event ID; never interrupt the business flow. */ }
      await delay(300 * 2 ** attempt);
    }
    return false;
  }
  function emit(eventName, properties = {}) {
    if (pending.size >= 30) return Promise.resolve(false);
    if (Date.now() - lastActivity >= 30 * 60_000) { sessionId = uuid(); journeyId = uuid(); save('blg:session:v1', sessionId); }
    lastActivity = Date.now();
    save('blg:last-active:v1', String(Date.now()));
    const eventId = uuid();
    const body = JSON.stringify({ event_id: eventId, schema_version: 1, occurred_at: new Date().toISOString(), ...context(), tunnel, page_version: pageVersion, ...advertising, event_name: eventName, properties });
    const promise = deliver(body).finally(() => pending.delete(eventId)); pending.set(eventId, promise); return promise;
  }
  return { emit, context, newJourney() { journeyId = uuid(); return journeyId; }, async flush() { await Promise.allSettled([...pending.values()]); } };
}
