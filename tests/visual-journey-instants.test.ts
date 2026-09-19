import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVisualJourneyReport } from '../src/lib/visual-journey-report';
import { AD_A, AD_B, VISITOR_B, visualJourneyFixture } from './fixtures/visual-journey';

const at = (fraction = '') => `2026-09-18T09:26:48${fraction}Z`;
function singlePerson() {
  const input = visualJourneyFixture();
  input.browser = [input.browser![0]];
  input.registrations = [input.registrations![0]];
  input.appointments = [{ ...input.appointments![0], bookedAt: '2026-09-18T10:00:00Z' }];
  input.freshness.wix = input.freshness.appointments = { observedAt: input.generatedAt, coveredThrough: input.generatedAt, status: 'available', reason: null };
  return input;
}

test('les couvertures Wix et RDV comparent les instants exacts avant, après et à égalité', () => {
  const cases: [string, string, boolean][] = [
    [at(), at('.500'), true], [at('.500'), at(), false],
    [at('.1'), at('.100'), true], [at('.100'), at('.1'), true],
    [at(), '2026-09-18T11:26:48+02:00', true],
    ['2026-09-18T11:26:48+02:00', at(), true],
    [at('.000000001'), at(), false], [at(), at('.000000001'), true],
  ];
  for (const [prerequisite, coveredThrough, covered] of cases) {
    for (const source of ['wix', 'appointments'] as const) {
      const input = singlePerson();
      input.browser![0].formOpenAt = input.browser![0].formStartAt = prerequisite;
      input.browser![0].bookingOpenAt = prerequisite;
      input.registrations![0].occurredAt = prerequisite;
      input.freshness[source] = { ...input.freshness[source], coveredThrough };
      const report = buildVisualJourneyReport(input);
      assert.equal(source === 'wix' ? report.stages[2].fromPrevious!.available : report.booking.rates.bookedFromCalendar.available, covered, `${source}: ${coveredThrough} covers ${prerequisite}`);
      assert.equal(report.form.registered.count, 1);
      assert.equal(report.booking.booked.count, 1, 'le volume connu ne dépend pas de la disponibilité du taux');
    }
  }
});

test('toutes les étapes gardent leur ordre dans une même seconde, sans arrondir les nanosecondes', () => {
  const input = singlePerson(), browser = input.browser![0];
  browser.pageAt = at(); browser.formOpenAt = at('.1'); browser.formStartAt = at('.100');
  input.registrations![0].occurredAt = at('.100000001'); browser.videoStartAt = at('.100000002');
  browser.bookingClickAt = at('.2'); browser.bookingOpenAt = at('.200000001');
  input.appointments![0].bookedAt = at('.200000002');
  const report = buildVisualJourneyReport(input);
  assert.deepEqual(report.stages.slice(1).map(row => row.fromPrevious?.rate), [1, 1, 1, 1]);
  assert.equal(report.form.rates.startedFromOpened.rate, 1);
  assert.equal(report.form.rates.registeredFromStarted.rate, 1);
  assert.equal(report.booking.rates.calendarFromClicked.rate, 1);
  assert.equal(report.booking.rates.bookedFromCalendar.rate, 1);
  browser.formOpenAt = at('.000000001'); browser.pageAt = at('.000000002');
  browser.videoStartAt = at('.100000000');
  input.appointments![0].bookedAt = at('.099999999');
  const reversed = buildVisualJourneyReport(input);
  assert.equal(reversed.stages[1].fromPrevious?.rate, 0);
  assert.equal(reversed.stages[3].fromPrevious?.rate, 0);
  assert.equal(reversed.stages[4].fromPrevious?.rate, null, 'sans passage inscrit→vidéo, la base du taux RDV reste nulle');
  assert.equal(reversed.booking.rates.bookedFromCalendar.rate, 0);
  browser.videoStartAt = at('.100000002');
  assert.equal(buildVisualJourneyReport(input).stages[4].fromPrevious?.rate, 0);
});

test('une même date avec plusieurs décalages horaires reste égale à toutes les étapes', () => {
  const input = singlePerson(), browser = input.browser![0];
  const utc = at('.100'), east = '2026-09-18T11:26:48.1+02:00', west = '2026-09-18T04:26:48.100000000-05:00';
  browser.pageAt = east; browser.formOpenAt = west; browser.formStartAt = utc;
  input.registrations![0].occurredAt = east; browser.videoStartAt = west;
  browser.bookingClickAt = utc; browser.bookingOpenAt = east; input.appointments![0].bookedAt = west;
  const report = buildVisualJourneyReport(input);
  assert.deepEqual(report.stages.slice(1).map(row => row.fromPrevious?.rate), [1, 1, 1, 1]);
  assert.equal(report.form.rates.startedFromOpened.rate, 1);
  assert.equal(report.form.rates.registeredFromStarted.rate, 1);
  assert.equal(report.booking.rates.calendarFromClicked.rate, 1);
  assert.equal(report.booking.rates.bookedFromCalendar.rate, 1);
});

test('le premier événement navigateur et la première inscription sont choisis chronologiquement', () => {
  const input = singlePerson(), browser = input.browser![0], registration = input.registrations![0];
  input.browser = [
    { ...browser, pageAt: at('.5'), formOpenAt: at('.25'), videoStartAt: at('.25') },
    { ...browser, pageAt: at(), formOpenAt: null, videoStartAt: null },
  ];
  input.registrations = [{ ...registration, occurredAt: at('.5') }, { ...registration, id: 'repeat', occurredAt: at() }];
  const report = buildVisualJourneyReport(input);
  assert.equal(report.page.visitors.count, 1);
  assert.equal(report.form.registered.count, 1);
  assert.equal(report.stages[1].fromPrevious?.rate, 1);
  assert.equal(report.stages[3].fromPrevious?.rate, 1);
});

test('la couverture retient le dernier prérequis et non la chaîne terminée par Z', () => {
  for (const source of ['wix', 'appointments'] as const) {
    const input = singlePerson(), browser = input.browser![0], registration = input.registrations![0];
    input.browser = [
      { ...browser, formOpenAt: at(), formStartAt: null, bookingOpenAt: at() },
      { ...browser, visitorId: VISITOR_B, sessionId: 'other', formOpenAt: at('.5'), formStartAt: null, bookingOpenAt: at('.5') },
    ];
    input.registrations = source === 'wix' ? [] : [{ ...registration, occurredAt: at() }, { ...registration, id: 'other-registration', personId: 'other-person', occurredAt: at('.5') }];
    input.appointments = [];
    input.freshness[source] = { ...input.freshness[source], coveredThrough: at() };
    const report = buildVisualJourneyReport(input);
    assert.equal(source === 'wix' ? report.form.registered.count : report.booking.booked.count, null, source);
  }
});

test('la première origine conserve A avant le retour B à fraction de seconde et entre fuseaux', () => {
  for (const [first, later] of [[at(), at('.5')], ['2026-09-18T11:26:48+02:00', at('.000000001')]]) {
    for (const family of ['browser', 'registrations', 'linked']) {
      const input = singlePerson(), browser = input.browser![0], registration = input.registrations![0];
      const originA = { source: 'facebook', medium: 'paid_social', ad: AD_A, at: first };
      const originB = { source: 'facebook', medium: 'paid_social', ad: AD_B, at: later };
      input.browser = family === 'registrations' ? [] : family === 'linked' ? [{ ...browser, firstSeenAt: later, origin: originB }] : [
        { ...browser, firstSeenAt: later, origin: originB }, { ...browser, firstSeenAt: first, origin: originA },
      ];
      input.registrations = family === 'browser' ? [] : [
        { ...registration, occurredAt: later, firstTouch: originB }, { ...registration, id: 'first', occurredAt: first, firstTouch: originA },
      ];
      input.campaign = `meta-ad:${AD_A}`;
      const a = buildVisualJourneyReport(input);
      assert.equal(a.page.visitors.count, family === 'registrations' ? 0 : 1, family);
      assert.equal(a.form.registered.count, family === 'browser' ? 0 : 1, family);
      input.campaign = `meta-ad:${AD_B}`;
      const b = buildVisualJourneyReport(input);
      assert.equal(b.page.visitors.count, 0, family);
      assert.equal(b.form.registered.count, 0, family);
    }
  }
});

test('les rendez-vous sont triés par instant prévu exact, puis identifiant en cas égal', () => {
  const input = singlePerson(), appointment = input.appointments![0];
  input.appointments = [
    { ...appointment, id: 'z-same', scheduledAt: at() },
    { ...appointment, id: 'later', scheduledAt: at('.100000001') },
    { ...appointment, id: 'a-same', scheduledAt: '2026-09-18T11:26:48+02:00' },
    { ...appointment, id: 'earlier', scheduledAt: at('.1') },
    { ...appointment, id: 'undated', scheduledAt: null },
  ];
  assert.deepEqual(buildVisualJourneyReport(input).booking.people![0].appointments.map(row => row.id), ['undated', 'a-same', 'z-same', 'earlier', 'later']);
});

test('un instant invalide soumis à une comparaison est refusé au lieu de valider un taux', () => {
  for (const invalid of ['not-an-instant', '2026-02-30T09:00:00Z', '2026-09-18T09:26:48']) {
    for (const field of ['page', 'registration', 'booking', 'coverage'] as const) {
      const input = singlePerson();
      if (field === 'page') input.browser![0].pageAt = invalid;
      if (field === 'registration') input.registrations![0].occurredAt = invalid;
      if (field === 'booking') input.appointments![0].bookedAt = invalid;
      if (field === 'coverage') input.freshness.wix = { ...input.freshness.wix, coveredThrough: invalid };
      assert.throws(() => buildVisualJourneyReport(input), RangeError, `${field}: ${invalid}`);
    }
  }
});

test('une date prévue historique sans heure conserve son tri sans devenir une preuve de réservation', () => {
  const input = singlePerson(), appointment = input.appointments![0];
  input.appointments = [
    { ...appointment, id: 'timed', bookedAt: null, scheduledAt: '2026-09-21T10:00:00Z' },
    { ...appointment, id: 'day-only', bookedAt: null, scheduledAt: '2026-09-21' },
    { ...appointment, id: 'undated', bookedAt: null, scheduledAt: null },
    { ...appointment, id: 'previous-day', bookedAt: null, scheduledAt: '2026-09-20' },
  ];
  const report = buildVisualJourneyReport(input);
  assert.deepEqual(report.booking.people![0].appointments.map(row => row.id), ['undated', 'previous-day', 'day-only', 'timed']);
  assert.equal(report.booking.people![0].appointments.find(row => row.id === 'day-only')!.scheduledAt, '2026-09-21');
  assert.equal(report.booking.booked.count, 1);
  assert.equal(report.stages[4].fromPrevious?.rate, null);
  assert.equal(report.booking.rates.bookedFromCalendar.rate, null);
});

test('le tri mêlant date seule et instants équivalents avec décalage reste stable quel que soit leur ordre', () => {
  const input = singlePerson(), appointment = input.appointments![0];
  const rows = [
    { ...appointment, id: 'before', scheduledAt: '2026-09-21T00:30:00+02:00' },
    { ...appointment, id: 'day', scheduledAt: '2026-09-21' },
    { ...appointment, id: 'after', scheduledAt: '2026-09-20T23:30:00-02:00' },
  ];
  for (const order of [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]]) {
    input.appointments = order.map(index => rows[index]);
    assert.deepEqual(buildVisualJourneyReport(input).booking.people![0].appointments.map(row => row.id), ['before', 'day', 'after']);
  }
});
