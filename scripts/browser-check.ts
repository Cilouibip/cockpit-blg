import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium, type Page } from '@playwright/test';

// Local synthetic-data QA only. No password, cookie, token or storage state is logged.
const baseURL = 'http://127.0.0.1:3100';
const output = path.resolve('.local/qa');
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const access = await fs.readFile('.local/access.txt', 'utf8');
const password = access.match(/^Mot de passe\s*:\s*(.+)$/m)?.[1]?.trim();
if (!password) throw new Error('Local test access is absent.');
const checks: { name: string; ok: boolean }[] = [];
const failedRequests: { path: string; status: number }[] = [];
let checkpoint = 'browser launch';
let pageErrors = 0;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'fr-FR', timezoneId: 'Europe/Paris', reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
page.on('pageerror', () => { pageErrors += 1; });
page.on('response', response => { const url = new URL(response.url()); if (url.origin === baseURL && url.pathname.startsWith('/api/') && response.status() >= 500) failedRequests.push({ path: url.pathname, status: response.status() }); });
function pass(name: string) { checks.push({ name, ok: true }); console.log(`PASS ${name}`); }
async function screenshot(name: string) { const modal = await page.locator('dialog[open]').count(); if (!modal) await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: !modal }); if (!modal) await page.screenshot({ path: path.join(output, `${name}-viewport.png`), fullPage: false }); if (name.endsWith('-results')) { await page.locator('.blg-chart').screenshot({ path: path.join(output, `${name}-chart.png`), style: '.blg-sidebar,.blg-skip,nextjs-portal{visibility:hidden!important}' }); await page.locator('.blg-metrics').screenshot({ path: path.join(output, `${name}-metrics.png`), style: '.blg-sidebar,.blg-skip,nextjs-portal{visibility:hidden!important}' }); } }
async function ready(p: Page) { await p.waitForFunction(() => document.querySelector('.blg-content')?.getAttribute('aria-busy') === 'false' && !!document.querySelector('.blg-content .blg-panel')); }
async function view(name: string) { await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name, exact: true }).click(); await ready(page); }
async function noPageOverflow(name: string) {
  const overflowing = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflowing, false, `Page overflow: ${name}`); pass(`${name}: no page overflow`);
}
try {
  checkpoint = 'private entry and login';
  await page.goto(baseURL); await page.waitForURL('**/login');
  assert.equal(await page.locator('input[name="username"]').count(), 0);
  await screenshot('desktop-login');
  await page.getByLabel('Mot de passe', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ouvrir le cockpit', exact: true }).click();
  await page.waitForURL(baseURL + '/'); await ready(page);
  assert.equal(await page.locator('.blg-demo-banner').count(), 1);
  pass('private login uses a dedicated password and opens demo space');
  if (process.argv.includes('--capture-only')) {
    for (const size of [{ width: 1440, height: 1000, name: 'desktop' }, { width: 390, height: 844, name: 'mobile' }]) {
      await page.setViewportSize({ width: size.width, height: size.height });
      for (const [name, filename] of [['Résultats','results'],['Parcours','journey'],['Commercial','sales'],['Liens','links'],['Connexions','connections']]) { await view(name); await screenshot(`${size.name}-${filename}`); }
    }
    await context.close(); await browser.close(); console.log('Read-only screenshots refreshed.'); process.exit(0);
  }

  assert.equal(await page.locator('#atelier-a').count(), 1); pass('one visual-kit root');
  await noPageOverflow('desktop results'); await screenshot('desktop-results');

  checkpoint = 'KPI detail and keyboard';
  const metric = page.locator('.blg-metric').first();
  await metric.click(); await page.getByRole('dialog').waitFor();
  assert.ok(await page.getByRole('dialog').getByText('Couverture', { exact: true }).count());
  assert.ok(await page.getByRole('dialog').getByText('Données synthétiques de démonstration', { exact: true }).count());
  await screenshot('desktop-kpi-detail'); await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('dialog').evaluate(element => document.activeElement === document.body || element.contains(document.activeElement)), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.getByRole('dialog').evaluate(element => document.activeElement === document.body || element.contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  await page.locator('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.equal(await metric.evaluate(element => element === document.activeElement), true); pass('KPI source, coverage, demo label, Escape and focus return');

  checkpoint = 'filter validation';
  await page.getByLabel('Du', { exact: true }).fill('2026-09-07');
  await page.getByLabel('Au', { exact: true }).fill('2026-09-01');
  await page.getByRole('button', { name: 'Appliquer', exact: true }).click();
  assert.ok(await page.getByText('La date de fin doit suivre la date de début.', { exact: true }).count());
  await page.getByLabel('Du', { exact: true }).fill('2026-09-01');
  await page.getByLabel('Au', { exact: true }).fill('2026-09-07');
  await page.getByLabel('Source', { exact: true }).selectOption('paid');
  await page.getByLabel('Tunnel', { exact: true }).selectOption('quiz');
  const filterResponse = page.waitForResponse(response => response.url().includes('/api/dashboard?') && response.url().includes('source=paid') && response.url().includes('tunnel=quiz'));
  await page.getByRole('button', { name: 'Appliquer', exact: true }).click();
  assert.equal((await filterResponse).status(), 200); await ready(page);
  assert.equal(await page.locator('.blg-filter-error').count(), 0); pass('invalid range rejected; paid and quiz filters applied');
  await page.getByLabel('Source', { exact: true }).selectOption('all'); await page.getByLabel('Tunnel', { exact: true }).selectOption('all');
  await page.getByRole('button', { name: 'Appliquer', exact: true }).click(); await ready(page);

  checkpoint = 'journey view';
  await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name: 'Résultats', exact: true }).focus();
  await page.keyboard.press('Tab'); await page.keyboard.press('Enter'); await ready(page);
  assert.equal(await page.getByRole('heading', { name: 'Du contenu au client.', exact: true }).count(), 1); pass('keyboard navigation by Tab and Enter');
  assert.equal(await page.locator('.blg-pillar').count(), 3);
  assert.ok(await page.locator('.blg-journey-step').count());
  const masterclass = page.locator('.blg-switch').getByRole('button', { name: /Masterclass/i });
  if (await masterclass.count()) { await masterclass.click(); assert.equal(await masterclass.getAttribute('aria-pressed'), 'true'); }
  await noPageOverflow('desktop journey'); await screenshot('desktop-journey'); pass('three pillars and masterclass journey selection');

  checkpoint = 'sales view';
  await view('Commercial');
  assert.ok(await page.getByText(/Lecture seule depuis Notion/).count());
  const prospect = page.locator('.blg-table-link').first();
  assert.ok(await prospect.count()); await prospect.click(); await page.getByRole('dialog').waitFor();
  assert.ok(await page.getByRole('dialog').getByText('Responsable', { exact: true }).count());
  await screenshot('desktop-prospect-detail'); await page.keyboard.press('Escape');
  const search = page.getByRole('textbox', { name: 'Rechercher un prospect' });
  await search.fill('synthetic-nobody-should-match-this'); assert.ok(await page.getByText('Aucun résultat pour cette recherche', { exact: true }).count()); await search.clear();
  await noPageOverflow('desktop sales'); await screenshot('desktop-sales'); pass('read-only commercial detail and empty search state');

  checkpoint = 'link creation';
  await view('Liens');
  const label = `QA synthétique ${Date.now()}`;
  await page.getByRole('button', { name: 'Créer le lien', exact: true }).click();
  assert.equal(await page.getByLabel('Campagne', { exact: true }).evaluate(element => (element as HTMLInputElement).validity.valueMissing), true);
  pass('empty link campaign is rejected before submission');
  await page.getByLabel('Campagne', { exact: true }).fill('qa-navigateur');
  await page.getByLabel('Nom pour le retrouver', { exact: true }).fill(label);
  const creation = page.waitForResponse(response => response.url().endsWith('/api/links') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Créer le lien', exact: true }).click();
  assert.ok([200, 201].includes((await creation).status()));
  let row = page.locator('.blg-link-record').filter({ has: page.getByRole('heading', { name: label, exact: true }) });
  await row.waitFor(); const firstUrl = await row.locator('.blg-url-row code').innerText();
  assert.ok(firstUrl.startsWith('https://quizz.blg-studio.fr/'));
  await row.getByRole('button', { name: `Copier le lien ${label}`, exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), firstUrl);
  pass('persistent link creation and clipboard copy');

  checkpoint = 'immutable link revision';
  await row.getByRole('button', { name: 'Nouvelle version', exact: true }).click();
  await page.getByLabel('Vers quelle page ?', { exact: true }).selectOption('masterclass');
  const revision = page.waitForResponse(response => response.url().endsWith('/api/links') && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Enregistrer cette version', exact: true }).click();
  assert.equal((await revision).status(), 200); await row.locator('.blg-version').filter({ hasText: 'v2' }).waitFor();
  const secondUrl = await row.locator('.blg-url-row code').innerText(); assert.notEqual(secondUrl, firstUrl);
  await row.locator('summary').click(); assert.ok((await row.locator('.blg-old-version code').allInnerTexts()).includes(firstUrl));
  await page.reload(); await ready(page); await view('Liens');
  row = page.locator('.blg-link-record').filter({ has: page.getByRole('heading', { name: label, exact: true }) });
  await row.waitFor(); assert.equal(await row.locator('.blg-url-row code').innerText(), secondUrl); pass('immutable previous URL and current version persist across reload');

  checkpoint = 'version conflict and retained draft';
  await row.getByRole('button', { name: 'Nouvelle version', exact: true }).click();
  await page.getByLabel('Campagne', { exact: true }).fill('qa-conflit-relecture');
  const registered = await (await context.request.get(`${baseURL}/api/links`)).json();
  const currentLink = registered.links.find((link: { current: { label: string } }) => link.current.label === label);
  const concurrent = await context.request.patch(`${baseURL}/api/links`, { headers: { Origin: baseURL }, data: { action: 'revise', id: currentLink.id, expectedVersion: currentLink.current.version, input: { placement: 'instagram_bio', destination: 'masterclass', campaign: 'qa-modification-parallele', label } } });
  assert.equal(concurrent.status(), 200);
  const conflict = page.waitForResponse(response => response.url().endsWith('/api/links') && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Enregistrer cette version', exact: true }).click();
  assert.equal((await conflict).status(), 409);
  await page.getByText(/Ce lien a changé entre-temps/).waitFor();
  assert.equal(await page.getByLabel('Campagne', { exact: true }).inputValue(), 'qa-conflit-relecture');
  await page.getByRole('button', { name: 'Actualiser le registre', exact: true }).click(); await ready(page);
  await page.getByRole('heading', { name: 'Nouvelle version · v4', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Campagne', { exact: true }).inputValue(), 'qa-conflit-relecture');
  const reconciled = page.waitForResponse(response => response.url().endsWith('/api/links') && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Enregistrer cette version', exact: true }).click(); assert.equal((await reconciled).status(), 200);
  await row.locator('.blg-version').filter({ hasText: 'v4' }).waitFor();
  const finalUrl = await row.locator('.blg-url-row code').innerText();
  pass('concurrent revision rejected; draft survives refresh and succeeds after review');
  checkpoint = 'clipboard fallback';
  await page.evaluate("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText() { return Promise.reject(new Error('Synthetic clipboard denial')); } } })");
  await row.getByRole('button', { name: `Copier le lien ${label}`, exact: true }).click(); await page.getByRole('dialog').waitFor();
  assert.equal(await page.getByRole('dialog').getByLabel('Lien à copier', { exact: true }).inputValue(), finalUrl);
  await page.keyboard.press('Escape'); await page.locator('dialog').waitFor({ state: 'detached' });
  pass('clipboard denial offers a selectable complete URL');
  checkpoint = 'archive and restore';
  await row.getByRole('button', { name: 'Archiver', exact: true }).click(); await row.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Archivés', exact: true }).click(); await row.waitFor();
  await row.getByRole('button', { name: 'Restaurer', exact: true }).click(); await row.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Actifs', exact: true }).click(); await row.waitFor();
  assert.equal(await row.locator('.blg-url-row code').innerText(), finalUrl); pass('archive and restore preserve the URL');
  await noPageOverflow('desktop links'); await screenshot('desktop-links');

  checkpoint = 'connections'; await view('Connexions');
  assert.ok(await page.locator('.blg-connection').count());
  assert.ok(await page.getByText(/Un accès disponible ne signifie pas/).count());
  await noPageOverflow('desktop connections'); await screenshot('desktop-connections'); pass('connection coverage and limitations visible');

  checkpoint = 'mobile views';
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [name, filename] of [['Résultats','results'],['Parcours','journey'],['Commercial','sales'],['Liens','links'],['Connexions','connections']]) {
    await view(name); await noPageOverflow(`mobile ${filename}`);
    assert.equal(await page.locator('.blg-demo-banner').isVisible(), true);
    await screenshot(`mobile-${filename}`);
  }
  pass('all mobile views preserve explicit demo indication');
  checkpoint = 'mobile logout';
  await page.getByRole('button', { name: 'Se déconnecter du cockpit', exact: true }).click();
  await page.waitForURL('**/login');
  assert.equal((await context.request.get(`${baseURL}/api/prospects`)).status(), 401);
  pass('mobile logout closes the session and protects commercial data');
  assert.equal(pageErrors, 0); assert.equal(failedRequests.length, 0); pass('no JavaScript error or server API error');
  await fs.writeFile(path.join(output, 'browser-result.json'), JSON.stringify({ completedAt: new Date().toISOString(), checks, pageErrors, failedRequests }, null, 2));
  console.log(`Browser QA: ${checks.length} checks passed. Screenshots remain in ignored .local/qa.`);
} catch (error) {
  if (checkpoint !== 'private entry and login') { await screenshot('failure'); console.error(error instanceof Error ? error.message.replaceAll(password, '[REDACTED]') : 'Check failed'); }
  checks.push({ name: checkpoint, ok: false });
  await fs.writeFile(path.join(output, 'browser-result.json'), JSON.stringify({ completedAt: new Date().toISOString(), checkpoint, checks, pageErrors, failedRequests }, null, 2));
  // Error details are deliberately not serialized: a browser action could include the login value.
  console.error(`Browser QA stopped at: ${checkpoint}. Inspect the local synthetic UI and result file.`);
  process.exitCode = 1;
} finally { await context.close(); await browser.close(); }
