import test from 'node:test';
import assert from 'node:assert/strict';
import { issueSession, passwordHash, COOKIE_NAME } from '../src/lib/auth';
import { getConfig } from '../src/lib/config';

test('visual journey is private and rejects invalid scopes without invoking source writes', async () => {
  const originalEnv = { ...process.env }, originalFetch = globalThis.fetch;
  Object.assign(process.env, { COCKPIT_MODE:'live', APP_ORIGIN:'http://127.0.0.1:3191', COCKPIT_SESSION_SECRET:'synthetic-visual-route-session-secret-32', COCKPIT_PASSWORD_HASH:passwordHash('synthetic-visual-password') });
  for (const key of ['VERCEL','SUPABASE_URL','SUPABASE_SECRET_KEY','DATABASE_URL','POSTHOG_HOST','POSTHOG_PROJECT_ID','POSTHOG_PERSONAL_API_KEY']) delete process.env[key];
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('Unexpected source request'); }) as typeof fetch;
  try {
    const { GET, POST } = await import('../src/app/api/[...path]/route');
    const config = getConfig();
    const url = config.origin + '/api/journey-visual?from=2026-09-01&to=2026-09-18&tunnel=masterclass';
    const headers = { Cookie:`${COOKIE_NAME}=${issueSession(config)}`, Origin:config.origin };
    assert.equal((await GET(new Request(url))).status,401);
    for (const change of ['includeTests=yes','tunnel=quiz','from=invalid','to=2026-08-01','resume=untrusted-token']) {
      const invalid = new URL(url);
      for (const [key,value] of new URLSearchParams(change)) invalid.searchParams.set(key,value);
      assert.equal((await GET(new Request(invalid,{headers}))).status,400,change);
    }
    assert.equal((await POST(new Request(url,{method:'POST',headers}))).status,404);
    const unavailable = await GET(new Request(url,{headers}));
    assert.equal(unavailable.status,503,'Missing connection cannot produce made-up funnel counts');
    assert.match(unavailable.headers.get('cache-control') ?? '',/no-store/);
    assert.equal(calls,0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env,originalEnv);
  }
});
