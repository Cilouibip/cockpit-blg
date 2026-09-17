import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { issueSession, COOKIE_NAME } from '../src/lib/auth';
import { getConfig } from '../src/lib/config';
import { emptyDashboard } from '../src/lib/dashboard';
import { journeyFixture } from './fixtures/journey';

const base = process.env.JOURNEY_PREVIEW_URL || 'http://127.0.0.1:3126';
assert.equal(new URL(base).hostname, '127.0.0.1', 'Synthetic browser test is localhost only');
if (fs.existsSync('.env.local')) process.loadEnvFile('.env.local');
Object.assign(process.env, { COCKPIT_MODE: 'live', APP_ORIGIN: base, COCKPIT_SESSION_SECRET: 'synthetic-journey-preview-secret-0123456789' });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addCookies([{ name: COOKIE_NAME, value: issueSession(getConfig()), url: base, httpOnly: true, sameSite: 'Strict' }]);
const page = await context.newPage();
const requests: URL[] = []; const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, base);
  if (url.pathname === '/api/journey') {
    requests.push(url);
    const report = journeyFixture();
    report.scope = { ...report.scope, from: url.searchParams.get('from')!, to: url.searchParams.get('to')!, tunnel: url.searchParams.get('tunnel') as 'quiz' | 'masterclass', includeTests: url.searchParams.get('includeTests') === 'true', version: url.searchParams.get('version'), source: url.searchParams.get('source') as 'all', campaign: url.searchParams.get('campaign') ?? '' };
    report.coverage.testsIncluded = report.scope.includeTests;
    if (report.scope.includeTests) report.steps[0].count = 14;
    return route.fulfill({ json: report });
  }
  if (url.pathname === '/api/dashboard') {
    const filters = { from: url.searchParams.get('from')!, to: url.searchParams.get('to')!, source: 'all' as const, tunnel: 'all' as const, campaign: '', compare: false };
    const data = emptyDashboard(filters, 'live');
    data.campaigns = [{ id: '120000000000000001', label: 'Campagne fictive' }];
    return route.fulfill({ json: data });
  }
  if (url.pathname === '/api/reports/posthog') return route.fulfill({ status: 422, json: { state: 'unsupported', reason: 'Fixture sans import' } });
  return route.fulfill({ json: { status: 'empty', notices: [] } });
});
try {
  await page.goto(base);
  await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name: 'Parcours', exact: true }).click();
  await page.getByRole('heading', { name: 'Le parcours de la masterclass', exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Inclure les essais', exact: true }).isChecked(), false);
  await page.getByRole('checkbox', { name: 'Inclure les essais', exact: true }).check();
  await page.waitForFunction(() => document.querySelector('.journey-steps li > strong')?.textContent === '14');
  assert.equal(requests.at(-1)?.searchParams.get('includeTests'), 'true');
  await page.getByLabel('Version de la page').selectOption('mc-fixture-2026-09-17.1');
  await page.waitForResponse(response => response.url().includes('/api/journey?') && response.url().includes('version=mc-fixture'));
  await page.getByRole('button', { name: 'Quiz', exact: true }).click();
  await page.getByRole('heading', { name: 'Où le quiz s’interrompt' }).waitFor();
  assert.equal(requests.at(-1)?.searchParams.get('version'), null, 'Version does not leak into other tunnel');
  assert.ok(await page.getByRole('cell', { name: 'Non disponible', exact: true }).count());
  await page.getByRole('button', { name: 'Masterclass', exact: true }).click();
  await page.getByRole('heading', { name: 'Jusqu’où les visiteurs regardent' }).waitFor();
  await page.locator('.journey-chart-point').nth(1).focus();
  await page.getByText('1:00 à 2:00 : 2 visites', { exact: true }).last().waitFor();
  for (const [name, width] of [['desktop', 1440], ['mobile', 390]] as const) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name} has no page overflow`);
    if (process.env.JOURNEY_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.JOURNEY_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.JOURNEY_SCREENSHOT_DIR}/${name}-journey.png`, fullPage: true });
    }
  }
  assert.deepEqual(errors, []);
  console.log('Journey browser checks passed: defaults, test scope, version, quiz, keyboard chart, mobile/desktop. Synthetic data only.');
} finally { await context.close(); await browser.close(); }
