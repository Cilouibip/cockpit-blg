import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVisualJourneyReport } from '../src/lib/visual-journey-report';
import { AD_A, AD_B, VISITOR_B, visualJourneyFixture } from './fixtures/visual-journey';

test('le détail des réservants contient exactement les personnes du compteur et leurs dates futures', () => {
  const input = visualJourneyFixture();
  const slot = { ...input.appointments![0], displayName: 'Camille Exemple', bookedAt: '2026-09-18T14:57:00Z', scheduledAt: '2026-09-21T17:00:00Z' };
  input.appointments = [slot, slot, { ...slot, id: 'cancelled', status: 'cancelled' }, { ...slot, id: 'other-person', personId: 'someone-else', displayName: 'Autre Exemple' }];
  const result = buildVisualJourneyReport(input);
  assert.equal(result.booking.people?.length, result.booking.booked.count);
  assert.deepEqual(result.booking.people, [{ name: 'Camille Exemple', originLabel: 'Publicité A', appointments: [{ id: slot.id, bookedAt: slot.bookedAt, scheduledAt: slot.scheduledAt, status: slot.status }] }]);
  input.campaign = `meta-ad:${AD_B}`;
  assert.deepEqual(buildVisualJourneyReport(input).booking.people, []);
  input.appointments = null;
  assert.deepEqual(buildVisualJourneyReport(input).booking.people, []);
});

test('le détail ne devine ni identité ni date et exclut les réservations explicitement test', () => {
  const input = visualJourneyFixture();
  assert.equal(buildVisualJourneyReport(input).booking.people?.[0].name, 'Nom non renseigné');
  assert.equal(buildVisualJourneyReport(input).booking.people?.[0].appointments[0].scheduledAt, null);
  input.appointments![0].explicitTest = true;
  assert.deepEqual(buildVisualJourneyReport(input).booking.people, []);
});

test('le parcours compte des personnes, conserve les retours et les confirmations Wix sans navigateur', () => {
  const report = buildVisualJourneyReport(visualJourneyFixture());
  assert.deepEqual(report.stages.map(stage => [stage.id, stage.count]), [
    ['page', 2], ['form', 2], ['signup', 2], ['watch', 1], ['call', 1],
  ]);
  assert.equal(report.coverage.registrations, 3, 'les deux lignes de la même personne restent visibles en couverture source');
  assert.equal(report.form.registered.count, 2, 'les personnes inscrites sont dédupliquées');
  assert.equal(report.coverage.registrationsWithoutBrowserIdentity, 1);
  assert.match(report.limits.join(' '), /Le parcours de 1 inscrit n’a pas pu être relié\. Il reste compté parmi les inscriptions\. Son absence du passage confirmé vers la vidéo ne prouve pas qu’il ne l’a pas démarrée/);
  assert.equal(report.page.sections.find(section => section.id === 'hero')?.visitors.count, 2);
  assert.equal(report.video.thresholds.find(row => row.seconds === 180)?.visitors, 1);
  assert.equal(report.video.thresholds.find(row => row.seconds === 300)?.visitors, 0);
});

test('chaque taux garde sa cohorte et la date prévue du RDV ne devient pas une réservation', () => {
  const input = visualJourneyFixture();
  const report = buildVisualJourneyReport(input);
  // Taux navigateur : couverture PostHog, personne écartée ; taux Wix : couverture des inscriptions.
  assert.deepEqual(report.stages[1].fromPrevious, { numerator: 2, denominator: 2, rate: 1, available: true, reason: null, coveredThrough: '2026-09-18T11:01:00Z', excludedAfterCoverage: 0 });
  assert.deepEqual(report.form.rates.registeredFromStarted, { numerator: 1, denominator: 2, rate: 0.5, available: true, reason: null, coveredThrough: '2026-09-18T10:31:00Z', excludedAfterCoverage: 0 });
  assert.deepEqual(report.stages[3].fromPrevious, { numerator: 1, denominator: 2, rate: 0.5, available: true, reason: null, coveredThrough: '2026-09-18T10:31:00Z', excludedAfterCoverage: 0 });
  assert.equal(report.booking.booked.count, 1, 'le volume métier lié reste lisible même si le miroir est ancien');
  assert.equal(report.stages[4].fromPrevious?.available, false);
  assert.equal(report.booking.rates.bookedFromCalendar.available, false);
  assert.match(report.stages[4].fromPrevious?.reason ?? '', /date prévue du rendez-vous ne prouve pas/);
  assert.match(report.limits.join(' '), /date prévue du rendez-vous ne prouve pas quand il a été réservé\. Les taux vers le rendez-vous restent indisponibles/);
  assert.equal(report.status, 'partial');
  // Une fois la réservation datée, le miroir « à actualiser » reste utilisable mais ne couvre aucune activité : taux indisponible, jamais 0 %.
  input.appointments![0].bookedAt = '2026-09-18T08:21:00Z';
  const dated = buildVisualJourneyReport(input);
  assert.equal(dated.stages[4].fromPrevious?.rate, null);
  assert.equal(dated.stages[4].fromPrevious?.excludedAfterCoverage, 1);
  assert.equal(dated.stages[4].fromPrevious?.coveredThrough, '2026-09-17T23:35:39Z');
  assert.match(dated.stages[4].fromPrevious?.reason ?? '', /^Aucune activité antérieure à la couverture des inscriptions et des rendez-vous du 18 sept\. 2026, 01:35\.$/);
  assert.equal(dated.booking.rates.bookedFromCalendar.rate, null);
  assert.equal(dated.booking.booked.count, 1);
});

test('la première origine A filtre toutes les étapes et ne bascule pas sur le retour B', () => {
  const a = visualJourneyFixture(); a.source = 'paid'; a.campaign = `meta-ad:${AD_A}`;
  const reportA = buildVisualJourneyReport(a);
  assert.deepEqual(reportA.stages.slice(0, 4).map(stage => stage.count), [1, 1, 1, 1]);
  const b = visualJourneyFixture(); b.source = 'paid'; b.campaign = `meta-ad:${AD_B}`;
  const reportB = buildVisualJourneyReport(b);
  assert.deepEqual(reportB.stages.slice(0, 4).map(stage => stage.count), [1, 1, 0, 0]);
});

test('une source navigateur absente ne transforme pas le parcours en zéros', () => {
  const fixture = visualJourneyFixture(); fixture.browser = null; fixture.browserError = 'PostHog indisponible.';
  fixture.freshness.posthog = { observedAt: null, coveredThrough: null, status: 'failed', reason: fixture.browserError };
  const report = buildVisualJourneyReport(fixture);
  assert.equal(report.stages[0].count, null);
  assert.equal(report.stages[2].count, 2);
  assert.equal(report.page.visitors.available, false);
  assert.equal(report.form.registered.available, true);
});

test('les essais explicites ne sont inclus que sur demande', () => {
  const excludedFixture = visualJourneyFixture();
  excludedFixture.registrations!.push({ id: 'test-registration', personId: 'test-person', identityState: 'linked', occurredAt: '2026-09-18T11:10:00Z', publishedAt: '2026-09-18T11:11:00Z', origin: { source: 'test', medium: 'recette' }, firstTouch: null });
  const excluded = buildVisualJourneyReport(excludedFixture);
  const includedFixture = visualJourneyFixture(); includedFixture.includeTests = true;
  const included = buildVisualJourneyReport(includedFixture);
  assert.equal(excluded.page.visitors.count, 2);
  assert.equal(excluded.coverage.registrations, 3);
  assert.equal(excluded.coverage.registrationsWithoutBrowserIdentity, 1);
  assert.equal(included.page.visitors.count, 3);
});

test('un sid porté par deux visiteurs ne rapproche jamais une inscription sans visitor_id', () => {
  const fixture = visualJourneyFixture();
  const base = fixture.browser![0];
  fixture.browser = [
    { ...base, browserId: 'browser-one', visitorId: '00000000-0000-4000-8000-000000000021', sessionId: 'shared-session' },
    { ...base, browserId: 'browser-two', visitorId: '00000000-0000-4000-8000-000000000022', sessionId: 'shared-session' },
  ];
  fixture.registrations = [{
    id: 'session-only', personId: 'person-session', identityState: 'linked', occurredAt: '2026-09-18T08:06:00Z', publishedAt: '2026-09-18T08:10:00Z',
    origin: { session: 'shared-session', source: 'facebook', medium: 'paid_social', ad: AD_A }, firstTouch: null,
  }];
  fixture.appointments = [];
  const report = buildVisualJourneyReport(fixture);
  assert.equal(report.form.registered.count, 1);
  assert.equal(report.stages[3].fromPrevious?.numerator, 0);
  assert.equal(report.stages[3].fromPrevious?.denominator, 1);
});

test('un sid non ambigu raccorde une inscription Wix dépourvue de visitor_id', () => {
  const fixture = visualJourneyFixture();
  fixture.browser = [fixture.browser![0]];
  fixture.registrations = [{
    id: 'session-only', personId: 'person-session', identityState: 'linked', occurredAt: '2026-09-18T08:06:00Z', publishedAt: '2026-09-18T08:10:00Z',
    origin: { session: 'session-a1', source: 'facebook', medium: 'paid_social', ad: AD_A }, firstTouch: null,
  }];
  fixture.appointments = [];
  const report = buildVisualJourneyReport(fixture);
  assert.equal(report.stages[3].fromPrevious?.numerator, 1);
  assert.equal(report.stages[3].fromPrevious?.denominator, 1);
});

test('une couverture RDV antérieure à la vidéo garde le volume mais interdit un taux à zéro', () => {
  const fixture = visualJourneyFixture();
  fixture.appointments = [{ id: 'dated-booking', personId: 'person-a', bookedAt: '2026-09-18T08:21:00Z', status: 'unknown', observedAt: '2026-09-18T07:00:00Z' }];
  fixture.freshness.appointments = { observedAt: '2026-09-18T07:00:00Z', coveredThrough: '2026-09-18T07:00:00Z', status: 'available', reason: null };
  const report = buildVisualJourneyReport(fixture);
  assert.equal(report.booking.booked.count, 1);
  assert.equal(report.stages[4].fromPrevious?.rate, null);
  assert.equal(report.stages[4].fromPrevious?.available, false);
  // Option A : la personne dont la vidéo (08:07) suit la couverture RDV (07:00) sort des deux termes.
  assert.equal(report.stages[4].fromPrevious?.excludedAfterCoverage, 1);
  assert.equal(report.stages[4].fromPrevious?.denominator, 0);
  assert.equal(report.stages[4].fromPrevious?.coveredThrough, '2026-09-18T07:00:00Z');
  assert.match(report.stages[4].fromPrevious?.reason ?? '', /Aucune activité antérieure à la couverture des inscriptions et des rendez-vous du 18 sept\. 2026, 09:00/);
  assert.equal(report.booking.rates.bookedFromCalendar.rate, null);
  assert.equal(report.booking.rates.bookedFromCalendar.excludedAfterCoverage, 1);
  assert.equal(report.status, 'partial');
});

test('atteindre la fin du lecteur ne vaut pas regarder tout le contenu', () => {
  const fixture = visualJourneyFixture();
  fixture.browser = [{ ...fixture.browser![0], uniqueWatchedSeconds: 10, durationSeconds: 437, finishedAt: '2026-09-18T08:20:00Z' }];
  const report = buildVisualJourneyReport(fixture);
  assert.equal(report.video.finished.available, true);
  assert.equal(report.video.finished.count, 0);
});

test('la durée affichée se normalise à la seconde sans modifier les seuils mesurés', () => {
  const fixture = visualJourneyFixture();
  const first = fixture.browser![0], second = fixture.browser![2];
  fixture.browser = [
    { ...first, durationSeconds: 436.82, uniqueWatchedSeconds: 436.81 },
    { ...second, durationSeconds: 436.84, uniqueWatchedSeconds: 436.84, videoStartAt: '2026-09-18T10:04:00Z' },
  ];
  let report = buildVisualJourneyReport(fixture);
  assert.equal(report.video.durationSeconds, 437);
  assert.equal(report.video.finished.count, 1, 'la comparaison de fin conserve les décimales source');
  fixture.browser![1] = { ...fixture.browser![1], durationSeconds: 600 };
  report = buildVisualJourneyReport(fixture);
  assert.equal(report.video.durationSeconds, null, 'deux durées réellement différentes restent distinctes');
});

test('un miroir périmé sans RDV connu ne fabrique pas un zéro, sans cacher inscriptions et vidéo',()=>{
  const fixture=visualJourneyFixture();fixture.appointments=[];
  const report=buildVisualJourneyReport(fixture);
  assert.equal(report.booking.booked.count,null);
  assert.equal(report.form.registered.count,2);
  assert.equal(report.video.started.count,1);
  fixture.freshness.appointments={observedAt:fixture.generatedAt,coveredThrough:fixture.generatedAt,status:'available',reason:null};
  assert.equal(buildVisualJourneyReport(fixture).booking.booked.count,0);
});

test('un test explicite ne contamine pas un retour réel de la même personne',()=>{
  const fixture=visualJourneyFixture();
  fixture.browser!.push({...fixture.browser![0],sessionId:'test-session',explicitTest:true});
  fixture.registrations!.push({...fixture.registrations![0],id:'explicit-test',explicitTest:true,origin:{source:'test'}});
  fixture.appointments![0].explicitTest=true;
  const report=buildVisualJourneyReport(fixture);
  assert.equal(report.page.visitors.count,2);
  assert.equal(report.form.registered.count,2);
  assert.equal(report.coverage.registrations,3);
  assert.equal(report.booking.booked.count,null);
  fixture.includeTests=true;
  assert.equal(buildVisualJourneyReport(fixture).booking.booked.count,1);
});

test('zéro inscription exige une lecture Wix complète couvrant les formulaires, les autres étapes restent visibles',()=>{
 const fixture=visualJourneyFixture();fixture.registrations=[];
 fixture.freshness.wix={observedAt:null,coveredThrough:null,status:'missing',reason:null};
 let report=buildVisualJourneyReport(fixture);
 assert.equal(report.stages[2].count,null);assert.equal(report.form.registered.count,null);
 assert.equal(report.stages[2].fromPrevious?.rate,null);assert.equal(report.form.rates.registeredFromStarted.rate,null);
 assert.equal(report.page.visitors.count,2);assert.equal(report.video.started.count,1);
 fixture.freshness.wix={observedAt:fixture.generatedAt,coveredThrough:fixture.generatedAt,status:'available',reason:null};
 report=buildVisualJourneyReport(fixture);assert.equal(report.stages[2].count,0);assert.equal(report.stages[2].fromPrevious?.rate,0);
});

test('une lecture récente antérieure à une inscription ne prouve pas zéro rendez-vous',()=>{
 const fixture=visualJourneyFixture();fixture.appointments=[];
 fixture.registrations=[{...fixture.registrations![0],occurredAt:'2026-09-18T11:50:00Z'}];
 fixture.freshness.appointments={observedAt:'2026-09-18T11:41:00Z',coveredThrough:'2026-09-18T11:40:00Z',status:'available',reason:null};
 const report=buildVisualJourneyReport(fixture);assert.equal(report.booking.booked.count,null);
 // Option A : l'inscription de 11:50, postérieure à la couverture Wix (10:31), sort des deux termes du taux inscription → vidéo.
 assert.equal(report.form.registered.count,1,'le compteur garde toute la sélection');
 assert.equal(report.stages[3].fromPrevious?.rate,null);
 assert.equal(report.stages[3].fromPrevious?.excludedAfterCoverage,1);
 assert.match(report.stages[3].fromPrevious?.reason??'',/Aucune activité antérieure à la couverture des inscriptions du 18 sept\. 2026, 12:31/);
 assert.equal(report.stages[4].fromPrevious?.rate,null,'sans inscrit relié à une vidéo postérieure, aucun taux RDV');
});

test('une origine navigateur vide ne remplace pas la première origine canonique prouvée',()=>{
 const fixture=visualJourneyFixture();fixture.browser=[{...fixture.browser![0],origin:{}}];
 fixture.registrations=[{...fixture.registrations![0],firstTouch:null,origin:{visitor:fixture.browser[0].visitorId},canonicalOrigin:{source:'facebook',medium:'paid_social',ad:AD_A,at:'2026-09-18T08:01:00Z'}}];
 fixture.campaign=`meta-ad:${AD_A}`;
 const report=buildVisualJourneyReport(fixture);assert.equal(report.form.registered.count,1);assert.equal(report.page.visitors.count,1);
});


test('Wix absent avec Notion frais ne fabrique aucun zéro ni taux de réservation',()=>{
  const fixture=visualJourneyFixture();fixture.registrations=[];fixture.appointments=[];
  fixture.freshness.wix={observedAt:null,coveredThrough:null,status:'missing',reason:'Inscriptions en attente'};
  fixture.freshness.appointments={observedAt:fixture.generatedAt,coveredThrough:fixture.generatedAt,status:'available',reason:null};
  const report=buildVisualJourneyReport(fixture);
  assert.equal(report.form.registered.count,null);
  assert.equal(report.booking.booked.count,null);
  assert.equal(report.booking.rates.bookedFromCalendar.rate,null);
  assert.equal(report.stages[4].fromPrevious?.rate,null);
  // Option A : Wix absent bloque tous les taux qui en dépendent, avec motif, sans couverture ni exclusion inventées.
  for (const value of [report.stages[2].fromPrevious!, report.stages[3].fromPrevious!, report.form.rates.registeredFromStarted, report.stages[4].fromPrevious!, report.booking.rates.bookedFromCalendar]) {
    assert.equal(value.available,false);assert.equal(value.rate,null);assert.equal(value.reason,'Inscriptions en attente');
    assert.equal(value.coveredThrough,null);assert.equal(value.excludedAfterCoverage,0);
  }
});

function bookingIntersectionFixture() {
  const input = visualJourneyFixture();
  const browser = input.browser![0], registration = input.registrations![0];
  input.browser = [
    { ...browser, videoStartAt: '2026-09-18T09:00:00Z', bookingClickAt: '2026-09-18T09:30:00Z', bookingOpenAt: '2026-09-18T09:40:00Z' },
    { ...browser, browserId: 'browser-b', visitorId: VISITOR_B, sessionId: 'session-b', videoStartAt: '2026-09-18T08:30:00Z', bookingClickAt: '2026-09-18T09:30:00Z', bookingOpenAt: '2026-09-18T09:40:00Z' },
  ];
  input.registrations = [
    { ...registration, occurredAt: '2026-09-18T08:30:00Z' },
    { ...registration, id: 'registration-b', personId: 'person-b', occurredAt: '2026-09-18T09:00:00Z', origin: { ...registration.origin, visitor: VISITOR_B, session: 'session-b' } },
  ];
  input.appointments = [
    { id: 'booking-a', personId: 'person-a', bookedAt: '2026-09-18T10:00:00Z', status: 'unknown', observedAt: input.generatedAt },
    { id: 'booking-b', personId: 'person-b', bookedAt: '2026-09-18T10:00:00Z', status: 'unknown', observedAt: input.generatedAt },
  ];
  input.freshness.wix = input.freshness.appointments = { observedAt: input.generatedAt, coveredThrough: input.generatedAt, status: 'available', reason: null };
  return input;
}
// Toute l'activité de ces cas précède la couverture commune (midi) : personne n'est écarté.
const coveredAtNoon = (numerator: number, denominator: number) => ({ numerator, denominator, rate: numerator / denominator, available: true, reason: null, coveredThrough: '2026-09-18T12:00:00Z', excludedAfterCoverage: 0 });

test('vidéo avant inscription reste hors du numérateur vidéo→RDV : 1/1 et deux réservants au total', () => {
  const input = bookingIntersectionFixture(), report = buildVisualJourneyReport(input);
  assert.deepEqual(report.stages.map(stage => stage.count), [2, 2, 2, 2, 2]);
  assert.deepEqual(report.stages[3].fromPrevious, coveredAtNoon(1, 2));
  assert.deepEqual(report.stages[4].fromPrevious, coveredAtNoon(1, 1));
  assert.equal(report.booking.booked.count, 2);
  assert.equal(report.booking.people!.length, 2);
  assert.deepEqual(report.booking.rates.bookedFromCalendar, coveredAtNoon(2, 2), 'le taux calendrier→RDV garde sa propre base');
});

test('le RDV de la seule personne hors dénominateur ne transforme pas 0/1 en 1/1', () => {
  const input = bookingIntersectionFixture();
  input.appointments = [input.appointments![1]];
  const report = buildVisualJourneyReport(input);
  assert.deepEqual(report.stages[4].fromPrevious, coveredAtNoon(0, 1));
  assert.equal(report.booking.booked.count, 1);
  assert.equal(report.booking.rates.bookedFromCalendar.numerator, 1);
  // Option A : si la couverture Notion (08:50) précède la vidéo de A (09:00), A sort des deux termes :
  // aucun 0/1 fabriqué, taux indisponible avec l'heure, volume de B conservé.
  input.freshness.appointments = { ...input.freshness.appointments, coveredThrough: '2026-09-18T08:50:00Z' };
  const early = buildVisualJourneyReport(input);
  assert.deepEqual(early.stages[4].fromPrevious, { numerator: 0, denominator: 0, rate: null, available: false, reason: 'Aucune activité antérieure à la couverture des inscriptions et des rendez-vous du 18 sept. 2026, 10:50.', coveredThrough: '2026-09-18T08:50:00Z', excludedAfterCoverage: 1 });
  assert.equal(early.booking.booked.count, 1);
  assert.equal(early.booking.rates.bookedFromCalendar.rate, null, 'les deux ouvertures du calendrier (09:40) suivent aussi la couverture');
  assert.equal(early.booking.rates.bookedFromCalendar.excludedAfterCoverage, 2);
});

test('égalité inscription→vidéo, sans RDV, annulation et absence de base conservent les règles du taux', () => {
  const input = bookingIntersectionFixture();
  input.browser![1].videoStartAt = '2026-09-18T11:00:00.000+02:00'; // Même instant que son inscription.
  let report = buildVisualJourneyReport(input);
  assert.deepEqual(report.stages[4].fromPrevious, coveredAtNoon(2, 2));
  input.appointments![1].status = 'cancelled';
  report = buildVisualJourneyReport(input);
  assert.deepEqual(report.stages[4].fromPrevious, coveredAtNoon(1, 2));
  input.appointments = [];
  report = buildVisualJourneyReport(input);
  assert.deepEqual(report.stages[4].fromPrevious, coveredAtNoon(0, 2));
  for (const browser of input.browser!) browser.videoStartAt = '2026-09-18T08:00:00Z';
  report = buildVisualJourneyReport(input);
  assert.equal(report.stages[4].fromPrevious?.numerator, 0);
  assert.equal(report.stages[4].fromPrevious?.denominator, 0);
  assert.equal(report.stages[4].fromPrevious?.rate, null);
});

test('une date RDV absente hors de la base conserve la garde de disponibilité actuelle', () => {
  const input = bookingIntersectionFixture();
  input.appointments![1].bookedAt = null;
  const report = buildVisualJourneyReport(input);
  assert.equal(report.booking.booked.count, 2);
  assert.equal(report.stages[4].fromPrevious?.available, false);
  assert.equal(report.stages[4].fromPrevious?.rate, null);
  assert.match(report.stages[4].fromPrevious?.reason ?? '', /date prévue/);
});
