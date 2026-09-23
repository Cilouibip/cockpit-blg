import { Temporal } from '@js-temporal/polyfill';
import type {
  VisualJourneyAvailability,
  VisualJourneyMetric,
  VisualJourneyRate,
  VisualJourneyReport,
  VisualJourneyStage,
} from './visual-journey-contract';
import type { SourceFilter } from './ui-contract';
import { isExcludedTestTraffic } from './traffic-scope';

export const VISUAL_JOURNEY_FORM_ID = '660e5287-80b0-44b6-a831-62ee19572342';
export const VISUAL_JOURNEY_THRESHOLDS = [30, 60, 180, 300] as const;

export interface VisualJourneyBrowserRow {
  /** Identifiant PostHog interne : déduplication navigateur seulement, jamais liaison Wix. */
  browserId: string | null;
  /** UUID blg_vid explicite (`properties.visitor_id`) : seul identifiant navigateur joignable à Wix. */
  visitorId: string | null;
  sessionId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  origin: Record<string, unknown>;
  explicitTest: boolean;
  pageAt: string | null;
  ctaAt: string | null;
  formOpenAt: string | null;
  formStartAt: string | null;
  videoStartAt: string | null;
  bookingClickAt: string | null;
  bookingOpenAt: string | null;
  uniqueWatchedSeconds: number | null;
  durationSeconds: number | null;
  finishedAt: string | null;
  sections: string[];
  ctaPlacements: string[];
}

export interface VisualJourneyRegistrationRow {
  id: string;
  personId: string | null;
  identityState: string;
  occurredAt: string;
  publishedAt: string | null;
  origin: Record<string, unknown>;
  firstTouch: Record<string, unknown> | null;
  explicitTest?: boolean;
  canonicalOrigin?: Record<string, unknown>;
}

export interface VisualJourneyAppointmentRow {
  id: string;
  personId: string | null;
  bookedAt: string | null;
  bookedDay?: string | null;
  status: string;
  observedAt: string | null;
  explicitTest?: boolean;
  displayName?: string | null;
  scheduledAt?: string | null;
}

export interface VisualJourneyProjectionInput {
  from: string;
  to: string;
  source: SourceFilter;
  campaign: string;
  includeTests: boolean;
  generatedAt: string;
  browser: VisualJourneyBrowserRow[] | null;
  browserError?: string | null;
  registrations: VisualJourneyRegistrationRow[] | null;
  registrationError?: string | null;
  appointments: VisualJourneyAppointmentRow[] | null;
  appointmentError?: string | null;
  availableAds?: { id: string; label: string }[];
  freshness: VisualJourneyReport['freshness'];
}

type Origin = { source: string | null; medium: string | null; campaign: string | null; ad: string | null; link: string | null; at: string };
type BrowserPerson = VisualJourneyBrowserRow & { key: string; originA: Origin; sessionIds: Set<string> };
type RegistrationPerson = {
  key: string;
  personId: string | null;
  occurredAt: string;
  originA: Origin;
  visitorIds: Set<string>;
  sessionIds: Set<string>;
  rows: VisualJourneyRegistrationRow[];
};

const available = (): VisualJourneyAvailability => ({ available: true, reason: null });
const unavailable = (reason: string): VisualJourneyAvailability => ({ available: false, reason });
const metric = (count: number | null, state: VisualJourneyAvailability = available()): VisualJourneyMetric => ({ count: state.available ? count : null, ...state });
const rate = (numerator: number | null, denominator: number | null, reason: string): VisualJourneyRate => {
  if (numerator === null || denominator === null) return { numerator, denominator, rate: null, ...unavailable(reason) };
  if (denominator === 0) return { numerator, denominator, rate: null, ...unavailable(reason) };
  return { numerator, denominator, rate: numerator / denominator, ...available() };
};

// D3 option A (décision Mehdi du 23/09) : un taux qui fait intervenir Wix ou Notion est calculé
// sur les seules personnes dont l'événement d'entrée au dénominateur est antérieur ou égal à la
// couverture commune de ces sources. Une personne plus récente sort du numérateur ET du
// dénominateur ; elle n'est jamais comptée comme « n'a pas fait ». Les compteurs d'étape restent
// calculés sur toute la sélection. Une source à actualiser (`stale`) reste utilisable : son heure
// de couverture dit jusqu'où ; une source absente, en échec, en cours ou sans couverture connue
// rend le taux indisponible.
type FreshnessStatus = VisualJourneyReport['freshness']['wix']['status'];
const usableFreshness = new Set<FreshnessStatus>(['available', 'stale']);
const parisTime = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
type RateCoverage = { at: Temporal.Instant | null; blocked: string | null; label: string };
function coveredRate<T>(
  coverage: RateCoverage, blockedDenominator: number | null, population: T[],
  entry: (member: T) => string | null, converted: (member: T) => boolean, emptyReason: string,
): VisualJourneyRate {
  const coveredThrough = coverage.at?.toString() ?? null;
  if (coverage.blocked || !coverage.at) return { numerator: null, denominator: blockedDenominator, rate: null, ...unavailable(coverage.blocked ?? emptyReason), coveredThrough, excludedAfterCoverage: 0 };
  const bound = coverage.at;
  const kept = population.filter(member => { const at = entry(member); return !!at && Temporal.Instant.compare(at, bound) <= 0; });
  const excludedAfterCoverage = population.length - kept.length;
  const numerator = kept.filter(converted).length, denominator = kept.length;
  if (denominator === 0) return { numerator, denominator, rate: null, ...unavailable(excludedAfterCoverage ? `Aucune activité antérieure à la couverture ${coverage.label} du ${parisTime.format(new Date(bound.epochMilliseconds))}.` : emptyReason), coveredThrough, excludedAfterCoverage };
  return { numerator, denominator, rate: numerator / denominator, ...available(), coveredThrough, excludedAfterCoverage };
}
const text =(value: unknown, max = 200) => typeof value === 'string' && value.length <= max ? value.trim() || null : null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const instant = (value: unknown, fallback: string) => {
  if (typeof value !== 'string') return fallback;
  try { return Temporal.Instant.from(value).toString(); } catch { return fallback; }
};
// ISO strings can differ in fractional precision or offset. Compare instants,
// retaining nanoseconds and the original value. Invalid timestamps are rejected
// by Temporal rather than treated as an ordered, valid measurement.
const chronological = <T>(values: T[], at: (value: T) => string) => values
  .map(value => ({ value, at: Temporal.Instant.from(at(value)) }))
  .sort((a, b) => Temporal.Instant.compare(a.at, b.at))
  .map(row => row.value);
const times = (values: string[]) => chronological(values, value => value);
const earliest = <T extends { at: string }>(values: T[]) => chronological(values, value => value.at)[0];
function compareScheduledDates(a: string | null | undefined, b: string | null | undefined) {
  if (a == null || b == null) return a == null ? b == null ? 0 : -1 : 1;
  // Legacy scheduled_day is a calendar date, not an instant. Preserve its
  // existing display order without inventing an appointment time or timezone.
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/;
  if (dayOnly.test(a) || dayOnly.test(b)) {
    // Timed rows are normalized to UTC by the existing source reader. Keep
    // that calendar ordering even if an equivalent offset reaches this layer.
    const day = (value: string) => dayOnly.test(value) ? Temporal.PlainDate.from(value)
      : Temporal.Instant.from(value).toZonedDateTimeISO('UTC').toPlainDate();
    return Temporal.PlainDate.compare(day(a), day(b)) || (dayOnly.test(a) ? dayOnly.test(b) ? 0 : -1 : 1);
  }
  return Temporal.Instant.compare(a, b);
}

function origin(record: Record<string, unknown> | null, fallbackAt: string): Origin {
  const source = text(record?.source ?? record?.utm_source, 80);
  const medium = text(record?.medium ?? record?.utm_medium, 80);
  const campaign = text(record?.campaign ?? record?.utm_campaign, 160);
  const ad = text(record?.ad ?? record?.utm_content, 80);
  const link = text(record?.linkId ?? record?.link_id ?? record?.blg_link_id, 80);
  return { source, medium, campaign, ad, link, at: instant(record?.at, fallbackAt) };
}

function firstOrigin(row: VisualJourneyRegistrationRow): Origin {
  if (row.canonicalOrigin) return origin(row.canonicalOrigin, row.occurredAt);
  const first = origin(row.firstTouch, row.occurredAt);
  if (first.source || first.medium || first.campaign || first.ad || first.link) return first;
  return origin(row.origin, row.occurredAt);
}

function sourceClass(value: Origin): SourceFilter {
  const medium = value.medium?.toLowerCase() ?? '';
  if (['paid', 'cpc', 'ppc', 'paid_social', 'paid-search'].includes(medium) || /^\d{10,30}$/.test(value.ad ?? '')) return 'paid';
  if (['organic', 'social', 'email', 'referral', 'organic_social', 'organic_video'].includes(medium) || value.source) return 'organic';
  return 'unknown';
}

function matches(originA: Origin, source: SourceFilter, campaign: string) {
  if (source !== 'all' && sourceClass(originA) !== source) return false;
  if (!campaign || campaign === 'all') return true;
  const ad = /^meta-ad:(\d{1,30})$/.exec(campaign);
  if (ad) return originA.ad === ad[1];
  const meta = /^meta:(\d{1,30})$/.exec(campaign);
  if (meta) return originA.campaign === meta[1];
  const link = /^link:([0-9a-f-]{36})$/i.exec(campaign);
  return link ? originA.link?.toLowerCase() === link[1].toLowerCase() : originA.campaign === campaign;
}

function combineBrowser(rows: VisualJourneyBrowserRow[]): BrowserPerson[] {
  const sessionVisitors = new Map<string, Set<string>>();
  for (const row of rows) if (row.sessionId && row.visitorId) {
    const visitors = sessionVisitors.get(row.sessionId) ?? new Set<string>(); visitors.add(row.visitorId); sessionVisitors.set(row.sessionId, visitors);
  }
  const groups = new Map<string, VisualJourneyBrowserRow[]>();
  for (const row of rows) {
    const resolved = row.visitorId ?? (row.sessionId && sessionVisitors.get(row.sessionId)?.size === 1 ? [...sessionVisitors.get(row.sessionId)!][0] : null);
    const key = resolved ? `visitor:${resolved}` : row.browserId ? `browser:${row.browserId}` : row.sessionId ? `session:${row.sessionId}` : '';
    if (!key) continue;
    const list = groups.get(key) ?? []; list.push(row); groups.set(key, list);
  }
  const firstTime = (items: VisualJourneyBrowserRow[], field: keyof VisualJourneyBrowserRow) => times(items.map(item => item[field]).filter((value): value is string => typeof value === 'string'))[0] ?? null;
  return [...groups.entries()].map(([key, items]) => {
    const firstSeenAt = times(items.map(row => row.firstSeenAt))[0];
    const origins = items.map(row => origin(row.origin, row.firstSeenAt));
    return {
      key,
      browserId: items.map(row => row.browserId).find(Boolean) ?? null,
      visitorId: key.startsWith('visitor:') ? key.slice(8) : null,
      sessionId: items.map(row => row.sessionId).find(Boolean) ?? null,
      sessionIds: new Set(items.map(row => row.sessionId).filter((value): value is string => !!value)),
      firstSeenAt,
      lastSeenAt: times(items.map(row => row.lastSeenAt)).at(-1)!,
      origin: items.find(row => row.firstSeenAt === firstSeenAt)?.origin ?? {},
      originA: earliest(origins),
      explicitTest: items.some(row => row.explicitTest),
      pageAt: firstTime(items, 'pageAt'), ctaAt: firstTime(items, 'ctaAt'),
      formOpenAt: firstTime(items, 'formOpenAt'), formStartAt: firstTime(items, 'formStartAt'),
      videoStartAt: firstTime(items, 'videoStartAt'), bookingClickAt: firstTime(items, 'bookingClickAt'), bookingOpenAt: firstTime(items, 'bookingOpenAt'),
      uniqueWatchedSeconds: Math.max(...items.map(row => row.uniqueWatchedSeconds ?? -1)) >= 0 ? Math.max(...items.map(row => row.uniqueWatchedSeconds ?? -1)) : null,
      durationSeconds: Math.max(...items.map(row => row.durationSeconds ?? -1)) > 0 ? Math.max(...items.map(row => row.durationSeconds ?? -1)) : null,
      finishedAt: firstTime(items, 'finishedAt'),
      sections: [...new Set(items.flatMap(row => row.sections))].sort(),
      ctaPlacements: [...new Set(items.flatMap(row => row.ctaPlacements))].sort(),
    };
  });
}

function combineRegistrations(rows: VisualJourneyRegistrationRow[]): RegistrationPerson[] {
  const groups = new Map<string, VisualJourneyRegistrationRow[]>();
  for (const row of rows) {
    const visitor = text(row.origin.visitor, 80), session = text(row.origin.session, 200);
    const key = row.personId && row.identityState === 'linked' ? `person:${row.personId}` : visitor && UUID.test(visitor) ? `visitor:${visitor.toLowerCase()}` : session ? `session:${session}` : `registration:${row.id}`;
    const list = groups.get(key) ?? []; list.push(row); groups.set(key, list);
  }
  return [...groups.entries()].map(([key, items]) => {
    const occurredAt = times(items.map(row => row.occurredAt))[0];
    return {
      key,
      personId: items.map(row => row.personId).find(Boolean) ?? null,
      occurredAt,
      originA: earliest(items.map(firstOrigin)),
      visitorIds: new Set(items.map(row => text(row.origin.visitor, 80)?.toLowerCase()).filter((value): value is string => !!value && UUID.test(value))),
      sessionIds: new Set(items.map(row => text(row.origin.session, 200)).filter((value): value is string => !!value)),
      rows: items,
    };
  });
}

function sectionLabel(value: string) { return value.replaceAll(/[-_]+/g, ' ').replace(/^./, first => first.toLocaleUpperCase('fr')); }

export function buildVisualJourneyReport(input: VisualJourneyProjectionInput): VisualJourneyReport {
  const limits: string[] = [];
  const browserAvailable = input.browser !== null;
  const registrationsAvailable = input.registrations !== null;
  const appointmentsAvailable = input.appointments !== null;
  const registrationRows = (input.registrations ?? []).filter(row => input.includeTests || !row.explicitTest && !isExcludedTestTraffic({ includeTests: false }, row.origin, row.firstTouch));
  const appointmentRows = (input.appointments ?? []).filter(row => input.includeTests || !row.explicitTest);
  const browserAll = combineBrowser((input.browser ?? []).filter(row => input.includeTests || !row.explicitTest && !isExcludedTestTraffic({ includeTests: false }, row.origin)));
  const registrationsAll = combineRegistrations(registrationRows);

  const browserByVisitor = new Map<string, BrowserPerson[]>(), browserBySession = new Map<string, BrowserPerson[]>();
  for (const person of browserAll) {
    if (person.visitorId) { const list = browserByVisitor.get(person.visitorId) ?? []; list.push(person); browserByVisitor.set(person.visitorId, list); }
    for (const sessionId of person.sessionIds) { const list = browserBySession.get(sessionId) ?? []; list.push(person); browserBySession.set(sessionId, list); }
  }
  const browserForRegistration = new Map<string, BrowserPerson>();
  const registrationForBrowser = new Map<string, Set<string>>();
  for (const registration of registrationsAll) {
    const candidates = new Set<BrowserPerson>();
    for (const visitor of registration.visitorIds) for (const browser of browserByVisitor.get(visitor) ?? []) candidates.add(browser);
    if (!candidates.size) for (const session of registration.sessionIds) {
      const rows = browserBySession.get(session) ?? [];
      if (rows.length === 1) candidates.add(rows[0]);
    }
    if (candidates.size !== 1) continue;
    const browser = [...candidates][0]; browserForRegistration.set(registration.key, browser);
    const registrations = registrationForBrowser.get(browser.key) ?? new Set<string>(); registrations.add(registration.key); registrationForBrowser.set(browser.key, registrations);
  }
  // Une identité navigateur liée à plusieurs personnes métier n'est jamais fusionnée.
  for (const [browserKey, keys] of registrationForBrowser) if (keys.size > 1) for (const key of keys) browserForRegistration.delete(key);

  const entityOrigin = (browser: BrowserPerson | undefined, registration: RegistrationPerson | undefined) => {
    const candidates = [...(browser ? [browser.originA] : []), ...(registration ? [registration.originA] : [])];
    const measured = candidates.filter(value => value.source || value.medium || value.campaign || value.ad || value.link);
    return earliest(measured.length ? measured : candidates);
  };
  const browserScoped = browserAll.filter(browser => {
    const linked = [...(registrationForBrowser.get(browser.key) ?? [])];
    const registration = linked.length === 1 ? registrationsAll.find(row => row.key === linked[0]) : undefined;
    const originA = entityOrigin(browser, registration);
    return (input.includeTests || (!browser.explicitTest && !isExcludedTestTraffic({ includeTests: false }, browser.origin, registration?.rows[0]?.origin, registration?.rows[0]?.firstTouch))) && matches(originA, input.source, input.campaign);
  });
  const registrationsScoped = registrationsAll.filter(registration => {
    const browser = browserForRegistration.get(registration.key);
    const originA = entityOrigin(browser, registration);
    return (input.includeTests || !isExcludedTestTraffic({ includeTests: false }, ...registration.rows.flatMap(row => [row.origin, row.firstTouch]))) && matches(originA, input.source, input.campaign);
  });
  const registrationSourceRowsScoped = registrationsScoped.flatMap(registration => registration.rows);

  const pagePeople = new Set(browserScoped.filter(row => row.pageAt).map(row => row.key));
  const formOpened = new Set(browserScoped.filter(row => row.formOpenAt).map(row => row.key));
  const formStarted = new Set(browserScoped.filter(row => row.formStartAt).map(row => row.key));
  const videoStarted = new Set(browserScoped.filter(row => row.videoStartAt).map(row => row.key));
  const bookingClicked = new Set(browserScoped.filter(row => row.bookingClickAt).map(row => row.key));
  const calendarOpened = new Set(browserScoped.filter(row => row.bookingOpenAt).map(row => row.key));
  const after = (later: string | null, earlier: string | null) => !!later && !!earlier && Temporal.Instant.compare(later, earlier) >= 0;
  const pageToForm = browserScoped.filter(row => after(row.formOpenAt, row.pageAt)).length;
  const openToStarted = browserScoped.filter(row => after(row.formStartAt, row.formOpenAt)).length;

  const registrationsWithVideoAfterSignup = registrationsScoped.filter(registration => {
    const browser = browserForRegistration.get(registration.key); return browser && after(browser.videoStartAt, registration.occurredAt);
  });
  const registrationsToVideo = registrationsWithVideoAfterSignup.length;
  const registrationsWithoutNavigation = registrationsScoped.filter(registration => !browserForRegistration.has(registration.key)).length;
  // Compteur « S'inscrivent » seulement (inchangé) : un zéro exige une lecture couvrant les formulaires.
  const latestRegistrationPrerequisite = times(browserScoped.flatMap(row => [row.formOpenAt,row.formStartAt]).filter((value): value is string => !!value)).at(-1) ?? null;
  const registrationCoverageComplete = input.freshness.wix.status === 'available' && (!latestRegistrationPrerequisite || after(input.freshness.wix.coveredThrough, latestRegistrationPrerequisite));
  const registrationRateReason = 'Les inscriptions attendent une mise à jour couvrant les formulaires de cette sélection.';
  if (registrationsWithoutNavigation) limits.push(`Le parcours de ${registrationsWithoutNavigation} inscrit${registrationsWithoutNavigation > 1 ? 's' : ''} n’a pas pu être relié. ${registrationsWithoutNavigation > 1 ? 'Ils restent comptés' : 'Il reste compté'} parmi les inscriptions. ${registrationsWithoutNavigation > 1 ? 'Leur absence du passage confirmé vers la vidéo ne prouve pas qu’ils ne l’ont pas démarrée.' : 'Son absence du passage confirmé vers la vidéo ne prouve pas qu’il ne l’a pas démarrée.'}`);

  const appointmentsByPerson = new Map<string, VisualJourneyAppointmentRow[]>();
  for (const appointment of appointmentRows) if (appointment.personId) {
    const list = appointmentsByPerson.get(appointment.personId) ?? []; list.push(appointment); appointmentsByPerson.set(appointment.personId, list);
  }
  const activeAppointment = (row: VisualJourneyAppointmentRow) => !['cancelled', 'canceled', 'rescheduled'].includes(row.status.toLowerCase());
  const bookedRegistrations = registrationsScoped.filter(registration => registration.personId && (appointmentsByPerson.get(registration.personId) ?? []).some(activeAppointment));
  const linkedAppointmentCount = appointmentRows.filter(row => row.personId).length;
  // Compteur « Réservent un rendez-vous » seulement (inchangé) : un zéro exige une lecture couvrant la sélection.
  const latestBookingPrerequisite = times([...browserScoped.map(row => row.bookingOpenAt ?? row.videoStartAt),...registrationsScoped.map(row => row.occurredAt)].filter((value): value is string => !!value)).at(-1) ?? null;
  const appointmentCoverage = input.freshness.appointments.coveredThrough;
  const temporalCoverageComplete = input.freshness.appointments.status === 'available' && (!latestBookingPrerequisite || after(appointmentCoverage, latestBookingPrerequisite));
  const registrationState = !registrationsAvailable ? unavailable(input.registrationError ?? "Les inscriptions Wix ne sont pas disponibles.") : registrationsScoped.length > 0 || registrationCoverageComplete ? available() : unavailable(registrationRateReason);
  const bookingCountState = !registrationState.available ? registrationState
    : !appointmentsAvailable ? unavailable(input.appointmentError ?? "Le miroir des rendez-vous n'est pas disponible.")
    : appointmentRows.length > 0 && linkedAppointmentCount === 0
      ? unavailable("Les rendez-vous enregistrés ne sont pas encore reliés aux inscrits.")
    : bookedRegistrations.length === 0 && !temporalCoverageComplete
      ? unavailable("Les rendez-vous attendent leur mise à jour.") : available();
  const bookedCount = bookingCountState.available ? bookedRegistrations.length : null;
  if (input.freshness.appointments.status !== 'available' && input.freshness.appointments.reason) limits.push(input.freshness.appointments.reason);

  const browserReason = input.browserError ?? "Les observations navigateur ne sont pas disponibles ; aucun zéro n'est fabriqué.";
  const browserState = browserAvailable ? available() : unavailable(browserReason);

  // Taux D3 option A : couverture commune par taux, population restreinte aux personnes entrées
  // au dénominateur au plus tard à cette heure ; numérateur pris dans la même population.
  const sourceCoverage = (source: 'wix' | 'appointments', rowsAvailable: boolean, missingRows: string, unknown: string) => {
    const freshness = input.freshness[source];
    if (!rowsAvailable) return { at: null, blocked: missingRows };
    if (!usableFreshness.has(freshness.status) || !freshness.coveredThrough) return { at: null, blocked: freshness.reason ?? unknown };
    return { at: Temporal.Instant.from(freshness.coveredThrough), blocked: null };
  };
  const wixCoverage = sourceCoverage('wix', registrationsAvailable, registrationState.reason ?? registrationRateReason, registrationRateReason);
  const notionCoverage = sourceCoverage('appointments', appointmentsAvailable, input.appointmentError ?? "Le miroir des rendez-vous n'est pas disponible.", 'La couverture du miroir des rendez-vous est inconnue.');
  const registrationCoverage: RateCoverage = { at: wixCoverage.at, blocked: browserAvailable ? wixCoverage.blocked : browserReason, label: 'des inscriptions' };
  const bookingBlocked = registrationCoverage.blocked ?? notionCoverage.blocked
    ?? (appointmentRows.length > 0 && linkedAppointmentCount === 0 ? "Les rendez-vous enregistrés ne sont pas encore reliés aux inscrits." : null)
    // Règle conservée : la date prévue d'un réservant de la sélection ne prouve pas quand il a réservé.
    ?? (bookedRegistrations.every(registration => !registration.personId || (appointmentsByPerson.get(registration.personId) ?? []).filter(activeAppointment).some(appointment => appointment.bookedAt))
      ? null : "La date prévue du rendez-vous ne prouve pas quand il a été réservé.");
  const bookingCoverage: RateCoverage = {
    at: wixCoverage.at && notionCoverage.at ? (Temporal.Instant.compare(wixCoverage.at, notionCoverage.at) <= 0 ? wixCoverage.at : notionCoverage.at) : null,
    blocked: bookingBlocked, label: 'des inscriptions et des rendez-vous',
  };
  if (bookingBlocked && browserAvailable) limits.push(`${bookingBlocked} Les taux vers le rendez-vous restent indisponibles.`);
  const scopedRegistrationByBrowser = new Map<string, RegistrationPerson>();
  for (const registration of registrationsScoped) { const browser = browserForRegistration.get(registration.key); if (browser) scopedRegistrationByBrowser.set(browser.key, registration); }
  const bookedAfter = (registration: RegistrationPerson | undefined, at: string | null) => !!registration?.personId && !!at
    && (appointmentsByPerson.get(registration.personId) ?? []).some(appointment => activeAppointment(appointment) && after(appointment.bookedAt, at));
  const signupFromOpened = coveredRate(registrationCoverage, browserAvailable ? formOpened.size : null, browserScoped.filter(row => row.formOpenAt), row => row.formOpenAt,
    row => { const registration = scopedRegistrationByBrowser.get(row.key); return !!registration && after(registration.occurredAt, row.formOpenAt); }, 'Aucune ouverture de formulaire mesurée.');
  const signupFromStarted = coveredRate(registrationCoverage, browserAvailable ? formStarted.size : null, browserScoped.filter(row => row.formStartAt), row => row.formStartAt,
    row => { const registration = scopedRegistrationByBrowser.get(row.key); return !!registration && after(registration.occurredAt, row.formStartAt); }, 'Aucun démarrage de formulaire mesuré.');
  const videoFromSignup = coveredRate(registrationCoverage, registrationState.available ? registrationsScoped.length : null, registrationsScoped, registration => registration.occurredAt,
    registration => { const browser = browserForRegistration.get(registration.key); return !!browser && after(browser.videoStartAt, registration.occurredAt); }, 'Aucune inscription confirmée dans cette sélection.');
  // Le dénominateur vidéo → rendez-vous est le numérateur inscription → vidéo, entré à son démarrage vidéo.
  const bookingFromVideo = coveredRate(bookingCoverage, registrationsToVideo || null, registrationsWithVideoAfterSignup, registration => browserForRegistration.get(registration.key)?.videoStartAt ?? null,
    registration => bookedAfter(registration, browserForRegistration.get(registration.key)?.videoStartAt ?? null), 'Aucun inscrit relié à un démarrage vidéo.');
  const bookingFromCalendar = coveredRate(bookingCoverage, browserAvailable ? calendarOpened.size : null, browserScoped.filter(row => row.bookingOpenAt), row => row.bookingOpenAt,
    row => bookedAfter(scopedRegistrationByBrowser.get(row.key), row.bookingOpenAt), 'Aucune ouverture du calendrier mesurée.');
  // Taux purement navigateur : calcul inchangé, couverture PostHog, personne écartée.
  const browserRate = (value: VisualJourneyRate): VisualJourneyRate => ({ ...value, coveredThrough: input.freshness.posthog.coveredThrough, excludedAfterCoverage: 0 });

  if (!browserAvailable) limits.push(browserReason);
  const registrationsWithVisitor = registrationsAvailable ? registrationSourceRowsScoped.filter(row => !!text(row.origin.visitor, 80)).length : null;
  const registrationsWithSession = registrationsAvailable ? registrationSourceRowsScoped.filter(row => !!text(row.origin.session, 200)).length : null;
  const registrationsWithoutBrowserIdentity = registrationsAvailable ? registrationSourceRowsScoped.filter(row => !text(row.origin.visitor, 80) && !text(row.origin.session, 200)).length : null;
  if (registrationsWithoutBrowserIdentity) limits.push(`${registrationsWithoutBrowserIdentity} inscription${registrationsWithoutBrowserIdentity > 1 ? 's' : ''} confirmée${registrationsWithoutBrowserIdentity > 1 ? 's' : ''} sans visiteur ni session reste${registrationsWithoutBrowserIdentity > 1 ? 'nt' : ''} comptée${registrationsWithoutBrowserIdentity > 1 ? 's' : ''}, sans navigation inventée.`);
  if (!registrationsAvailable) limits.push(registrationState.reason!);
  if (!appointmentsAvailable) limits.push(bookingCountState.reason!);

  const durationValues = [...new Set(browserScoped.map(row => row.durationSeconds).filter((value): value is number => value !== null && value > 0).map(Math.round))];
  const durationState = !browserAvailable ? browserState : durationValues.length === 1 ? available() : unavailable(durationValues.length ? 'Plusieurs durées vidéo mesurées coexistent dans cette sélection.' : "La durée exacte de la vidéo n'est pas mesurée.");
  const watchMeasured = browserAvailable && browserScoped.some(row => row.videoStartAt && row.uniqueWatchedSeconds !== null);
  const thresholdRows = VISUAL_JOURNEY_THRESHOLDS.map(seconds => {
    const thresholdState = watchMeasured ? available() : unavailable("La durée de contenu regardée n'est pas mesurée dans cette sélection.");
    const viewers = thresholdState.available ? browserScoped.filter(row => row.videoStartAt && (row.uniqueWatchedSeconds ?? -1) >= seconds).length : null;
    return { seconds, visitors: viewers, fromStarted: browserRate(thresholdState.available ? rate(viewers, videoStarted.size, 'Aucun démarrage vidéo mesuré.') : { numerator: null, denominator: videoStarted.size || null, rate: null, ...thresholdState }) };
  });
  const finishMeasured = browserAvailable && browserScoped.some(row => row.uniqueWatchedSeconds !== null && row.durationSeconds !== null);
  const finishedState = finishMeasured ? available() : unavailable("La durée de contenu regardée jusqu'à la fin n'est pas mesurée dans cette sélection.");
  const finished = finishMeasured ? browserScoped.filter(row => row.durationSeconds !== null && row.uniqueWatchedSeconds !== null && row.uniqueWatchedSeconds >= row.durationSeconds).length : null;

  const sectionCounts = new Map<string, number>();
  const ctaPlacementCounts = new Map<string, number>();
  for (const browser of browserScoped) for (const section of browser.sections) sectionCounts.set(section, (sectionCounts.get(section) ?? 0) + 1);
  for (const browser of browserScoped) for (const placement of browser.ctaPlacements) ctaPlacementCounts.set(placement, (ctaPlacementCounts.get(placement) ?? 0) + 1);
  const sectionState = browserAvailable ? available() : browserState;
  const sectionRows = browserAvailable ? [...sectionCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id, count]) => ({ id, label: sectionLabel(id), visitors: metric(count, sectionState) })) : [];
  const ctaPlacementRows = browserAvailable ? [...ctaPlacementCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id, count]) => ({ id, label: sectionLabel(id), visitors: metric(count, sectionState) })) : [];

  const stages: VisualJourneyStage[] = [
    { id: 'page', label: 'Visitent la page', count: browserAvailable ? pagePeople.size : null, availability: browserState, fromPrevious: null },
    { id: 'form', label: 'Ouvrent le formulaire', count: browserAvailable ? formOpened.size : null, availability: browserState, fromPrevious: browserRate(browserAvailable ? rate(pageToForm, pagePeople.size, 'Aucun visiteur de page mesuré.') : { numerator: null, denominator: null, rate: null, ...browserState }) },
    { id: 'signup', label: "S'inscrivent", count: registrationState.available ? registrationsScoped.length : null, availability: registrationState, fromPrevious: signupFromOpened },
    { id: 'watch', label: 'Démarrent la vidéo', count: browserAvailable ? videoStarted.size : null, availability: browserState, fromPrevious: videoFromSignup },
    { id: 'call', label: 'Réservent un rendez-vous', count: bookedCount, availability: bookingCountState, fromPrevious: bookingFromVideo },
  ];

  const anyUnavailable = stages.some(stage => !stage.availability.available || (stage.fromPrevious && !stage.fromPrevious.available));
  const empty = stages.every(stage => stage.count === 0 || stage.count === null);
  return {
    status: anyUnavailable ? 'partial' : empty ? 'empty' : 'complete',
    generatedAt: Temporal.Instant.from(input.generatedAt).toString(),
    period: { from: input.from, to: input.to, timezone: 'Europe/Paris' },
    filters: { source: input.source, campaign: input.campaign, includeTests: input.includeTests },
    availableAds: input.availableAds ?? [], stages,
    page: { visitors: metric(browserAvailable ? pagePeople.size : null, browserState), sections: sectionRows, cta: metric(browserAvailable ? browserScoped.filter(row => row.ctaAt).length : null, browserState), ctaPlacements: ctaPlacementRows },
    form: {
      opened: metric(browserAvailable ? formOpened.size : null, browserState), started: metric(browserAvailable ? formStarted.size : null, browserState), registered: metric(registrationsAvailable ? registrationsScoped.length : null, registrationState),
      rates: {
        startedFromOpened: browserRate(browserAvailable ? rate(openToStarted, formOpened.size, 'Aucune ouverture de formulaire mesurée.') : { numerator: null, denominator: null, rate: null, ...browserState }),
        registeredFromStarted: signupFromStarted,
      },
    },
    video: {
      durationSeconds: durationState.available ? durationValues[0] : null, durationAvailability: durationState,
      started: metric(browserAvailable ? videoStarted.size : null, browserState), thresholds: thresholdRows,
      finished: metric(finished, finishedState),
    },
    booking: {
      clicked: metric(browserAvailable ? bookingClicked.size : null, browserState), calendar: metric(browserAvailable ? calendarOpened.size : null, browserState), booked: metric(bookedCount, bookingCountState),
      people: bookingCountState.available ? bookedRegistrations.map(registration => {
        const appointments = [...new Map((appointmentsByPerson.get(registration.personId!) ?? []).filter(activeAppointment).map(row => [row.id, row])).values()]
          .sort((a, b) => compareScheduledDates(a.scheduledAt, b.scheduledAt) || a.id.localeCompare(b.id));
        const ad = input.availableAds?.find(item => item.id === `meta-ad:${registration.originA.ad}`);
        return {
          name: appointments.map(row => text(row.displayName)).find(Boolean) ?? 'Nom non renseigné',
          originLabel: ad?.label ?? (registration.originA.ad ? 'Publicité non renseignée' : registration.originA.source ? 'Source : ' + registration.originA.source : 'Origine non renseignée'),
          appointments: appointments.map(row => ({ id: row.id, bookedAt: row.bookedAt ?? row.bookedDay ?? null, scheduledAt: row.scheduledAt ?? null, status: row.status })),
        };
      }) : [],
      rates: {
        calendarFromClicked: browserRate(browserAvailable ? rate(browserScoped.filter(row => after(row.bookingOpenAt, row.bookingClickAt)).length, bookingClicked.size, 'Aucun clic de réservation mesuré.') : { numerator: null, denominator: null, rate: null, ...browserState }),
        bookedFromCalendar: bookingFromCalendar,
      },
    },
    freshness: input.freshness,
    coverage: {
      browserVisitors: browserAvailable ? browserAll.filter(row => row.visitorId).length : null,
      browserSessions: browserAvailable ? new Set(browserAll.flatMap(row => [...row.sessionIds])).size : null,
      registrations: registrationsAvailable ? registrationSourceRowsScoped.length : null, registrationsWithVisitor, registrationsWithSession, registrationsWithoutBrowserIdentity,
      appointments: appointmentsAvailable ? appointmentRows.length : null, appointmentsLinkedToPerson: appointmentsAvailable ? linkedAppointmentCount : null, testsIncluded: input.includeTests,
    },
    limits: [...new Set(limits)],
  };
}
