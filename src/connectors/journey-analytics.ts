import { Temporal } from '@js-temporal/polyfill';
import { ConnectorError, object, readJson, safeConnectorError } from './http';
import type { PostHogConfig } from './posthog';
import { readPostHogQuery } from './posthog-query';
import type {
  JourneyAvailability,
  JourneyMetric,
  JourneyQuestion,
  JourneyReport,
  JourneySection,
  JourneySource,
  JourneyStep,
  JourneyTunnel,
  JourneyVideoDistribution,
  JourneyVideoReport,
} from '../lib/journey-contract';

export const JOURNEY_ANALYTICS_VERSION = 'posthog-journey-aggregates-v2';
const UNVERSIONED = 'unversioned';
const HOSTS = ['quizz.blg-studio.fr', 'www.blg-studio.fr'] as const;
const MASTERCLASS_HOSTS = ['www.blg-studio.fr', 'blg-studio.fr'] as const;
const MC_PATHS = ['/masterclass26', '/masterclass26/'] as const;
const VIDEO_BUCKET_SECONDS = 15;

const QUIZ_STEPS = [
  ['$pageview', 'page_view', 'Page du quiz vue'],
  ['clic_vers_quiz', 'quiz_click', 'Clic pour commencer'],
  ['quiz_demarre', 'quiz_started', 'Quiz commencé'],
  ['ecran_coordonnees', 'contact_viewed', 'Coordonnées affichées'],
  ['coordonnees_envoyees', 'contact_submitted', 'Coordonnées envoyées'],
  ['resultat_affiche', 'result_viewed', 'Résultat affiché'],
  ['enregistrement_ok', 'saved', 'Enregistrement confirmé'],
  ['lead_wix_confirme', 'lead_confirmed', 'Inscription confirmée par Wix'],
  ['clic_vers_bilan', 'booking_click', 'Clic vers le bilan'],
  ['rendezvous_confirme', 'booking_confirmed', 'Rendez-vous confirmé'],
] as const;

const MASTERCLASS_STEPS = [
  ['mc_page_view', 'page_view', 'Page vue'],
  ['mc_cta_click', 'cta_click', 'Bouton de la page cliqué'],
  ['mc_optin_open', 'optin_open', 'Formulaire ouvert'],
  ['mc_optin_start', 'optin_started', 'Formulaire commencé'],
  ['mc_optin_submit', 'optin_submitted', 'Formulaire envoyé'],
  ['mc_optin_accepted', 'optin_accepted', 'Accès à la vidéo accordé'],
  ['mc_optin_recorded', 'optin_recorded', 'Inscription confirmée'],
  ['mc_video_start', 'video_started', 'Lecture commencée'],
  ['mc_booking_click', 'booking_click', 'Clic vers le bilan'],
  ['mc_booking_open', 'booking_open', 'Calendrier ouvert'],
  ['mc_booking_slot_selected', 'booking_slot_selected', 'Créneau choisi'],
  ['mc_booking_confirmed', 'booking_confirmed', 'Rendez-vous confirmé'],
] as const;

const QUIZ_EVENTS = [
  ...QUIZ_STEPS.map(row => row[0]), 'question_affichee', 'question_repondue',
] as const;
const MASTERCLASS_EVENTS = [
  ...MASTERCLASS_STEPS.map(row => row[0]), 'mc_section_view', 'mc_page_exit',
  'mc_visibility_change', 'mc_optin_close', 'mc_optin_error', 'mc_optin_confirmation_unavailable',
  'mc_video_ready', 'mc_video_resume', 'mc_video_pause', 'mc_video_seek', 'mc_video_rate_change',
  'mc_video_buffer_start', 'mc_video_buffer_end', 'mc_video_progress', 'mc_video_heartbeat',
  'mc_video_end_reached', 'mc_video_error', 'mc_booking_error', 'mc_booking_external_click',
] as const;

export interface JourneyAnalyticsConfig extends PostHogConfig {
  from: string;
  to: string;
  tunnel: JourneyTunnel;
  source: JourneySource;
  campaign: string;
  includeTests: boolean;
  version?: string;
  now?: () => string;
}

type StepAggregate = { version: string; event: string; count: number; paired: number; eligible: number };
type QuestionAggregate = { version: string; number: number; reached: number; answered: number; abandoned: number; reachedEvents: number; answeredEvents: number };
type VideoAggregate = {
  version: string; videoId: string; started: number; bookedAfterStart: number; duration: number | null;
  m25: number; m50: number; m75: number; m100: number;
  uniqueSessions: number; uniqueAverage: number | null; uniqueP50: number | null; uniqueP75: number | null; uniqueP90: number | null;
  visibleSessions: number; visibleAverage: number | null; visibleP50: number | null; visibleP75: number | null; visibleP90: number | null;
};
type CurveAggregate = { version: string; videoId: string; from: number; sessions: number };

const literal = (value: string) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
const property = (key: string) => `coalesce(toString(properties.${key}), '')`;
const url = property('$current_url');
const rawHost = `lower(${property('$host')})`;
const urlHost = `lower(domain(${url}))`;
const host = `coalesce(nullIf(${rawHost}, ''), ${urlHost})`;
const hostConflict = `(${rawHost} != '' AND ${urlHost} != '' AND ${rawHost} != ${urlHost})`;
const session = property('sid');

function safeString(value: string, name: string, allowEmpty = false) {
  if ((!allowEmpty && !value) || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new ConnectorError(`INVALID_${name}`);
}

function dateWindow(from: string, to: string) {
  let first: Temporal.PlainDate, last: Temporal.PlainDate;
  try { first = Temporal.PlainDate.from(from); last = Temporal.PlainDate.from(to); }
  catch { throw new ConnectorError('INVALID_PERIOD'); }
  if (first.toString() !== from || last.toString() !== to || Temporal.PlainDate.compare(first, last) > 0 || first.until(last).total('days') > 366) throw new ConnectorError('INVALID_PERIOD');
  const start = first.toZonedDateTime('Europe/Paris').toInstant();
  const end = last.add({ days: 1 }).toZonedDateTime('Europe/Paris').toInstant();
  return { start, end };
}

function firstTouchDimensions(tunnel: JourneyTunnel) {
  const origin = property('first_origin'), touch = property('first_touch');
  const json = (source: string, key: string) => `JSONExtractString(${source}, '${key}')`;
  const legacy = (key: string) => tunnel === 'quiz' ? property(`premiere_utm_${key}`) : "''";
  const urlParameter = (key: string) => `decodeURLComponent(extractURLParameter(${url}, '${key}'))`;
  const dimension = (key: string) => `coalesce(nullIf(${json(origin, `utm_${key}`)}, ''), nullIf(${json(touch, `utm_${key}`)}, ''), nullIf(${legacy(key)}, ''), nullIf(${property(`utm_${key}`)}, ''), ${urlParameter(`utm_${key}`)}, '')`;
  const medium = `lower(${dimension('medium')})`;
  return {
    source: dimension('source'),
    medium: dimension('medium'),
    campaign: dimension('campaign'),
    ad: dimension('content'),
    link: `coalesce(nullIf(${json(origin, 'link_id')}, ''), nullIf(${json(origin, 'blg_link_id')}, ''), nullIf(${json(touch, 'link_id')}, ''), nullIf(${json(touch, 'blg_link_id')}, ''), ${tunnel === 'quiz' ? `nullIf(${property('premiere_lien')}, ''),` : ''} nullIf(${property('blg_link_id')}, ''), ${urlParameter('blg_link_id')}, '')`,
    sourceClass: `multiIf(${medium} IN ('paid','cpc','ppc','paid_social','paid-search'),'paid',${medium} IN ('organic','social','email','referral','organic_social','organic_video'),'organic','unknown')`,
  };
}

function versionExpression(tunnel: JourneyTunnel) {
  return tunnel === 'masterclass'
    ? `coalesce(nullIf(${property('page_version')}, ''), '${UNVERSIONED}')`
    : `coalesce(nullIf(${property('quiz_version')}, ''), nullIf(${property('page_version')}, ''), '${UNVERSIONED}')`;
}

function explicitTest(first: ReturnType<typeof firstTouchDimensions>) {
  const urlParameter = (key: string) => `decodeURLComponent(extractURLParameter(${url}, '${key}'))`;
  const current = (key: string) => `coalesce(nullIf(${property(key)}, ''), ${urlParameter(key)}, '')`;
  return `(lower(coalesce(nullIf(${property('is_test')}, ''), ${urlParameter('is_test')}, '')) IN ('1','true') OR
    lower(${property('test_traffic')}) IN ('1','true') OR lower(${property('traffic_type')}) = 'test' OR
    match(lower(${property('first_origin')}), '"is_test"[ ]*:[ ]*(true|"true"|"1"|1)') OR match(lower(${property('first_touch')}), '"is_test"[ ]*:[ ]*(true|"true"|"1"|1)') OR
    lower(${first.source}) = 'test' OR lower(${current('utm_source')}) = 'test' OR lower(${current('source')}) = 'test' OR
    lower(${first.medium}) = 'recette' OR lower(${current('utm_medium')}) = 'recette' OR lower(${current('medium')}) = 'recette' OR
    startsWith(lower(${first.campaign}), 'test-mehdi') OR startsWith(lower(${current('utm_campaign')}), 'test-mehdi') OR startsWith(lower(${current('campaign')}), 'test-mehdi'))`;
}

function campaignSelector(value: string, first: ReturnType<typeof firstTouchDimensions>): { expression: string; expected: string } | null {
  if (!value || value === 'all') return null;
  let match: RegExpExecArray | null;
  if ((match = /^meta:(\d{1,30})$/.exec(value))) return { expression: first.campaign, expected: match[1] };
  if ((match = /^meta-ad:(\d{1,30})$/.exec(value))) return { expression: first.ad, expected: match[1] };
  if ((match = /^link:([0-9a-f]{8}-[0-9a-f-]{27})$/i.exec(value))) return { expression: `lower(${first.link})`, expected: match[1].toLowerCase() };
  if (value.startsWith('meta-creative:') || /^[a-z-]+:/.test(value)) throw new ConnectorError('POSTHOG_SCOPE_UNAVAILABLE');
  return { expression: first.campaign, expected: value };
}

function generated(sql: string) {
  if (sql.length > 100_000 || sql.includes(';') || !/^(SELECT|WITH) /.test(sql)) throw new ConnectorError('INVALID_GENERATED_QUERY');
  return sql;
}

/** Closed HogQL templates. Inputs only enter as length-bounded escaped literals. */
export function journeyQueries(config: Pick<JourneyAnalyticsConfig, 'from' | 'to' | 'tunnel' | 'source' | 'campaign' | 'includeTests' | 'version'>) {
  if (!['quiz', 'masterclass'].includes(config.tunnel) || !['all', 'paid', 'organic', 'unknown'].includes(config.source)) throw new ConnectorError('INVALID_JOURNEY_SCOPE');
  safeString(config.campaign, 'CAMPAIGN', true);
  if (config.version !== undefined) safeString(config.version, 'VERSION');
  const { start, end } = dateWindow(config.from, config.to);
  const events = config.tunnel === 'quiz' ? QUIZ_EVENTS : MASTERCLASS_EVENTS;
  const steps = config.tunnel === 'quiz' ? QUIZ_STEPS : MASTERCLASS_STEPS;
  const version = versionExpression(config.tunnel);
  const first = firstTouchDimensions(config.tunnel);
  const test = explicitTest(first);
  const campaign = campaignSelector(config.campaign, first);
  const surface = config.tunnel === 'quiz'
    ? `${host} = ${literal(HOSTS[0])}`
    : `(lower(${property('page_path')}) IN (${MC_PATHS.map(literal).join(', ')}) AND ${property('page_id')} = 'blg-rugby-mc' AND lower(${property('environment')}) = 'production' AND NOT ${hostConflict} AND (${host} = '' OR ${host} IN (${MASTERCLASS_HOSTS.map(literal).join(', ')})))`;
  const time = `timestamp >= fromUnixTimestamp64Milli(${start.epochMilliseconds}) AND timestamp < fromUnixTimestamp64Milli(${end.epochMilliseconds})`;
  const scope = `${time} AND event IN (${events.map(literal).join(', ')}) AND ${surface}`;
  const sessionFilters = [
    ...(config.includeTests ? [] : [`max(if(${test}, 1, 0)) = 0`]),
    ...(config.source === 'all' ? [] : [`if(countIf(${first.medium} != '') > 0, argMinIf(${first.sourceClass}, timestamp, ${first.medium} != ''), 'unknown') = ${literal(config.source)}`]),
    ...(campaign ? [`argMinIf(${campaign.expression}, timestamp, ${campaign.expression} != '') = ${literal(campaign.expected)}`] : []),
  ];
  const scopeCtes = `eligible_sessions AS (SELECT ${session} AS journey_session FROM events WHERE ${scope} AND ${session} != '' GROUP BY journey_session HAVING ${sessionFilters.join(' AND ') || '1 = 1'}),
    test_sessions AS (SELECT ${session} AS journey_session FROM events WHERE ${scope} AND ${session} != '' GROUP BY journey_session HAVING max(if(${test}, 1, 0)) > 0)`;
  const eligible = `(${session} != '' AND ${session} IN (SELECT journey_session FROM eligible_sessions))`;
  const versionFilter = config.version ? `${version} = ${literal(config.version)}` : '1 = 1';
  const selected = `(${eligible} AND ${versionFilter})`;
  const stepTimes = steps.flatMap((step, index) => [
    `minIf(timestamp, event = ${literal(step[0])}) AS first_t${index}`,
    `maxIf(timestamp, event = ${literal(step[0])}) AS last_t${index}`,
  ]).join(',\n');
  const stepUnions = steps.map((step, index) => `SELECT journey_version, ${literal(step[0])} AS step_event, countIf(first_t${index} > toDateTime(0)) AS sessions, ${index === 0 ? `countIf(first_t0 > toDateTime(0))` : `countIf(first_t${index - 1} > toDateTime(0) AND last_t${index} >= first_t${index - 1})`} AS paired_sessions, ${index === 0 ? `countIf(first_t0 > toDateTime(0))` : `countIf(first_t${index - 1} > toDateTime(0))`} AS eligible_sessions FROM per_session GROUP BY journey_version`).join('\nUNION ALL\n');
  const number = `if(match(${property('numero')}, '^([1-9][0-9]?|100)$'), toIntOrZero(${property('numero')}), 0)`;
  const numeric = (key: string) => `if(match(${property(key)}, '^[0-9]+([.][0-9]+)?$'), toFloatOrZero(${property(key)}), 0)`;
  const numericValid = (key: string) => `match(${property(key)}, '^[0-9]+([.][0-9]+)?$')`;
  const position = numeric('position_seconds'), duration = numeric('duration_seconds'), unique = numeric('unique_watched_seconds'), visible = numeric('visible_played_seconds');
  const observedVideo = `(event IN ('mc_video_heartbeat','mc_video_pause','mc_page_exit','mc_video_end_reached') AND ${numericValid('position_seconds')})`;
  return {
    overview: generated(`WITH ${scopeCtes} SELECT count() AS queried_events, countIf(${selected}) AS included_events,
      uniqExactIf(${session}, ${selected} AND ${session} != '') AS included_sessions,
      countIf(${selected} AND ${session} != '') AS events_with_session_id,
      countIf(${session} = '' AND ${versionFilter}) AS events_missing_session_id,
      countIf((${session} IN (SELECT journey_session FROM test_sessions) OR (${session} = '' AND ${test})) AND ${versionFilter}) AS identifiable_test_events,
      uniqExactIf(${session}, ${selected} AND ${session} != '' AND ${version} = '${UNVERSIONED}') AS unversioned_sessions,
      minIf(timestamp, ${selected}) AS first_observed_at, maxIf(timestamp, ${selected}) AS last_observed_at
      FROM events WHERE ${scope} LIMIT 2`),
    steps: generated(`WITH ${scopeCtes}, per_session AS (SELECT ${session} AS journey_session, ${version} AS journey_version, ${stepTimes}
      FROM events WHERE ${scope} AND ${eligible} GROUP BY journey_session, journey_version)
      SELECT * FROM (${stepUnions}) ORDER BY journey_version, step_event LIMIT 2001`),
    questions: generated(`WITH ${scopeCtes}, per_question AS (SELECT ${session} AS journey_session, ${version} AS journey_version, ${number} AS question_number,
      max(event = 'question_affichee') AS reached_flag, max(event = 'question_repondue') AS answered_flag,
      countIf(event = 'question_affichee') AS reached_events, countIf(event = 'question_repondue') AS answered_events
      FROM events WHERE ${scope} AND ${selected} AND event IN ('question_affichee','question_repondue') AND ${number} > 0
      GROUP BY journey_session, journey_version, question_number)
      SELECT journey_version, question_number, countIf(reached_flag > 0) AS reached, countIf(answered_flag > 0) AS answered,
      countIf(reached_flag > 0 AND answered_flag = 0) AS abandoned,
      sum(reached_events) AS reached_events, sum(answered_events) AS answered_events
      FROM per_question GROUP BY journey_version, question_number ORDER BY journey_version, question_number LIMIT 10001`),
    video: generated(`WITH ${scopeCtes}, per_session_video AS (SELECT ${session} AS journey_session, ${version} AS journey_version,
      minIf(timestamp, event = 'mc_video_start') AS started_at,
      maxIf(timestamp, event = 'mc_booking_confirmed') AS last_booked_at,
      maxIf(${duration}, ${duration} > 0) AS duration_seconds,
      maxIf(${unique}, ${unique} > 0) AS unique_seconds, maxIf(${visible}, ${visible} > 0) AS visible_seconds,
      max(event = 'mc_video_progress' AND ${property('milestone')} = '25') AS m25,
      max(event = 'mc_video_progress' AND ${property('milestone')} = '50') AS m50,
      max(event = 'mc_video_progress' AND ${property('milestone')} = '75') AS m75,
      max(event = 'mc_video_progress' AND ${property('milestone')} = '100') AS m100,
      argMinIf(${property('video_id')}, timestamp, startsWith(event, 'mc_video_') AND ${property('video_id')} != '') AS selected_video_id,
      uniqExactIf(${property('video_id')}, startsWith(event, 'mc_video_') AND ${property('video_id')} != '') AS video_id_count,
      countIf(startsWith(event, 'mc_video_')) AS video_event_count
      FROM events WHERE ${scope} AND ${selected} GROUP BY journey_session, journey_version),
      per_video AS (SELECT *, multiIf(video_id_count = 1, selected_video_id, video_id_count > 1, 'multiple', 'unknown') AS video_id FROM per_session_video WHERE video_event_count > 0)
      SELECT journey_version, video_id, countIf(started_at > toDateTime(0)) AS started_sessions,
      countIf(started_at > toDateTime(0) AND last_booked_at >= started_at) AS booked_after_start, max(duration_seconds) AS duration_seconds,
      countIf(m25 > 0) AS m25, countIf(m50 > 0) AS m50, countIf(m75 > 0) AS m75, countIf(m100 > 0) AS m100,
      countIf(unique_seconds > 0) AS unique_sessions, avgIf(unique_seconds, unique_seconds > 0) AS unique_average,
      quantileExact(0.5)(if(unique_seconds > 0, unique_seconds, null)) AS unique_p50,
      quantileExact(0.75)(if(unique_seconds > 0, unique_seconds, null)) AS unique_p75,
      quantileExact(0.9)(if(unique_seconds > 0, unique_seconds, null)) AS unique_p90,
      countIf(visible_seconds > 0) AS visible_sessions, avgIf(visible_seconds, visible_seconds > 0) AS visible_average,
      quantileExact(0.5)(if(visible_seconds > 0, visible_seconds, null)) AS visible_p50,
      quantileExact(0.75)(if(visible_seconds > 0, visible_seconds, null)) AS visible_p75,
      quantileExact(0.9)(if(visible_seconds > 0, visible_seconds, null)) AS visible_p90
      FROM per_video GROUP BY journey_version, video_id ORDER BY journey_version, video_id LIMIT 1001`),
    breakdown: generated(`WITH ${scopeCtes}, per_session_stop AS (SELECT ${session} AS journey_session, ${version} AS journey_version,
      minIf(timestamp, event = 'mc_video_start') AS started_at,
      argMaxIf(${position}, timestamp, ${observedVideo} AND ${position} >= 0) AS last_position,
      countIf(${observedVideo}) AS observations,
      argMinIf(${property('video_id')}, timestamp, startsWith(event, 'mc_video_') AND ${property('video_id')} != '') AS selected_video_id,
      uniqExactIf(${property('video_id')}, startsWith(event, 'mc_video_') AND ${property('video_id')} != '') AS video_id_count
      FROM events WHERE ${scope} AND ${selected} GROUP BY journey_session, journey_version),
      per_stop AS (SELECT *, multiIf(video_id_count = 1, selected_video_id, video_id_count > 1, 'multiple', 'unknown') AS video_id FROM per_session_stop), rows AS (
      SELECT 'stop' AS kind, journey_version, video_id AS item, floor(last_position / ${VIDEO_BUCKET_SECONDS}) * ${VIDEO_BUCKET_SECONDS} AS bucket, count() AS sessions
      FROM per_stop WHERE started_at > toDateTime(0) AND observations > 0 GROUP BY journey_version, video_id, bucket
      UNION ALL
      SELECT 'section' AS kind, ${version} AS journey_version, ${property('section')} AS item, 0 AS bucket, uniqExact(${session}) AS sessions
      FROM events WHERE ${scope} AND ${selected} AND event = 'mc_section_view' AND ${property('section')} != '' GROUP BY journey_version, item)
      SELECT kind AS kind, journey_version AS journey_version, item AS item, bucket AS bucket, sessions AS sessions
      FROM rows ORDER BY kind, journey_version, item, bucket LIMIT 10001`),
  };
}

function integer(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ConnectorError('INVALID_POSTHOG_COUNT');
  return value;
}
function decimal(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new ConnectorError('INVALID_POSTHOG_NUMBER');
  return value;
}
function optionalDecimal(value: unknown, present: number) { return present ? decimal(value) : null; }
function token(value: unknown, code = 'INVALID_POSTHOG_ROW') {
  if (typeof value !== 'string' || !value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new ConnectorError(code);
  return value;
}
function resultRows(payload: unknown, columns: string[], limit: number) {
  const body = object(payload);
  if (body.error || (body.query_status && (object(body.query_status).complete !== true || object(body.query_status).error))) throw new ConnectorError('POSTHOG_QUERY_INCOMPLETE');
  if (JSON.stringify(body.columns) !== JSON.stringify(columns) || !Array.isArray(body.results)) throw new ConnectorError('INVALID_POSTHOG_RESPONSE');
  if (body.hasMore === true || body.results.length >= limit) throw new ConnectorError('POSTHOG_RESULT_LIMIT');
  return body.results.map(row => { if (!Array.isArray(row) || row.length !== columns.length) throw new ConnectorError('INVALID_POSTHOG_ROW'); return row; });
}
const yes = (): JourneyAvailability => ({ available: true, reason: null });
const no = (reason: string): JourneyAvailability => ({ available: false, reason });
const metric = (value: number | null, availability: JourneyAvailability = yes()): JourneyMetric => ({ value, ...availability });
const distribution = (sessions: number, values: Array<number | null>, availability = yes()): JourneyVideoDistribution => ({
  sessions: availability.available ? sessions : null,
  averageSeconds: availability.available ? values[0] : null,
  p50Seconds: availability.available ? values[1] : null,
  p75Seconds: availability.available ? values[2] : null,
  p90Seconds: availability.available ? values[3] : null,
  ...availability,
});

function emptyVideo(tunnel: JourneyTunnel): JourneyVideoReport {
  const unavailable = no(tunnel === 'quiz' ? "Le quiz public ne contient pas la masterclass vidéo." : 'Aucune variante vidéo reçue dans cette sélection.');
  return {
    availability: unavailable, availableVideoVariants: [], selectedVideoId: null,
    durationSeconds: metric(null, unavailable), startedSessions: metric(null, unavailable),
    bookedAfterStart: metric(null, unavailable), milestones: [],
    lastObservedPosition: { availability: unavailable, label: 'Dernière position observée', buckets: [] },
    uniqueContentSeconds: distribution(0, [null, null, null, null], unavailable),
    foregroundPlayedSeconds: distribution(0, [null, null, null, null], unavailable),
    exactUniqueVisibleSeconds: distribution(0, [null, null, null, null], no("Le lecteur public n'émet pas l'union des intervalles visibles.")),
  };
}

function unavailableVideo(tunnel: JourneyTunnel, reason: string): JourneyVideoReport {
  const unavailable = no(reason), output = emptyVideo(tunnel);
  return {
    ...output, availability: unavailable, availableVideoVariants: [], selectedVideoId: null,
    durationSeconds: metric(null, unavailable), startedSessions: metric(null, unavailable), bookedAfterStart: metric(null, unavailable), milestones: [],
    lastObservedPosition: { availability: unavailable, label: 'Dernière position observée', buckets: [] },
    uniqueContentSeconds: distribution(0, [null, null, null, null], unavailable),
    foregroundPlayedSeconds: distribution(0, [null, null, null, null], unavailable),
    exactUniqueVisibleSeconds: distribution(0, [null, null, null, null], unavailable),
  };
}

function initialReport(config: JourneyAnalyticsConfig): JourneyReport {
  return {
    source: 'posthog', connectorVersion: JOURNEY_ANALYTICS_VERSION, status: 'not_configured', observedAt: null,
    scope: { from: config.from, to: config.to, timezone: 'Europe/Paris', tunnel: config.tunnel, source: config.source, campaign: config.campaign, includeTests: config.includeTests, version: config.version ?? null },
    availableVersions: [], steps: [], sections: [], questions: [], video: unavailableVideo(config.tunnel, 'Connexion non configurée.'),
    coverage: { queryComplete: false, queriedEvents: null, includedEvents: null, includedSessions: null, eventsWithSessionIdentity: null, eventsMissingSessionIdentity: null, identifiableTestEvents: null, testsIncluded: config.includeTests, unversionedSessions: null, firstObservedAt: null, lastObservedAt: null, reason: 'Connexion non configurée.' },
    notices: [],
  };
}

function buildSteps(tunnel: JourneyTunnel, aggregates: StepAggregate[], version: string | null, blocked: string | null): JourneyStep[] {
  const definitions = tunnel === 'quiz' ? QUIZ_STEPS : MASTERCLASS_STEPS;
  const selected = version ? aggregates.filter(row => row.version === version) : [];
  return definitions.map((definition, index) => {
    const row = selected.find(candidate => candidate.event === definition[0]);
    const knownMissing = tunnel === 'quiz' && definition[0] === 'clic_vers_bilan' && !row?.count;
    const missingMasterclassSignal = tunnel === 'masterclass' && /^(mc_optin_|mc_video_|mc_booking_)/.test(definition[0]) && !row?.count;
    const availability = blocked ? no(blocked)
      : knownMissing ? no("Le clic vers le bilan n'est pas émis par le quiz public actuel.")
      : missingMasterclassSignal ? no("Aucun signal de cette étape n'a ete reçu dans la sélection ; aucun zéro n'est fabriqué.") : yes();
    const previous = index ? definitions[index - 1] : null;
    const previousStep = previous ? selected.find(candidate => candidate.event === previous[0]) : null;
    const previousMissing = !!previous && ((tunnel === 'quiz' && previous[0] === 'clic_vers_bilan' && !previousStep?.count)
      || (tunnel === 'masterclass' && /^(mc_optin_|mc_video_|mc_booking_)/.test(previous[0]) && !previousStep?.count));
    return {
      id: definition[1], label: definition[2], count: availability.available ? row?.count ?? 0 : null, unit: 'sessions', availability,
      fromPrevious: index === 0 ? null : {
        previousStepId: previous![1], pairedSessions: availability.available && !previousMissing ? row?.paired ?? 0 : null,
        eligibleSessions: availability.available && !previousMissing ? row?.eligible ?? 0 : null,
        rate: availability.available && !previousMissing && (row?.eligible ?? 0) > 0 ? (row?.paired ?? 0) / row!.eligible : null,
        availability: availability.available && !previousMissing ? yes() : no(previousMissing ? "L'étape précédente n'est pas mesurée ; aucune cohorte de reservation n'est déduite." : availability.reason!),
      },
    };
  });
}

function buildQuestions(tunnel: JourneyTunnel, rows: QuestionAggregate[], version: string | null, blocked: string | null): JourneyQuestion[] {
  if (tunnel !== 'quiz' || blocked || !version) return [];
  const selected = rows.filter(row => row.version === version);
  const reachedSignal = selected.some(row => row.reachedEvents > 0);
  return selected.map(row => {
    const reachAvailability = reachedSignal ? yes() : no("Le quiz public actuel n'émet pas question_affichee.");
    const abandonAvailability = reachedSignal ? yes() : no("L'abandon par question est indisponible sans question_affichee.");
    return { number: row.number, reached: metric(reachedSignal ? row.reached : null, reachAvailability), answered: metric(row.answered), abandoned: metric(abandonAvailability.available ? row.abandoned : null, abandonAvailability) };
  });
}

function buildVideo(tunnel: JourneyTunnel, videos: VideoAggregate[], curves: CurveAggregate[], version: string | null, bookingSignalObserved: boolean): JourneyVideoReport {
  if (tunnel === 'quiz') return emptyVideo(tunnel);
  const candidates = videos.filter(row => !version || row.version === version);
  const variants = candidates.map(row => ({ version: row.version, videoId: row.videoId }));
  if (variants.length === 0) return emptyVideo(tunnel);
  if (variants.length !== 1 || ['multiple', 'unknown'].includes(variants[0].videoId)) {
    const reason = variants.length !== 1
      ? 'Plusieurs variantes page/vidéo sont présentes. Choisir une version pour conserver un axe temps cohérent.'
      : variants[0].videoId === 'multiple' ? 'Plusieurs videos sont présentes dans les memes sessions ; aucun axe temps ne les fusionne.'
      : "Les observations vidéo ne portent pas de video_id ; aucun axe temps n'est fabriqué.";
    const unavailable = no(reason), output = emptyVideo(tunnel);
    return { ...output, availability: unavailable, availableVideoVariants: variants, durationSeconds: metric(null, unavailable), startedSessions: metric(null, unavailable), bookedAfterStart: metric(null, unavailable), lastObservedPosition: { availability: unavailable, label: 'Dernière position observée', buckets: [] }, uniqueContentSeconds: distribution(0, [null, null, null, null], unavailable), foregroundPlayedSeconds: distribution(0, [null, null, null, null], unavailable) };
  }
  const row = candidates[0];
  const curve = curves.filter(point => point.version === row.version && point.videoId === row.videoId).map(point => ({ fromSeconds: point.from, toSeconds: point.from + VIDEO_BUCKET_SECONDS, sessions: point.sessions }));
  const noObservations = no("Aucune position vidéo n'a ete reçue sur cette sélection ; cela ne prouve pas une panne du lecteur.");
  const exactUnavailable = no("Le lecteur public n'émet pas l'union des intervalles visibles.");
  const startAvailability = row.started > 0 ? yes() : no("Aucun signal mc_video_start n'a ete reçu ; aucun zéro n'est fabriqué.");
  const bookingAvailability = bookingSignalObserved ? yes() : no("Aucun signal mc_booking_confirmed n'a ete reçu ; aucun zéro n'est fabriqué.");
  return {
    availability: yes(), availableVideoVariants: variants, selectedVideoId: row.videoId,
    durationSeconds: row.duration === null ? metric(null, no("Aucune durée vidéo n'a ete reçue sur cette sélection.")) : metric(row.duration),
    startedSessions: metric(startAvailability.available ? row.started : null, startAvailability),
    bookedAfterStart: metric(startAvailability.available && bookingAvailability.available ? row.bookedAfterStart : null, startAvailability.available ? bookingAvailability : startAvailability),
    milestones: ([25, 50, 75, 100] as const).map((percent, index) => ({ percent, sessions: [row.m25, row.m50, row.m75, row.m100][index] })),
    lastObservedPosition: { availability: curve.length ? yes() : noObservations, label: 'Dernière position observée', buckets: curve },
    uniqueContentSeconds: distribution(row.uniqueSessions, [row.uniqueAverage, row.uniqueP50, row.uniqueP75, row.uniqueP90], row.uniqueSessions ? yes() : noObservations),
    foregroundPlayedSeconds: distribution(row.visibleSessions, [row.visibleAverage, row.visibleP50, row.visibleP75, row.visibleP90], row.visibleSessions ? yes() : noObservations),
    exactUniqueVisibleSeconds: distribution(0, [null, null, null, null], exactUnavailable),
  };
}

export async function readJourneyAnalytics(config: JourneyAnalyticsConfig): Promise<JourneyReport> {
  const report = initialReport(config);
  try { journeyQueries(config); } catch (error) { report.status = 'failed'; report.safeError = safeConnectorError(error); report.coverage.reason = 'Paramètres de lecture invalides.'; return report; }
  if (!config.host || !config.projectId || !config.personalApiKey) return report;
  try {
    const endpoint = new URL(config.host);
    if (!['https://eu.posthog.com', 'https://us.posthog.com', 'https://app.posthog.com'].includes(endpoint.origin) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['', '/'].includes(endpoint.pathname) || !/^\d+$/.test(config.projectId)) throw new ConnectorError('INVALID_CONFIGURATION');
    const headers = { Authorization: `Bearer ${config.personalApiKey}`, 'Content-Type': 'application/json' };
    const started = Date.now();
    const options = () => ({ ...config, attempts: 1, timeoutMs: Math.min(30_000, Math.max(1_000, 55_000 - (Date.now() - started))) });
    const project = object(await readJson(new URL(`/api/projects/${config.projectId}/`, endpoint.origin), { method: 'GET', headers }, options()));
    if (String(project.id) !== config.projectId) throw new ConnectorError('PROJECT_IDENTITY_MISMATCH');
    const queries = journeyQueries(config);
    const controller = new AbortController();
    const query = (name: keyof typeof queries) => readPostHogQuery({
      endpoint, projectId: config.projectId!, headers, query: queries[name], name: `BLG journey aggregate ${name}`,
      deadline: started + 55_000, signal: controller.signal, fetcher: config.fetcher, sleep: config.sleep,
    });
    let overviewPayload: unknown, stepsPayload: unknown, questionsPayload: unknown, videoPayload: unknown, breakdownPayload: unknown;
    try {
      // At most two queries run together; do not request measurements from the other tunnel.
      [overviewPayload, stepsPayload] = await Promise.all([query('overview'), query('steps')]);
      if (config.tunnel === 'quiz') questionsPayload = await query('questions');
      else [videoPayload, breakdownPayload] = await Promise.all([query('video'), query('breakdown')]);
    } finally { controller.abort(); }
    if (Date.now() - started > 60_000) throw new ConnectorError('POSTHOG_TIME_BUDGET');
    const overviewRows = resultRows(overviewPayload, ['queried_events','included_events','included_sessions','events_with_session_id','events_missing_session_id','identifiable_test_events','unversioned_sessions','first_observed_at','last_observed_at'], 2);
    if (overviewRows.length !== 1) throw new ConnectorError('INVALID_POSTHOG_RESPONSE');
    const overview = overviewRows[0];
    const [queriedEvents, includedEvents, includedSessions, withIdentity, withoutIdentity, testEvents, unversionedSessions] = overview.slice(0, 7).map(integer);
    if (withIdentity !== includedEvents || includedSessions > withIdentity || withoutIdentity > queriedEvents || testEvents > queriedEvents) throw new ConnectorError('POSTHOG_TOTALS_CHANGED');
    const instant = (value: unknown) => {
      if (!includedEvents) return null;
      if (typeof value !== 'string') throw new ConnectorError('POSTHOG_DATE_MISMATCH');
      return Temporal.Instant.from(value).toString();
    };
    const firstObservedAt = instant(overview[7]), lastObservedAt = instant(overview[8]);
    const stepRows = resultRows(stepsPayload, ['journey_version','step_event','sessions','paired_sessions','eligible_sessions'], 2001).map(row => ({ version: token(row[0]), event: token(row[1]), count: integer(row[2]), paired: integer(row[3]), eligible: integer(row[4]) }));
    const allowedSteps = new Set((config.tunnel === 'quiz' ? QUIZ_STEPS : MASTERCLASS_STEPS).map(row => row[0]));
    if (stepRows.some(row => !allowedSteps.has(row.event as never) || row.paired > row.eligible || row.paired > row.count)) throw new ConnectorError('INVALID_POSTHOG_ROW');
    report.availableVersions = [...new Set(stepRows.map(row => row.version))].sort();
    if (report.availableVersions.length > 100) throw new ConnectorError('POSTHOG_RESULT_LIMIT');
    const questionRows = (config.tunnel === 'quiz' ? resultRows(questionsPayload, ['journey_version','question_number','reached','answered','abandoned','reached_events','answered_events'], 10001) : []).map(row => ({ version: token(row[0]), number: integer(row[1]), reached: integer(row[2]), answered: integer(row[3]), abandoned: integer(row[4]), reachedEvents: integer(row[5]), answeredEvents: integer(row[6]) }));
    if (questionRows.some(row => row.number < 1 || row.number > 100 || row.reached > row.reachedEvents || row.answered > row.answeredEvents || row.abandoned > row.reached)) throw new ConnectorError('INVALID_POSTHOG_ROW');
    const videoRows = (config.tunnel === 'masterclass' ? resultRows(videoPayload, ['journey_version','video_id','started_sessions','booked_after_start','duration_seconds','m25','m50','m75','m100','unique_sessions','unique_average','unique_p50','unique_p75','unique_p90','visible_sessions','visible_average','visible_p50','visible_p75','visible_p90'], 1001) : []).map(row => {
      const started = integer(row[2]), uniqueSessions = integer(row[9]), visibleSessions = integer(row[14]);
      const durationValue = decimal(row[4]);
      return { version: token(row[0]), videoId: token(row[1]), started, bookedAfterStart: integer(row[3]), duration: durationValue > 0 ? durationValue : null, m25: integer(row[5]), m50: integer(row[6]), m75: integer(row[7]), m100: integer(row[8]), uniqueSessions, uniqueAverage: optionalDecimal(row[10], uniqueSessions), uniqueP50: optionalDecimal(row[11], uniqueSessions), uniqueP75: optionalDecimal(row[12], uniqueSessions), uniqueP90: optionalDecimal(row[13], uniqueSessions), visibleSessions, visibleAverage: optionalDecimal(row[15], visibleSessions), visibleP50: optionalDecimal(row[16], visibleSessions), visibleP75: optionalDecimal(row[17], visibleSessions), visibleP90: optionalDecimal(row[18], visibleSessions) };
    });
    if (videoRows.some(row => row.bookedAfterStart > row.started || [row.m25,row.m50,row.m75,row.m100,row.uniqueSessions,row.visibleSessions].some(value => value > includedSessions))) throw new ConnectorError('POSTHOG_TOTALS_CHANGED');
    const breakdownRows = config.tunnel === 'masterclass' ? resultRows(breakdownPayload, ['kind','journey_version','item','bucket','sessions'], 10001) : [];
    const curves: CurveAggregate[] = [], sections: Array<JourneySection & { version: string }> = [];
    for (const row of breakdownRows) {
      const kind = token(row[0]), version = token(row[1]), item = token(row[2]), bucket = decimal(row[3]), sessions = integer(row[4]);
      if (kind === 'stop') curves.push({ version, videoId: item, from: bucket, sessions });
      else if (kind === 'section') sections.push({ version, id: item, label: item.replaceAll(/[-_]+/g, ' '), sessions });
      else throw new ConnectorError('INVALID_POSTHOG_ROW');
    }
    const effectiveVersion = config.version ?? (report.availableVersions.length === 1 ? report.availableVersions[0] : null);
    const versionBlock = !config.version && report.availableVersions.length > 1 ? 'Plusieurs versions sont présentes. Choisir une version pour ne pas mélanger leurs parcours.' : null;
    const identityBlock = includedSessions === 0
      ? (includedEvents > 0 || withoutIdentity > 0
        ? "Les événements reçus ne portent pas de sid ; les comptes et conversions par session sont indisponibles."
        : "Aucune session instrumentee n'est disponible dans cette sélection ; aucun zéro d'étape n'est publie.")
      : null;
    report.steps = buildSteps(config.tunnel, stepRows, effectiveVersion, versionBlock ?? identityBlock);
    report.questions = buildQuestions(config.tunnel, questionRows, effectiveVersion, versionBlock ?? identityBlock);
    report.sections = effectiveVersion && !versionBlock && !identityBlock ? sections.filter(row => row.version === effectiveVersion).map(({ version: _version, ...row }) => row) : [];
    const bookingSignalObserved = !!effectiveVersion && !!stepRows.find(row => row.version === effectiveVersion && row.event === 'mc_booking_confirmed' && row.count > 0);
    report.video = identityBlock ? unavailableVideo(config.tunnel, identityBlock) : buildVideo(config.tunnel, videoRows, curves, effectiveVersion, bookingSignalObserved);
    report.observedAt = Temporal.Instant.from(config.now?.() ?? new Date().toISOString()).toString();
    report.status = includedEvents ? 'complete' : 'empty';
    report.coverage = { queryComplete: true, queriedEvents, includedEvents, includedSessions, eventsWithSessionIdentity: withIdentity, eventsMissingSessionIdentity: withoutIdentity, identifiableTestEvents: testEvents, testsIncluded: config.includeTests, unversionedSessions, firstObservedAt, lastObservedAt, reason: withoutIdentity ? "Lecture complète, mais certains événements sans sid sont exclus des enchainements." : 'Lecture agrégée complète pour les événements mesurés reçus.' };
    if (versionBlock) report.notices.push(versionBlock);
    if (identityBlock) report.notices.push(identityBlock);
    if (!config.includeTests && testEvents) report.notices.push(`${testEvents} événements explicitement marqués comme tests ont été exclus.`);
    if (config.tunnel === 'quiz' && !questionRows.some(row => row.reachedEvents)) report.notices.push("question_affichee n'est pas émis par le quiz public actuel : aucun zéro ni abandon n'est fabriqué.");
    if (config.tunnel === 'masterclass' && !videoRows.some(row => row.started)) report.notices.push("Aucun démarrage vidéo n'a ete reçu dans cette sélection ; cela ne prouve pas que le lecteur est cassé.");
    report.notices.push('Les volumes sont des sessions mesurées, pas des personnes CRM.');
    return report;
  } catch (error) {
    report.status = 'failed'; report.safeError = safeConnectorError(error); report.coverage.reason = 'Les données de parcours n’ont pas pu être chargées. Cela ne signifie pas qu’il n’y a eu aucune visite.';
    report.steps = []; report.sections = []; report.questions = []; report.video = unavailableVideo(config.tunnel, 'Les données n’ont pas pu être chargées.');
    return report;
  }
}

/** Daily booking-session measures use the same production, origin and explicit-test rules as Parcours. */
export function kpiBookingQuery(from: string, to: string) {
 const { start, end } = dateWindow(from, to), first = firstTouchDimensions('masterclass');
 const surface = `(lower(${property('page_path')}) IN (${MC_PATHS.map(literal).join(', ')}) AND ${property('page_id')} = 'blg-rugby-mc' AND lower(${property('environment')}) = 'production' AND NOT ${hostConflict} AND (${host} = '' OR ${host} IN (${MASTERCLASS_HOSTS.map(literal).join(', ')})))`;
 const measures = [ ['mc_booking_click','click'], ['mc_booking_confirmed','confirmed'] ];
 const perSession = `SELECT ${session} AS sid, minIf(timestamp,event='mc_booking_click') AS click_at, minIf(timestamp,event='mc_booking_confirmed') AS confirmed_at,
  argMinIf(${first.ad},timestamp,${first.ad}!='') AS ad, argMinIf(${first.campaign},timestamp,${first.campaign}!='') AS campaign,
  argMinIf(${first.source},timestamp,${first.source}!='') AS source, argMinIf(${first.medium},timestamp,${first.medium}!='') AS medium,
  argMinIf(${first.link},timestamp,${first.link}!='') AS link, max(if(${explicitTest(first)},1,0)) AS is_test
  FROM events WHERE timestamp >= fromUnixTimestamp64Milli(${start.epochMilliseconds}) AND timestamp < fromUnixTimestamp64Milli(${end.epochMilliseconds})
  AND event LIKE 'mc_%' AND ${surface} AND ${session}!='' GROUP BY sid`;
 return `WITH sessions AS (${perSession}) ${measures.map(([,kind])=>`SELECT formatDateTime(${kind}_at,'%Y-%m-%d','Europe/Paris') AS day, '${kind}' AS kind, ad, campaign, source, medium, link, is_test, count() AS sessions FROM sessions WHERE ${kind}_at > toDateTime(0) GROUP BY day,ad,campaign,source,medium,link,is_test`).join(' UNION ALL ')} LIMIT 10001`;
}
