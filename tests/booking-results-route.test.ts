import test from 'node:test';
import assert from 'node:assert/strict';
import { issueSession, passwordHash, COOKIE_NAME } from '../src/lib/auth';
import { getConfig } from '../src/lib/config';

test('les noms des réservants restent privés et une période invalide ne lit aucune source', async () => {
  const original = { ...process.env }, originalFetch = globalThis.fetch;
  Object.assign(process.env,{ COCKPIT_MODE:'live', APP_ORIGIN:'http://127.0.0.1:3191', COCKPIT_SESSION_SECRET:'synthetic-booking-route-session-secret-32', COCKPIT_PASSWORD_HASH:passwordHash('synthetic-booking-password') });
  for (const key of ['VERCEL','SUPABASE_URL','SUPABASE_SECRET_KEY','DATABASE_URL']) delete process.env[key];
  let reads = 0; globalThis.fetch = (async () => { reads++; throw new Error('Unexpected source request'); }) as typeof fetch;
  try {
    const { GET, POST } = await import('../src/app/api/[...path]/route');
    const config = getConfig(), url = config.origin + '/api/booking-results?from=2026-09-01&to=2026-09-18&tunnel=all';
    const headers = { Cookie: `${COOKIE_NAME}=${issueSession(config)}`, Origin:config.origin };
    const anonymous = await GET(new Request(url));
    assert.equal(anonymous.status,401);
    assert.match(anonymous.headers.get('cache-control') ?? '',/private, no-store/);
    for (const change of ['includeTests=yes','from=invalid','to=2026-08-01','source=invalid','tunnel=other']) {
      const invalid = new URL(url); for(const [key,value] of new URLSearchParams(change)) invalid.searchParams.set(key,value);
      assert.equal((await GET(new Request(invalid,{headers}))).status,400,change);
    }
    assert.equal((await POST(new Request(url,{method:'POST',headers}))).status,404);
    assert.equal(reads,0);
  } finally { globalThis.fetch = originalFetch; for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env,original); }
});
