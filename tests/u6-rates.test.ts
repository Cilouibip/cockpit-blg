import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildVisualJourneyReport, type VisualJourneyProjectionInput } from '../src/lib/visual-journey-report';
import type { VisualJourneyRate, VisualJourneyReport } from '../src/lib/visual-journey-contract';
import { VisualJourneyView } from '../src/components/VisualJourneyView';
import ResultsPage from '../src/components/ResultsPage';
import type { DashboardFilters, DashboardResponse, Metric } from '../src/lib/ui-contract';
import { visualJourneyFixture } from './fixtures/visual-journey';

// U6 : taux du Parcours selon D3 option A (décision Mehdi du 23/09). Données synthétiques seulement.
const at = (hhmm: string) => `2026-09-18T${hhmm}:00Z`;
const VISITORS = ['00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000103'];
type Plan = { open: string; registered: string | null; video: string | null; calendar: string | null; booked: string | null };
// Deux personnes entrent avant la couverture commune (10:00 UTC), la troisième après.
const PLAN: Plan[] = [
  { open: '08:00', registered: '08:05', video: '08:10', calendar: '08:20', booked: '08:25' },
  { open: '09:00', registered: null, video: null, calendar: null, booked: null },
  { open: '11:00', registered: '11:05', video: '11:10', calendar: '11:20', booked: '11:25' },
];
const minuteLater = (hhmm: string) => at(`${hhmm.slice(0, 3)}${String(Number(hhmm.slice(3)) + 1).padStart(2, '0')}`);
type Freshness = VisualJourneyReport['freshness']['wix'];
const covered = (coveredThrough: string | null, status: Freshness['status'] = 'available', reason: string | null = null): Freshness => ({ observedAt: coveredThrough, coveredThrough, status, reason });

function threePeople(): VisualJourneyProjectionInput {
  const input = visualJourneyFixture();
  const browser = input.browser![0], registration = input.registrations![0];
  input.browser = PLAN.map((plan, index) => ({
    ...browser, browserId: `browser-${index}`, visitorId: VISITORS[index], sessionId: `session-${index}`, firstSeenAt: at(plan.open), lastSeenAt: at(plan.open),
    pageAt: at(plan.open), ctaAt: null, formOpenAt: at(plan.open), formStartAt: minuteLater(plan.open), videoStartAt: plan.video && at(plan.video),
    bookingClickAt: plan.calendar && at(plan.calendar), bookingOpenAt: plan.calendar && at(plan.calendar), sections: ['hero'], ctaPlacements: [],
  }));
  input.registrations = PLAN.flatMap((plan, index) => plan.registered ? [{
    ...registration, id: `registration-${index}`, personId: `person-${index}`, occurredAt: at(plan.registered), publishedAt: at(plan.registered),
    origin: { ...registration.origin, visitor: VISITORS[index], session: `session-${index}` },
  }] : []);
  input.appointments = PLAN.flatMap((plan, index) => plan.booked ? [{ id: `booking-${index}`, personId: `person-${index}`, bookedAt: at(plan.booked), status: 'unknown', observedAt: input.generatedAt }] : []);
  input.freshness = { posthog: covered(at('11:30')), wix: covered(at('10:00')), appointments: covered(at('10:00')) };
  return input;
}
const wixRates = (report: VisualJourneyReport) => [report.stages[2].fromPrevious!, report.form.rates.registeredFromStarted, report.stages[3].fromPrevious!];
const bookingRates = (report: VisualJourneyReport) => [report.stages[4].fromPrevious!, report.booking.rates.bookedFromCalendar];
const optionA = (numerator: number, denominator: number, coveredThrough: string, excludedAfterCoverage: number): VisualJourneyRate => ({ numerator, denominator, rate: numerator / denominator, available: true, reason: null, coveredThrough, excludedAfterCoverage });

test('U6 (a) deux personnes avant la couverture, une après : taux sur 2, une personne hors taux, compteurs complets', () => {
  const report = buildVisualJourneyReport(threePeople());
  assert.deepEqual(report.stages.map(stage => stage.count), [3, 3, 2, 2, 2], 'les compteurs gardent toute la sélection, personne récente comprise');
  assert.deepEqual(report.stages[2].fromPrevious, optionA(1, 2, at('10:00'), 1), 'ouvrent le formulaire → s’inscrivent : 1 sur les 2 personnes couvertes');
  assert.deepEqual(report.form.rates.registeredFromStarted, optionA(1, 2, at('10:00'), 1));
  assert.deepEqual(report.stages[3].fromPrevious, optionA(1, 1, at('10:00'), 1), 'l’inscription de 11:05 sort des deux termes');
  assert.deepEqual(report.stages[4].fromPrevious, optionA(1, 1, at('10:00'), 1), 'la vidéo de 11:10 sort des deux termes');
  assert.deepEqual(report.booking.rates.bookedFromCalendar, optionA(1, 1, at('10:00'), 1));
  // Taux purement navigateur : inchangés, couverture PostHog, personne écartée.
  assert.deepEqual(report.stages[1].fromPrevious, optionA(3, 3, at('11:30'), 0));
  assert.deepEqual(report.form.rates.startedFromOpened, optionA(3, 3, at('11:30'), 0));
  assert.equal(report.booking.rates.calendarFromClicked.excludedAfterCoverage, 0);
  assert.equal(report.video.thresholds[0].fromStarted.coveredThrough, at('11:30'));
});

test('U6 (b) toutes les personnes après la couverture : taux indisponible avec l’heure, jamais 0 %', () => {
  const input = threePeople();
  input.freshness.wix = covered(at('07:00'));
  const report = buildVisualJourneyReport(input);
  assert.deepEqual(report.stages[2].fromPrevious, { numerator: 0, denominator: 0, rate: null, available: false, reason: 'Aucune activité antérieure à la couverture des inscriptions du 18 sept. 2026, 09:00.', coveredThrough: at('07:00'), excludedAfterCoverage: 3 });
  assert.equal(report.form.rates.registeredFromStarted.rate, null);
  assert.equal(report.stages[3].fromPrevious?.excludedAfterCoverage, 2);
  for (const rate of bookingRates(report)) {
    assert.equal(rate.rate, null); assert.equal(rate.available, false);
    assert.equal(rate.reason, 'Aucune activité antérieure à la couverture des inscriptions et des rendez-vous du 18 sept. 2026, 09:00.');
  }
  assert.deepEqual(report.stages.map(stage => stage.count), [3, 3, 2, 2, 2], 'les volumes restent lisibles');
  for (const rate of [...wixRates(report), ...bookingRates(report)]) assert.notEqual(rate.rate, 0, 'aucun zéro fabriqué');
});

test('U6 (c) la couverture d’un taux est la plus ancienne des sources qu’il fait intervenir, comparée en instants', () => {
  const input = threePeople();
  input.freshness.wix = covered(at('10:00')); input.freshness.appointments = covered(at('09:00'));
  let report = buildVisualJourneyReport(input);
  for (const rate of wixRates(report)) assert.equal(rate.coveredThrough, at('10:00'), 'Wix seul pour les taux d’inscription');
  for (const rate of bookingRates(report)) assert.equal(rate.coveredThrough, at('09:00'), 'Notion plus ancien pour les taux de rendez-vous');
  input.freshness.wix = covered(at('09:00')); input.freshness.appointments = covered(at('10:00'));
  report = buildVisualJourneyReport(input);
  for (const rate of [...wixRates(report), ...bookingRates(report)]) assert.equal(rate.coveredThrough, at('09:00'));
  // 11:30+02:00 (09:30 UTC) précède 09:45 UTC alors que la chaîne est plus « grande ».
  input.freshness.wix = covered('2026-09-18T11:30:00+02:00'); input.freshness.appointments = covered(at('09:45'));
  report = buildVisualJourneyReport(input);
  for (const rate of bookingRates(report)) assert.equal(rate.coveredThrough, '2026-09-18T09:30:00Z');
  assert.equal(report.stages[1].fromPrevious?.coveredThrough, at('11:30'), 'taux navigateur : couverture PostHog');
});

test('U6 (d) une source à actualiser reste utilisable ; absente, en échec, en cours ou sans couverture ne l’est pas', () => {
  const input = threePeople();
  input.freshness.wix = covered(at('10:00'), 'stale', 'les inscriptions : les données attendent leur mise à jour horaire.');
  input.freshness.appointments = covered(at('10:00'), 'stale', 'les rendez-vous : les données attendent leur mise à jour horaire.');
  let report = buildVisualJourneyReport(input);
  assert.deepEqual(report.stages[2].fromPrevious, optionA(1, 2, at('10:00'), 1));
  assert.deepEqual(report.stages[4].fromPrevious, optionA(1, 1, at('10:00'), 1));
  for (const status of ['missing', 'failed', 'running'] as const) {
    const blocked = threePeople(), reason = `Inscriptions : ${status}.`;
    blocked.freshness.wix = covered(at('10:00'), status, reason);
    report = buildVisualJourneyReport(blocked);
    for (const rate of [...wixRates(report), ...bookingRates(report)]) {
      assert.equal(rate.available, false, status); assert.equal(rate.rate, null, status); assert.equal(rate.reason, reason, status);
      assert.equal(rate.coveredThrough, null, status); assert.equal(rate.excludedAfterCoverage, 0, status);
    }
    const notion = threePeople(), notionReason = `Rendez-vous : ${status}.`;
    notion.freshness.appointments = covered(at('10:00'), status, notionReason);
    report = buildVisualJourneyReport(notion);
    for (const rate of bookingRates(report)) assert.equal(rate.reason, notionReason, status);
    assert.equal(report.stages[2].fromPrevious?.available, true, 'Notion ne bloque pas les taux d’inscription');
  }
  const unknown = threePeople(); unknown.freshness.wix = covered(null);
  assert.equal(buildVisualJourneyReport(unknown).stages[2].fromPrevious?.available, false, 'couverture inconnue');
  const absent = threePeople(); absent.registrations = null; absent.registrationError = 'Inscriptions illisibles.';
  for (const rate of [...wixRates(buildVisualJourneyReport(absent)), ...bookingRates(buildVisualJourneyReport(absent))]) assert.equal(rate.reason, 'Inscriptions illisibles.');
  const noMirror = threePeople(); noMirror.appointments = null; noMirror.appointmentError = 'Miroir illisible.';
  for (const rate of bookingRates(buildVisualJourneyReport(noMirror))) assert.equal(rate.reason, 'Miroir illisible.');
});

test('U6 (e) une réservation sans date de réservation garde les taux RDV indisponibles, même hors couverture', () => {
  for (const index of [0, 2]) {
    const input = threePeople();
    input.appointments!.find(row => row.personId === `person-${index}`)!.bookedAt = null;
    const report = buildVisualJourneyReport(input);
    for (const rate of bookingRates(report)) {
      assert.equal(rate.available, false); assert.equal(rate.rate, null);
      assert.equal(rate.reason, 'La date prévue du rendez-vous ne prouve pas quand il a été réservé.');
    }
    assert.equal(report.booking.booked.count, 2, 'le volume de réservants reste lisible');
    assert.equal(report.stages[2].fromPrevious?.available, true, 'les taux d’inscription ne dépendent pas de la date de réservation');
  }
});

test('U6 (f) la vue dit jusqu’où portent les taux et combien de personnes plus récentes sont hors taux', () => {
  const html = renderToStaticMarkup(createElement(VisualJourneyView, { report: buildVisualJourneyReport(threePeople()) }));
  assert.match(html, /1 sur 2 : 50 % · activités jusqu’au 18 sept\. 2026, 12:00 ; 1 personne plus récente hors taux/);
  assert.match(html, /3 sur 3 : 100 % · activités jusqu’au 18 sept\. 2026, 13:30"/, 'taux navigateur : aucune mention hors taux');
  assert.match(html, /class="journey-rate-coverage">Taux : activités jusqu’au 18 sept\. 2026, 12:00\. Compteurs : lecture du 18 sept\. 2026, 14:00\.</);
  const all = threePeople(); all.browser = null; all.browserError = 'Visites illisibles.';
  const unavailable = renderToStaticMarkup(createElement(VisualJourneyView, { report: buildVisualJourneyReport(all) }));
  assert.match(unavailable, /class="journey-rate-coverage">Taux indisponibles : Visites illisibles\. Compteurs : lecture du 18 sept\. 2026, 14:00\.</);
  assert.doesNotMatch(unavailable, /activités jusqu’au/);
});

test('U6 (g) Résultats affiche la base de date de chaque compteur de rendez-vous', () => {
  const metric = (id: string, label: string, value: number): Metric => ({ id, label, value, unit: 'count', source: 'Notion · suivi commercial', definition: '', coverage: '', updatedAt: null });
  const data: DashboardResponse = {
    mode: 'live', generatedAt: '2026-09-18T12:00:00Z', period: { from: '2026-09-01', to: '2026-09-18', timezone: 'Europe/Paris' },
    metrics: [metric('appointments', 'RDV réalisés', 3)], series: [], pillars: [{ id: 'commercial', title: 'Commercial', description: '', metrics: [metric('booked', 'RDV réservés', 5)] }],
    journeys: [], details: [], campaigns: [], notices: [],
  };
  const filters: DashboardFilters = { from: '2026-09-01', to: '2026-09-18', source: 'all', tunnel: 'all', campaign: '', compare: false };
  const html = renderToStaticMarkup(createElement(ResultsPage, { data, filters }));
  const card = html.match(/data-metric="appointments">([\s\S]*?)<\/article>/)?.[1] ?? '';
  assert.match(card, /<strong>5<\/strong><span>Réservés · date de réservation<\/span>/);
  assert.match(card, /<strong>3<\/strong><span>Réalisés · date du créneau<\/span>/);
  assert.match(card, /Deux bases de dates : un écart entre les deux n’est pas une erreur\./);
  // La note du tableau par publicité n'est rendue qu'après sa lecture réseau : contrôle du texte source.
  const source = readFileSync(new URL('../src/components/ResultsPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /<th>RDV réservés<\/th>[\s\S]*<th>RDV réalisés<\/th>/, 'le tableau garde ses en-têtes, sans colonne ajoutée');
  assert.match(source, /RDV réservés par date de réservation, RDV réalisés par date du créneau[^<]*un écart entre les deux n’est pas une erreur\./);
});
