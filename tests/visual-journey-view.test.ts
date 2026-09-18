import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { VisualJourneyMetric, VisualJourneyRate, VisualJourneyReport } from '../src/lib/visual-journey-contract';
import { BookingDetail, FormDetail, VideoDetail, VisualJourneyView } from '../src/components/VisualJourneyView';

const metric = (count: number | null, reason: string | null = null): VisualJourneyMetric => ({ count, available: count != null, reason });
const rate = (numerator: number | null, denominator: number | null, reason: string | null = null): VisualJourneyRate => ({ numerator, denominator, rate: numerator != null && denominator ? numerator / denominator : null, available: numerator != null && denominator != null, reason });

function fixture(): VisualJourneyReport {
  const stages = [
    { id: 'page' as const, label: 'Visitent la page', count: 1000, availability: { available: true, reason: null }, fromPrevious: null },
    { id: 'form' as const, label: 'Ouvrent le formulaire', count: 160, availability: { available: true, reason: null }, fromPrevious: rate(160, 1000) },
    { id: 'signup' as const, label: 'S’inscrivent', count: 120, availability: { available: true, reason: null }, fromPrevious: rate(120, 160) },
    { id: 'watch' as const, label: 'Démarrent la vidéo', count: 100, availability: { available: true, reason: null }, fromPrevious: rate(100, 120) },
    { id: 'call' as const, label: 'Réservent un rendez-vous', count: 12, availability: { available: true, reason: null }, fromPrevious: rate(12, 100) },
  ];
  return {
    status: 'complete', generatedAt: '2026-09-18T10:00:00Z', period: { from: '2026-09-01', to: '2026-09-18', timezone: 'Europe/Paris' }, filters: { source: 'all', campaign: '', includeTests: false }, availableAds: [], stages,
    page: { visitors: metric(1000), sections: [{ id: 'questions', label: 'Questions', visitors: metric(720) }, { id: 'last-call', label: 'Last call', visitors: metric(340) }, { id: 'hero', label: 'Hero', visitors: metric(1000) }, { id: 'coach', label: 'Coach', visitors: metric(460) }, { id: 'proof-section', label: 'Proof section', visitors: metric(580) }], cta: metric(160), ctaPlacements: [{ id: 'proof-section', label: 'Proof section', visitors: metric(30) }, { id: 'video_thumbnail', label: 'Video thumbnail', visitors: metric(60) }, { id: 'last-call', label: 'Last call', visitors: metric(20) }, { id: 'hero', label: 'Hero', visitors: metric(50) }] },
    form: { opened: metric(160), started: metric(140), registered: metric(120), rates: { startedFromOpened: rate(140, 160), registeredFromStarted: rate(120, 140) } },
    video: { durationSeconds: 437, durationAvailability: { available: true, reason: null }, started: metric(100), thresholds: [{ seconds: 30, visitors: 82, fromStarted: rate(82, 100) }, { seconds: 60, visitors: 68, fromStarted: rate(68, 100) }, { seconds: 180, visitors: 45, fromStarted: rate(45, 100) }, { seconds: 300, visitors: 28, fromStarted: rate(28, 100) }], finished: metric(18) },
    booking: { clicked: metric(24), calendar: metric(18), booked: metric(12), rates: { calendarFromClicked: rate(18, 24), bookedFromCalendar: rate(12, 18) } },
    freshness: { posthog: { observedAt: '2026-09-18T09:59:00Z', coveredThrough: '2026-09-18T09:58:00Z', status: 'available', reason: null }, wix: { observedAt: '2026-09-18T09:55:00Z', coveredThrough: '2026-09-18T09:45:00Z', status: 'available', reason: null }, appointments: { observedAt: '2026-09-18T09:50:00Z', coveredThrough: '2026-09-18T09:40:00Z', status: 'available', reason: null } },
    coverage: { browserVisitors: 1000, browserSessions: 1100, registrations: 120, registrationsWithVisitor: 110, registrationsWithSession: 100, registrationsWithoutBrowserIdentity: 10, appointments: 12, appointmentsLinkedToPerson: 12, testsIncluded: false }, limits: [],
  };
}

test('visual journey follows the five-step mockup and exposes every paired arrow base', () => {
  const html = renderToStaticMarkup(createElement(VisualJourneyView, { report: fixture() }));
  for (const label of ['Visitent la page', 'Ouvrent le formulaire', 'S’inscrivent', 'Démarrent la vidéo', 'Réservent un rendez-vous']) assert.match(html, new RegExp(label));
  for (const base of ['160 sur 1[\u202f ]000 : 16', '120 sur 160 : 75', '100 sur 120 : 83,3', '12 sur 100 : 12']) assert.match(html, new RegExp(base));
  assert.equal((html.match(/class="journey-stop"/g) ?? []).length, 5);
  for (const step of ['page', 'form', 'signup', 'watch', 'call']) assert.match(html, new RegExp(`data-step="${step}"`));
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.match(html, /a-luminous-marker/);
  for (const label of ['Le haut de la page', 'Les trois questions', 'Les témoignages', 'La présentation de Jérôme', 'Le bas de la page', 'Sur la vidéo', 'En haut', 'Sous les témoignages', 'En bas']) assert.match(html, new RegExp(label));
  const bars = html.match(/class="journey-bars">([\s\S]*?)<\/div><h3/)?.[1] ?? '';
  const clicks = html.match(/class="journey-clicks">([\s\S]*?)<\/div>/)?.[1] ?? '';
  assert.ok(bars.indexOf('Le haut de la page') < bars.indexOf('Les trois questions'));
  assert.ok(bars.indexOf('Les trois questions') < bars.indexOf('Les témoignages'));
  assert.ok(bars.indexOf('Les témoignages') < bars.indexOf('La présentation de Jérôme'));
  assert.ok(bars.indexOf('La présentation de Jérôme') < bars.indexOf('Le bas de la page'));
  assert.ok(clicks.indexOf('En haut') < clicks.indexOf('Sur la vidéo'));
  assert.ok(clicks.indexOf('Sur la vidéo') < clicks.indexOf('Sous les témoignages'));
  assert.ok(clicks.indexOf('Sous les témoignages') < clicks.indexOf('En bas'));
  assert.doesNotMatch(html, />Hero<|>Proof section<|>Last call<|>Video thumbnail</);
  assert.doesNotMatch(html, /Version de la page|<table|a-d-visible-point/);
});

test('form and booking details keep three values and two paired conversion rates', () => {
  const report = fixture();
  const form = renderToStaticMarkup(createElement(FormDetail, { report }));
  assert.match(form, /160[\s\S]*87,5[\s\S]*140[\s\S]*85,7[\s\S]*120/);
  assert.match(form, /120 personnes inscrites au total\. 160 formulaires ouverts\./);
  assert.match(form, /title="140 sur 160 : 87,5 %"/);
  assert.match(form, /title="120 sur 140 : 85,7 %"/);
  assert.doesNotMatch(form, /inscrites sur/);
  assert.doesNotMatch(form, /vont jusqu’à l’inscription/);
  const booking = renderToStaticMarkup(createElement(BookingDetail, { report }));
  assert.match(booking, /24[\s\S]*75[\s\S]*18[\s\S]*66,7[\s\S]*12/);
});

test('video detail shows measured percentage and count on its starting population', () => {
  const html = renderToStaticMarkup(createElement(VideoDetail, { report: fixture() }));
  assert.match(html, /68 %/);
  assert.match(html, /68 personnes sur 100/);
  for (const mark of ['30 s', '1 min', '3 min', '5 min', 'Toute la vidéo']) assert.match(html, new RegExp(mark));
  assert.match(html, /type="range"/);
  assert.doesNotMatch(html, /<table|Dernière position/);
});

test('partial data keeps good values and groups the missing explanation', () => {
  const report = fixture();
  report.stages[1] = { ...report.stages[1], count: null, availability: { available: false, reason: 'Ouverture non mesurée sur cette période.' } };
  report.form.opened = metric(null, 'Ouverture non mesurée sur cette période.');
  const html = renderToStaticMarkup(createElement(VisualJourneyView, { report }));
  assert.match(html, /1[\u202f ]000/);
  assert.match(html, /À savoir sur ces chiffres/);
  assert.match(html, /Ouverture non mesurée sur cette période/);
});
