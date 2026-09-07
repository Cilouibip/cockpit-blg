import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium, expect, type Page } from '@playwright/test';
import type { DashboardResponse, DetailRow, Prospect, ProspectsResponse } from '../src/lib/ui-contract';

// Synthetic HTTP fixtures verify UI pagination independently from the SQL tests.
// Only the local login uses the real app; all list and KPI data below are fictitious.
const origin = 'http://127.0.0.1:3100';
const output = path.resolve('.local/qa');
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const access = await fs.readFile('.local/access.txt', 'utf8');
const password = access.match(/^Mot de passe\s*:\s*(.+)$/m)?.[1]?.trim();
if (!password) throw new Error('Local test access is absent.');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
const page = await context.newPage();
const rows: DetailRow[] = Array.from({ length: 120 }, (_, index) => ({ id: `detail-${index + 1}`, label: `Entrée synthétique ${String(index + 1).padStart(3, '0')}`, source: 'organic', leads: 1, appointments: null, clients: null, spend: null, coverage: 'Fixture UI synthétique' }));
const prospects: Prospect[] = Array.from({ length: 125 }, (_, index) => ({ id: `prospect-${index + 1}`, name: `Prospect synthétique ${String(index + 1).padStart(3, '0')}`, owner: 'Responsable fictif', stage: index < 60 ? 'À contacter' : index < 110 ? 'À relancer' : 'Gagné', source: 'organic', tunnel: 'quiz', appointmentAt: null, appointmentStatus: 'unknown', followUpAt: null, outcome: null, updatedAt: '2026-09-07T12:00:00Z' }));
const statuses = ['À contacter', 'À relancer', 'Gagné'];
const detailsQueries: URLSearchParams[] = [];
const prospectQueries: URLSearchParams[] = [];
const checks: string[] = [];
let dashboardReads = 0;
let legacy = false;
let errors = 0;
let checkpoint = 'private local login';
page.on('pageerror', () => { errors += 1; });
function pass(name: string) { checks.push(name); console.log(`PASS ${name}`); }
async function ready(p: Page) { await p.waitForFunction(() => document.querySelector('.blg-content')?.getAttribute('aria-busy') === 'false' && !!document.querySelector('.blg-content .blg-panel')); }
async function navigate(name: string) { await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name, exact: true }).click(); await ready(page); }
await page.route('**/api/dashboard?*', async route => {
  dashboardReads += 1;
  const query = new URL(route.request().url()).searchParams;
  const payload: DashboardResponse = {
    mode: 'demo', generatedAt: '2026-09-07T12:00:00Z', period: { from: query.get('from') ?? '2026-09-01', to: query.get('to') ?? '2026-09-07', timezone: 'Europe/Paris' },
    metrics: [{ id: 'leads', label: 'Leads uniques', value: 1000000, unit: 'count', source: 'Agrégat fictif indépendant', definition: 'Fixture de pagination, pas une mesure réelle.', coverage: 'Agrégat complet fictif', updatedAt: null }],
    series: [], pillars: [], journeys: [], details: legacy ? rows : rows.slice(0, 50), ...(legacy ? {} : { detailsPagination: { page: 0, pageSize: 50, total: rows.length } }), campaigns: [{ id: 'campagne-test', label: 'Campagne synthétique' }], notices: ['Fixture UI synthétique de pagination.'],
  };
  await route.fulfill({ json: payload });
});
await page.route('**/api/details?*', async route => {
  const query = new URL(route.request().url()).searchParams; detailsQueries.push(query);
  const requested = Number(query.get('page') ?? 0);
  await route.fulfill({ json: { details: rows.slice(requested * 50, requested * 50 + 50), pagination: { page: requested, pageSize: 50, total: rows.length } } });
});
await page.route('**/api/prospects*', async route => {
  const query = new URL(route.request().url()).searchParams; prospectQueries.push(query);
  const requested = Number(query.get('page') ?? 0);
  const filtered = legacy ? prospects : prospects.filter(prospect => (!query.get('stage') || prospect.stage === query.get('stage')) && prospect.name.toLowerCase().includes((query.get('search') ?? '').toLowerCase()));
  const payload: ProspectsResponse = { mode: 'demo', updatedAt: null, coverage: 'Fixture UI synthétique', prospects: legacy ? filtered : filtered.slice(requested * 50, requested * 50 + 50), ...(legacy ? {} : { pagination: { page: requested, pageSize: 50, total: filtered.length }, stages: statuses }) };
  await route.fulfill({ json: payload });
});
try {
  await page.goto(origin); await page.waitForURL('**/login');
  await page.getByLabel('Mot de passe', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ouvrir le cockpit', exact: true }).click(); await page.waitForURL(origin + '/'); await ready(page);
  await expect(page.locator('.blg-demo-banner')).toBeVisible();
  checkpoint = 'detail first page';
  let pager = page.getByRole('navigation', { name: 'Pagination des points d’entrée' });
  await expect(pager).toContainText('Lignes 1–50 sur 120');
  await expect(pager.getByRole('button', { name: 'Précédent', exact: true })).toBeDisabled();
  assert.equal(await page.locator('.blg-panel tbody tr').count(), 50);
  const aggregate = await page.locator('.blg-metric > strong').innerText();
  assert.equal(Number(aggregate.replace(/\D/g, '')), 1000000);
  pass('50 details displayed without replacing the independent million-lead aggregate');

  checkpoint = 'applied filters in detail request';
  await page.getByLabel('Du', { exact: true }).fill('2026-09-03'); await page.getByLabel('Au', { exact: true }).fill('2026-09-05');
  await page.getByLabel('Source', { exact: true }).selectOption('paid'); await page.getByLabel('Tunnel', { exact: true }).selectOption('quiz'); await page.getByLabel('Campagne, publicité ou créative', { exact: true }).selectOption('campagne-test');
  const filteredDashboard = page.waitForResponse(response => response.url().includes('/api/dashboard?') && new URL(response.url()).searchParams.get('from') === '2026-09-03');
  await page.getByRole('button', { name: 'Appliquer', exact: true }).click(); await filteredDashboard; await ready(page);
  const beforePaging = dashboardReads;
  await pager.getByRole('button', { name: 'Suivant', exact: true }).click(); await expect(pager).toContainText('Lignes 51–100 sur 120');
  assert.equal(detailsQueries.at(-1)?.get('from'), '2026-09-03'); assert.equal(detailsQueries.at(-1)?.get('to'), '2026-09-05'); assert.equal(detailsQueries.at(-1)?.get('source'), 'paid'); assert.equal(detailsQueries.at(-1)?.get('tunnel'), 'quiz'); assert.equal(detailsQueries.at(-1)?.get('campaign'), 'campagne-test'); assert.equal(detailsQueries.at(-1)?.get('page'), '1');
  assert.equal(dashboardReads, beforePaging); assert.equal(await page.locator('.blg-metric > strong').innerText(), aggregate);
  pass('detail page requests retain every applied filter and never reload or recalculate KPI');

  checkpoint = 'detail last page and previous';
  await pager.getByRole('button', { name: 'Suivant', exact: true }).click(); await expect(pager).toContainText('Lignes 101–120 sur 120'); assert.equal(await page.locator('.blg-panel tbody tr').count(), 20);
  await expect(pager.getByRole('button', { name: 'Suivant', exact: true })).toBeDisabled();
  await pager.getByRole('button', { name: 'Précédent', exact: true }).click(); await expect(pager).toContainText('Lignes 51–100 sur 120');
  await pager.screenshot({ path: path.join(output, 'pagination-details.png') });
  pass('detail last partial page and page bounds are accurate');

  checkpoint = 'commercial pages and total';
  await navigate('Commercial'); const commercial = page.getByRole('navigation', { name: 'Pagination commerciale' });
  await expect(commercial).toContainText('Lignes 1–50 sur 125'); await expect(page.getByRole('heading', { name: '125 prospects', exact: true })).toBeVisible();
  assert.equal(await page.locator('.blg-sales-table tbody tr').count(), 50);
  assert.equal(await page.getByLabel('Statut commercial', { exact: true }).getByRole('option', { name: 'Gagné', exact: true }).count(), 1);
  await commercial.getByRole('button', { name: 'Suivant', exact: true }).click(); await expect(commercial).toContainText('Lignes 51–100 sur 125');
  await commercial.getByRole('button', { name: 'Suivant', exact: true }).click(); await expect(commercial).toContainText('Lignes 101–125 sur 125'); await expect(commercial.getByRole('button', { name: 'Suivant', exact: true })).toBeDisabled();
  assert.equal(await page.locator('.blg-sales-table tbody tr').count(), 25);
  pass('commercial total comes from server metadata; 125 prospects remain distinct from page size');

  checkpoint = 'commercial global search and stage';
  await page.getByRole('textbox', { name: 'Rechercher un prospect' }).fill('Prospect synthétique 12'); await page.getByLabel('Statut commercial', { exact: true }).selectOption('Gagné');
  await page.getByRole('button', { name: 'Rechercher', exact: true }).click(); await expect(commercial).toContainText('Lignes 1–6 sur 6');
  assert.equal(prospectQueries.at(-1)?.get('page'), '0'); assert.equal(prospectQueries.at(-1)?.get('stage'), 'Gagné'); assert.equal(prospectQueries.at(-1)?.get('search'), 'Prospect synthétique 12');
  assert.equal(await page.locator('.blg-sales-table tbody tr').count(), 6); await expect(page.getByRole('heading', { name: '6 prospects', exact: true })).toBeVisible();
  assert.equal(await page.getByLabel('Statut commercial', { exact: true }).locator('option').count(), 4);
  pass('global search and stage reset page to zero; every stage remains available');

  checkpoint = 'commercial empty result';
  await page.getByRole('textbox', { name: 'Rechercher un prospect' }).fill('absent-synthétique'); await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
  await expect(page.getByText('Aucun résultat pour cette recherche', { exact: true })).toBeVisible(); await expect(commercial).toContainText('0 au total'); await expect(commercial.getByRole('button', { name: 'Suivant', exact: true })).toBeDisabled();
  pass('empty server search is explicit and offers no nonexistent next page');

  checkpoint = 'mobile pagination';
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('textbox', { name: 'Rechercher un prospect' }).clear(); await page.getByLabel('Statut commercial', { exact: true }).selectOption(''); await page.getByRole('button', { name: 'Rechercher', exact: true }).click(); await expect(commercial).toContainText('Lignes 1–50 sur 125');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await commercial.getByRole('button', { name: 'Suivant', exact: true }).click(); await expect(commercial).toContainText('Lignes 51–100 sur 125');
  await commercial.screenshot({ path: path.join(output, 'pagination-mobile-commercial.png'), style: '.blg-sidebar,.blg-skip,nextjs-portal{visibility:hidden!important}' });
  pass('mobile pagination is usable and creates no page overflow');

  checkpoint = 'legacy fixtures';
  legacy = true; await page.reload(); await ready(page);
  assert.equal(await page.getByRole('navigation', { name: 'Pagination des points d’entrée' }).count(), 0); assert.equal(await page.locator('.blg-panel tbody tr').count(), 120);
  await navigate('Commercial'); assert.equal(await page.getByRole('navigation', { name: 'Pagination commerciale' }).count(), 0);
  await page.getByRole('textbox', { name: 'Rechercher un prospect' }).fill('Prospect synthétique 12'); await page.getByLabel('Statut commercial', { exact: true }).selectOption('Gagné'); await page.getByRole('button', { name: 'Rechercher', exact: true }).click(); await expect(page.getByRole('heading', { name: '6 prospects', exact: true })).toBeVisible();
  pass('legacy unpaginated fixtures retain their full list and local filter compatibility');
  assert.equal(errors, 0); pass('no browser JavaScript error');
  await fs.writeFile(path.join(output, 'pagination-result.json'), JSON.stringify({ completedAt: new Date().toISOString(), type: 'synthetic HTTP fixtures; not SQL verification', checks, browserErrors: errors }, null, 2));
  console.log(`Pagination UI: ${checks.length} focused checks passed.`);
} catch (error) {
  if (checkpoint !== 'private local login') console.error(error instanceof Error ? error.message.replaceAll(password, '[REDACTED]') : 'UI check failed');
  await fs.writeFile(path.join(output, 'pagination-result.json'), JSON.stringify({ completedAt: new Date().toISOString(), checkpoint, checks, browserErrors: errors, failed: true }, null, 2));
  console.error(`Pagination UI stopped at: ${checkpoint}`); process.exitCode = 1;
} finally { await context.close(); await browser.close(); }
