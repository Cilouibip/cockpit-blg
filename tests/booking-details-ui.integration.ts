import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { issueSession, COOKIE_NAME, passwordHash } from '../src/lib/auth';
import { getConfig } from '../src/lib/config';
import { emptyDashboard } from '../src/lib/dashboard';
import type { AdFunnelReport } from '../src/lib/ad-funnel';
import type { BookingResultsReport } from '../src/lib/booking-results';
import { visualJourneyUiFixture } from './fixtures/visual-journey-ui';

const base = process.env.BOOKING_PREVIEW_URL || 'http://127.0.0.1:3144';
assert.equal(new URL(base).hostname, '127.0.0.1');
Object.assign(process.env, {
  COCKPIT_MODE: 'live', APP_ORIGIN: base,
  COCKPIT_SESSION_SECRET: 'synthetic-booking-preview-secret-0123456789',
  COCKPIT_PASSWORD_HASH: passwordHash('synthetic-booking-password', '00000000000000000000000000000000'),
});
const output = process.env.BOOKING_SCREENSHOT_DIR;
if (output) fs.mkdirSync(output, { recursive: true });

function dashboardFixture() {
  const report = emptyDashboard({ from: '2026-09-01', to: '2026-09-18', source: 'all', tunnel: 'all', campaign: '', compare: false }, 'live');
  const appointments = report.metrics.find(metric => metric.id === 'appointments');
  assert.ok(appointments);
  Object.assign(appointments, { value: 1, coverage: 'Rendez-vous synthétiques.', updatedAt: '2026-09-18T10:00:00Z' });
  report.pillars.find(pillar => pillar.id === 'conversion')!.metrics.unshift({
    id: 'booked', label: 'RDV pris', value: 2, unit: 'count', source: 'Notion synthétique',
    definition: 'Réservations synthétiques prises sur la période.', coverage: 'Données synthétiques.', updatedAt: '2026-09-18T10:00:00Z',
  });
  return report;
}

function bookingReport(scope: 'initial' | 'filtered'): BookingResultsReport {
  const initial = scope === 'initial';
  return {
    period: initial ? { from: '2026-09-01', to: '2026-09-18', timezone: 'Europe/Paris' } : { from: '2026-09-17', to: '2026-09-18', timezone: 'Europe/Paris' },
    generatedAt: '2026-09-18T10:00:00Z', filters: { source: 'all', tunnel: 'all', campaign: '', includeTests: false },
    summary: initial ? { booked: 2, scheduled: 1, attended: 1, noShow: 0, cancelled: 0, rescheduled: 0, unknown: 0 } : { booked: 1, scheduled: 1, attended: 0, noShow: 0, cancelled: 0, rescheduled: 0, unknown: 0 },
    rows: initial ? [
      { id: 'synthetic-future', prospectId: 'synthetic-future', displayName: 'Alex synthétique', bookingAt: '2026-09-10T09:00:00Z', bookingDay: '2026-09-10', scheduledAt: '2026-09-30T09:00:00Z', scheduledDay: '2026-09-30', outcome: 'scheduled', effective: true, reservedInPeriod: true, scheduledInPeriod: false, source: 'paid', attributionKey: 'ad-a', attributionLabel: 'Publicité synthétique A', adId: 'ad-a', campaignId: 'campaign-a', campaignLabel: 'Campagne synthétique' },
      { id: 'synthetic-attended', prospectId: 'synthetic-attended', displayName: 'Camille synthétique', bookingAt: '2026-09-05T09:00:00Z', bookingDay: '2026-09-05', scheduledAt: '2026-09-08T09:00:00Z', scheduledDay: '2026-09-08', outcome: 'attended', effective: true, reservedInPeriod: true, scheduledInPeriod: true, source: 'paid', attributionKey: 'ad-a', attributionLabel: 'Publicité synthétique A', adId: 'ad-a', campaignId: 'campaign-a', campaignLabel: 'Campagne synthétique' },
    ] : [{ id: 'synthetic-filtered', prospectId: 'synthetic-filtered', displayName: 'Robin synthétique', bookingAt: '2026-09-17T09:00:00Z', bookingDay: '2026-09-17', scheduledAt: '2026-09-29T09:00:00Z', scheduledDay: '2026-09-29', outcome: 'scheduled', effective: true, reservedInPeriod: true, scheduledInPeriod: false, source: 'paid', attributionKey: 'ad-b', attributionLabel: 'Publicité synthétique B', adId: 'ad-b', campaignId: 'campaign-b', campaignLabel: 'Campagne synthétique' }],
    cost: initial ? { spendMinor: 16000, eligibleAttributedBookings: 2, averagePerBookingMinor: 8000, reason: null, byAds: [{ attributionKey: 'ad-a', label: 'Publicité synthétique A', adId: 'ad-a', campaignId: 'campaign-a', spendMinor: 16000, eligibleAttributedBookings: 2, averagePerBookingMinor: 8000, reason: null }] } : { spendMinor: 7000, eligibleAttributedBookings: 1, averagePerBookingMinor: 7000, reason: null, byAds: [{ attributionKey: 'ad-b', label: 'Publicité synthétique B', adId: 'ad-b', campaignId: 'campaign-b', spendMinor: 7000, eligibleAttributedBookings: 1, averagePerBookingMinor: 7000, reason: null }] },
    coverage: { available: true, reason: null, observedAt: '2026-09-18T10:00:00Z', appointmentRowsRead: initial ? 2 : 1, prospectRowsRead: initial ? 2 : 1, rowsExcludedAsTests: 0, definitions: { booked: 'Réservations synthétiques.', scheduled: 'Créneaux synthétiques.', attended: 'Présences synthétiques.', cost: 'Moyenne synthétique agrégée.' } },
  };
}

function adFunnelFixture(): AdFunnelReport {
  const rate = { value: null, numerator: null, denominator: null, reason: 'Non calculé dans cette recette synthétique.' };
  const row = { key: 'ad-a', kind: 'ad', label: 'Publicité synthétique A', source: 'paid', adId: 'ad-a', campaignId: 'campaign-a', campaignLabel: 'Campagne synthétique', creativeId: null, links: [], tunnels: ['masterclass'], spendMinor: 16000, outboundClicks: 12, impressions: 120, visitors: { quiz: null, masterclass: 8 }, pageviews: { quiz: null, masterclass: 8 }, visitorsWithFirstOrigin: 8, optin: { quiz: null, masterclass: null, all: null, unlinkableVisitors: { quiz: 0, masterclass: 0 }, registrationsWithoutVisitor: 0, registrationsOutsideCohort: 0 }, registrations: 2, registrationsByTunnel: { quiz: 0, masterclass: 2 }, uniqueRegistrants: 2, uniqueLeads: 2, uniqueLeadsByTunnel: { quiz: 0, masterclass: 2 }, knownBefore: 0, unresolvedIdentity: 0, leadsBooked: 1, appointmentsReserved: 1, appointmentsBooked: 0, appointmentsAttended: 0, appointmentsUpcoming: 1, appointmentsNoShow: 0, appointmentsCancelled: 0, appointmentsRescheduled: 0, appointmentsUnknown: 0, firstSalesConfirmed: null, firstSalesReconciled: null, firstSalesPending: null, cashMinor: null, refundsMinor: 0, rates: { optin: rate, booking: rate, attendance: rate }, attributionBasis: { firstTouch: 2, arrival: 0 } };
  return { available: true, period: { from: '2026-09-01', to: '2026-09-18', timezone: 'Europe/Paris' }, filters: { source: 'all', tunnel: 'all', campaign: '', includeTests: false }, rows: [row], totals: row, notices: [], campaigns: [], linkDetails: [], definitions: {} as AdFunnelReport['definitions'], coverage: { leads: { complete: true, observedAt: '2026-09-18T10:00:00Z' }, appointments: { available: true, reason: null, observedAt: '2026-09-18T10:00:00Z' }, optin: { available: false, observedAt: null, reason: 'Non lue.', visitorsUnlinkable: null, registrationsWithoutVisitor: 0, registrationsOutsideCohort: 0 }, commerce: { observedAt: null }, meta: { lastDay: '2026-09-18' }, visits: { available: false, observedAt: null } } } as unknown as AdFunnelReport;
}

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
await context.addCookies([{ name: COOKIE_NAME, value: issueSession(getConfig()), url: base, httpOnly: true, sameSite: 'Strict' }]);
const page = await context.newPage();
const errors: string[] = []; const writes: string[] = []; const checks: string[] = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, base);
  if (route.request().method() !== 'GET') writes.push(`${route.request().method()} ${url.pathname}`);
  assert.equal(route.request().method(), 'GET', 'La recette ne doit jamais déclencher une écriture source.');
  if (url.pathname === '/api/dashboard') return route.fulfill({ json: dashboardFixture() });
  if (url.pathname === '/api/booking-results') return route.fulfill({ json: bookingReport(url.searchParams.get('from') === '2026-09-17' ? 'filtered' : 'initial') });
  if (url.pathname === '/api/ad-funnel') return route.fulfill({ json: adFunnelFixture() });
  if (url.pathname === '/api/journey-visual') {
    const report = visualJourneyUiFixture();
    report.booking.booked = { count: 2, available: true, reason: null };
    report.stages[4].count = 2;
    report.booking.people = [
      { name: 'Alex synthétique', originLabel: 'Publicité synthétique A', appointments: [{ id: 'journey-future', bookedAt: '2026-09-10T09:00:00Z', scheduledAt: '2026-09-30T09:00:00Z', status: 'scheduled' }] },
      { name: 'Camille synthétique', originLabel: 'Publicité synthétique A', appointments: [{ id: 'journey-attended', bookedAt: '2026-09-05T09:00:00Z', scheduledAt: '2026-09-08T09:00:00Z', status: 'attended' }] },
    ];
    return route.fulfill({ json: report });
  }
  return route.fulfill({ json: { connections: [] } });
});

try {
  await page.goto(base);
  await page.locator('[data-metric="appointments"]').waitFor();
  const card = page.locator('[data-metric="appointments"]');
  await expect(card.locator('.results-appointment-counts')).toContainText('2');
  await expect(card.locator('.results-appointment-counts')).toContainText('Réservés');
  await expect(card.locator('.results-appointment-counts')).toContainText('1');
  await expect(card.locator('.results-appointment-counts')).toContainText('Réalisés');
  checks.push('carte Rendez-vous : deux compteurs réservés et réalisés');

  const opener = card.getByRole('button', { name: 'Voir les rendez-vous réservés et réalisés' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Les rendez-vous' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Réservés 2/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog).toContainText('Alex synthétique');
  await expect(dialog).toContainText('30 sept. 2026');
  await expect(dialog).toContainText('Coût publicitaire moyen par réservation');
  await expect(dialog).toContainText('80 €');
  assert.doesNotMatch(await dialog.locator('.booking-results-list').innerText(), /80\s*€/);
  await page.screenshot({ path: output ? `${output}/desktop-results-reserved.png` : '/tmp/booking-details-desktop.png', fullPage: true });
  await dialog.getByRole('button', { name: /Réalisés 1/ }).click();
  await expect(dialog).toContainText('Camille synthétique');
  await expect(dialog).not.toContainText('Alex synthétique');
  checks.push('panneau Réservés puis Réalisés : personnes et dates synthétiques, coût seulement agrégé');
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  checks.push('fermeture clavier et retour du focus');

  await page.getByRole('button', { name: 'Filtres', exact: true }).click();
  await page.getByLabel('Période rapide', { exact: true }).selectOption('custom');
  await page.getByLabel('Du', { exact: true }).fill('2026-09-17');
  await page.getByLabel('Au', { exact: true }).fill('2026-09-18');
  await page.getByRole('button', { name: 'Appliquer', exact: true }).click();
  await page.locator('[data-metric="appointments"]').waitFor();
  await opener.click();
  await expect(dialog).toContainText('Robin synthétique');
  await expect(dialog).not.toContainText('Alex synthétique');
  await page.keyboard.press('Escape');
  checks.push('nouveau filtre : aucune ancienne liste conservée');

  await page.getByRole('button', { name: /Par publicité, du clic à l’encaissement/ }).click();
  const adTable = page.getByRole('region', { name: 'Résultats par publicité' });
  await page.waitForTimeout(800);
  await adTable.waitFor();
  await expect(adTable.locator('tbody tr').first().locator('td').nth(6)).toHaveText('1');
  checks.push('tableau publicité : 1 RDV réservé même si son créneau futur est hors période');

  await page.getByRole('button', { name: 'Parcours', exact: true }).click();
  const journey = page.locator('.journey-page');
  await journey.locator('.journey-stop').nth(4).waitFor();
  await journey.locator('.journey-stop').nth(4).click();
  await expect(journey).toContainText('Qui a réservé ?');
  await expect(journey).toContainText('Alex synthétique');
  await expect(journey).toContainText('Camille synthétique');
  await expect(journey).toContainText('30 sept. 2026');
  checks.push('clic Rendez-vous du Parcours : personnes et dates du compteur');

  const geometry: { width: number; overflow: boolean }[] = [];
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => scrollTo(0, 0));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, `débordement horizontal à ${width}px`);
    geometry.push({ width, overflow });
    if (output) await page.screenshot({ path: `${output}/journey-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'Résultats', exact: true }).click();
  await page.locator('[data-metric="appointments"]').waitFor();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await opener.click(); await expect(dialog).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `panneau RDV à ${width}px`);
    if (output) await page.screenshot({ path: `${output}/results-dialog-${width}.png`, fullPage: true });
    await page.keyboard.press('Escape');
  }
  checks.push('rendu 1440, 390 et 320 sans débordement horizontal');
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, []);
  if (output) fs.writeFileSync(`${output}/browser-verification.json`, JSON.stringify({ synthetic: true, checks, geometry, errors, writes }, null, 2));
  console.log('Booking details browser checks passed. Synthetic data only; no source writes.');
} finally {
  await context.close();
  await browser.close();
}
