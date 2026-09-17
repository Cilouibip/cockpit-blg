import test from 'node:test';
import assert from 'node:assert/strict';
import { issueSession, passwordHash, COOKIE_NAME } from '../src/lib/auth';
import { getConfig } from '../src/lib/config';

test('journey is private, validates scope and keeps missing measurements unavailable without source writes', async () => {
  const previous = { ...process.env }, oldFetch = globalThis.fetch;
  Object.assign(process.env, { COCKPIT_MODE: 'live', APP_ORIGIN: 'http://127.0.0.1:3189', COCKPIT_SESSION_SECRET: 'synthetic-journey-route-secret-at-least-32', COCKPIT_PASSWORD_HASH: passwordHash('synthetic-journey-password') });
  delete process.env.VERCEL;
  delete process.env.POSTHOG_HOST;
  delete process.env.POSTHOG_PROJECT_ID;
  delete process.env.POSTHOG_PERSONAL_API_KEY;
  let networkCalls = 0;
  globalThis.fetch = (async () => { networkCalls++; throw new Error('Unexpected network request'); }) as typeof fetch;
  try {
    const { GET, POST } = await import('../src/app/api/[...path]/route');
    const config = getConfig();
    const origin = config.origin + '/api/journey?from=2026-09-17&to=2026-09-17&tunnel=masterclass';
    const headers = { Cookie: `${COOKIE_NAME}=${issueSession(config)}`, Origin: config.origin };
    assert.equal((await GET(new Request(origin))).status, 401);
    for (const extra of ['&includeTests=yes', '&version=invalid%27version', '&from=invalid']) {
      const url = new URL(origin);
      for (const [key, value] of new URLSearchParams(extra.slice(1))) url.searchParams.set(key, value);
      assert.equal((await GET(new Request(url, { headers }))).status, 400);
    }
    assert.equal((await POST(new Request(origin, { method: 'POST', headers }))).status, 404);
    const response = await GET(new Request(origin, { headers }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    const report = await response.json();
    assert.equal(report.scope.includeTests, false);
    assert.equal(report.status, 'not_configured');
    assert.equal(report.video.startedSessions.value, null);
    assert.equal(report.coverage.includedSessions, null);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
