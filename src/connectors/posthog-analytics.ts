import { Temporal } from '@js-temporal/polyfill';
import { ConnectorError, object, readJson, safeConnectorError } from './http';
import type { PostHogConfig } from './posthog';

/** Embedded, aggregate-only use of Query; never EventsQuery or raw exports.
 * https://posthog.com/docs/api/queries
 * https://posthog.com/docs/api/property-definitions
 * https://posthog.com/docs/sql/aggregations
 * Reviewed technical quiz property: numero = question index + 1, not an answer.
 */
export const POSTHOG_ANALYTICS_VERSION = 'posthog-production-aggregates-v1';
export const POSTHOG_PRODUCTION_HOSTS = ['quizz.blg-studio.fr', 'www.blg-studio.fr'] as const;
export const POSTHOG_JOURNEY_EVENTS = ['$pageview', 'quiz_demarre', 'question_repondue', 'ecran_coordonnees', 'resultat_affiche', 'coordonnees_envoyees', 'calendrier_affiche', 'enregistrement_ok', 'clic_vers_quiz', 'video_lancee', 'rendezvous_confirme'] as const;
type EventName = typeof POSTHOG_JOURNEY_EVENTS[number];
export type ProductionHost = typeof POSTHOG_PRODUCTION_HOSTS[number];
export interface PostHogAggregateCounts {
  events: number;
  /** Exact distinct_id counts, NOT CRM people. Never add across days/events. */
  visitors: number | null;
  /** Exact SDK $session_id counts. No inferred/fallback session identities. */
  sessions: number | null;
  eventsWithVisitorId: number;
  eventsWithSessionId: number;
}
export interface PostHogDailyAggregate extends PostHogAggregateCounts { day: string; event: EventName; host: ProductionHost }
export interface PostHogEventAggregate extends PostHogAggregateCounts { event: EventName }
export interface PostHogHostEventAggregate extends PostHogEventAggregate { host: ProductionHost }
export interface PostHogQuestionAggregate extends PostHogAggregateCounts { questionNumber: number | null }
export interface PostHogAnalyticsConfig extends PostHogConfig { from: string; to: string; now?: () => string }
export interface PostHogAnalyticsReport {
  source: 'posthog'; connectorVersion: string; projectId: string; from: string; to: string; timezone: 'Europe/Paris'; observedAt: string | null;
  status: 'not_configured' | 'complete' | 'empty' | 'partial' | 'failed'; safeError?: string;
  overview: PostHogAggregateCounts | null; daily: PostHogDailyAggregate[]; byEvent: PostHogEventAggregate[]; byHostEvent: PostHogHostEventAggregate[]; questions: PostHogQuestionAggregate[];
  schema: { sessionIdAvailable: boolean; questionNumberProperty: 'numero' | null };
  coverage: { queryComplete: boolean; allTrafficComplete: false; firstObservedAt: string | null; lastObservedAt: string | null;
    observedTrackedEvents: number | null; excludedHostEvents: number | null; missingHostEvents: number | null; conflictingHostEvents: number | null;
    identifiableTestEvents: number | null; reason: string };
  semantics: { visitorIdentity: 'distinct_id'; sessionIdentity: '$session_id'; verifiedBackendLeads: false; sequentialFunnel: false };
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const eventList = POSTHOG_JOURNEY_EVENTS.map(literal).join(', ');
const hostList = POSTHOG_PRODUCTION_HOSTS.map(literal).join(', ');
const rawHost = "lower(coalesce(toString(properties.$host), ''))";
const url = "coalesce(toString(properties.$current_url), '')";
const urlHost = `lower(domain(${url}))`;
const host = `coalesce(nullIf(${rawHost}, ''), ${urlHost})`;
const hostConflict = `(${rawHost} != '' AND ${urlHost} != '' AND ${rawHost} != ${urlHost})`;
const production = `(${host} IN (${hostList}) AND NOT ${hostConflict})`;
// Identifiable test traffic only. Missing environment is not evidence of a test.
const testTraffic = `(lower(coalesce(toString(properties.environment), '')) IN ('test', 'testing', 'development', 'dev', 'staging', 'preview', 'local', 'sandbox') OR
  match(lower(path(${url})), '(^|[-_/])(test|tests|preview|staging|sandbox|debug|e2e)([-_/]|$)') OR
  lower(extractURLParameter(${url}, 'test')) IN ('1', 'true') OR lower(extractURLParameter(${url}, 'blg_test')) IN ('1', 'true') OR
  lower(extractURLParameter(${url}, 'test_mode')) IN ('1', 'true') OR lower(extractURLParameter(${url}, 'debug')) IN ('1', 'true'))`;
const eligible = `(${production} AND NOT ${testTraffic})`;
const visitor = "coalesce(toString(distinct_id), '')";
const session = "coalesce(toString(properties.$session_id), '')";
const question = "if(match(coalesce(toString(properties.numero), ''), '^([1-9][0-9]?|100)$'), toIntOrZero(toString(properties.numero)), 0)";
const countColumns = ['events', 'visitors', 'sessions', 'events_with_visitor_id', 'events_with_session_id'];

function aggregateSql(sessionAvailable: boolean, condition = '1 = 1') {
  const sessionCondition = sessionAvailable ? `(${condition} AND ${session} != '')` : '1 = 0';
  return `countIf(${condition}) AS events,
    uniqExactIf(${visitor}, ${condition} AND ${visitor} != '') AS visitors,
    ${sessionAvailable ? `uniqExactIf(${session}, ${sessionCondition})` : '0'} AS sessions,
    countIf(${condition} AND ${visitor} != '') AS events_with_visitor_id,
    countIf(${sessionCondition}) AS events_with_session_id`;
}

/** Closed query templates. No user-supplied SQL/property/event/host names. */
export function postHogAggregateQueries(from: string, to: string, schema: PostHogAnalyticsReport['schema']) {
  const first = Temporal.Instant.from(from), last = Temporal.Instant.from(to);
  if (Temporal.Instant.compare(first, last) >= 0 || last.epochMilliseconds - first.epochMilliseconds > 367 * 86_400_000 ||
    [first, last].some(date => date.toZonedDateTimeISO('Europe/Paris').toPlainTime().toString() !== '00:00:00')) throw new ConnectorError('INVALID_PERIOD');
  const interval = `timestamp >= fromUnixTimestamp64Milli(${first.epochMilliseconds}) AND timestamp < fromUnixTimestamp64Milli(${last.epochMilliseconds}) AND event IN (${eventList})`;
  const where = `FROM events WHERE ${interval} AND ${eligible}`;
  return {
    overview: `SELECT ${aggregateSql(schema.sessionIdAvailable, eligible)}, count() AS observed_tracked_events,
      countIf(${host} = '') AS missing_host_events,
      countIf(${hostConflict}) AS conflicting_host_events,
      countIf(${host} != '' AND NOT ${hostConflict} AND ${host} NOT IN (${hostList})) AS excluded_host_events,
      countIf(${production} AND ${testTraffic}) AS identifiable_test_events,
      minIf(timestamp, ${eligible}) AS first_observed_at, maxIf(timestamp, ${eligible}) AS last_observed_at
      FROM events WHERE ${interval} LIMIT 2`,
    byEvent: `SELECT event, ${aggregateSql(schema.sessionIdAvailable)} ${where} GROUP BY event ORDER BY event LIMIT 12`,
    byHostEvent: `SELECT ${host} AS host, event, ${aggregateSql(schema.sessionIdAvailable)} ${where} GROUP BY host, event ORDER BY host, event LIMIT 23`,
    daily: `SELECT toString(toDate(toTimeZone(timestamp, 'Europe/Paris'))) AS day, event, ${host} AS host,
      ${aggregateSql(schema.sessionIdAvailable)} ${where} GROUP BY day, event, host ORDER BY day, event, host LIMIT 10000`,
    questions: schema.questionNumberProperty ? `SELECT ${question} AS question_number, ${aggregateSql(schema.sessionIdAvailable)}
      ${where} AND event = 'question_repondue' GROUP BY question_number ORDER BY question_number LIMIT 102` : null,
  };
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ConnectorError('INVALID_POSTHOG_COUNT');
  return value;
}
function counts(values: unknown[], sessionAvailable: boolean): PostHogAggregateCounts {
  if (values.length !== 5) throw new ConnectorError('INVALID_POSTHOG_ROW');
  const [events, visitors, sessions, eventsWithVisitorId, eventsWithSessionId] = values.map(count);
  if (visitors > eventsWithVisitorId || eventsWithVisitorId > events || sessions > eventsWithSessionId || eventsWithSessionId > events ||
    (!sessionAvailable && (sessions || eventsWithSessionId)) || (eventsWithVisitorId > 0 && visitors === 0) || (eventsWithSessionId > 0 && sessions === 0)) throw new ConnectorError('INVALID_POSTHOG_COUNT');
  return { events, visitors: events > 0 && !eventsWithVisitorId ? null : visitors, sessions: !sessionAvailable || (events > 0 && !eventsWithSessionId) ? null : sessions, eventsWithVisitorId, eventsWithSessionId };
}
function eventName(value: unknown): EventName {
  if (!POSTHOG_JOURNEY_EVENTS.includes(value as EventName)) throw new ConnectorError('UNEXPECTED_POSTHOG_EVENT');
  return value as EventName;
}
function rows(payload: unknown, columns: string[], limit: number): unknown[][] {
  const body = object(payload);
  if (body.error || (body.query_status && (object(body.query_status).complete !== true || object(body.query_status).error))) throw new ConnectorError('POSTHOG_QUERY_INCOMPLETE');
  if (JSON.stringify(body.columns) !== JSON.stringify(columns) || !Array.isArray(body.results)) throw new ConnectorError('INVALID_POSTHOG_RESPONSE');
  if (body.hasMore === true || body.results.length >= limit) throw new ConnectorError('POSTHOG_RESULT_LIMIT');
  return body.results.map(value => { if (!Array.isArray(value) || value.length !== columns.length) throw new ConnectorError('INVALID_POSTHOG_ROW'); return value; });
}
function sum(rows: readonly PostHogAggregateCounts[], key: 'events' | 'eventsWithVisitorId' | 'eventsWithSessionId'): bigint {
  return rows.reduce((total, row) => total + BigInt(row[key]), 0n);
}
function reconcile(total: PostHogAggregateCounts, children: readonly PostHogAggregateCounts[]) {
  for (const key of ['events', 'eventsWithVisitorId', 'eventsWithSessionId'] as const) if (sum(children, key) !== BigInt(total[key])) throw new ConnectorError('POSTHOG_TOTALS_CHANGED');
  for (const key of ['visitors', 'sessions'] as const) {
    const available = children.map(row => row[key]).filter((value): value is number => value !== null);
    if (total[key] !== null && available.length && (Math.max(...available) > total[key]! || available.reduce((acc, value) => acc + BigInt(value), 0n) < BigInt(total[key]!))) throw new ConnectorError('POSTHOG_DISTINCT_COUNTS_MISMATCH');
  }
}

export async function readPostHogAnalytics(config: PostHogAnalyticsConfig): Promise<PostHogAnalyticsReport> {
  const report: PostHogAnalyticsReport = { source: 'posthog', connectorVersion: POSTHOG_ANALYTICS_VERSION, projectId: config.projectId ?? '', from: config.from, to: config.to, timezone: 'Europe/Paris', observedAt: null,
    status: 'not_configured', overview: null, daily: [], byEvent: [], byHostEvent: [], questions: [], schema: { sessionIdAvailable: false, questionNumberProperty: null },
    coverage: { queryComplete: false, allTrafficComplete: false, firstObservedAt: null, lastObservedAt: null, observedTrackedEvents: null, excludedHostEvents: null, missingHostEvents: null, conflictingHostEvents: null, identifiableTestEvents: null, reason: 'Connexion non configurée.' },
    semantics: { visitorIdentity: 'distinct_id', sessionIdentity: '$session_id', verifiedBackendLeads: false, sequentialFunnel: false } };
  if (!config.host || !config.projectId || !config.personalApiKey) return report;
  try {
    const endpoint = new URL(config.host);
    if (!['https://eu.posthog.com', 'https://us.posthog.com', 'https://app.posthog.com'].includes(endpoint.origin) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['', '/'].includes(endpoint.pathname) || !/^\d+$/.test(config.projectId)) throw new ConnectorError('INVALID_CONFIGURATION');
    report.observedAt = Temporal.Instant.from(config.now?.() ?? new Date().toISOString()).toString();
    postHogAggregateQueries(config.from, config.to, report.schema);
    const headers = { Authorization: `Bearer ${config.personalApiKey}`, 'Content-Type': 'application/json' };
    const project = object(await readJson(new URL(`/api/projects/${config.projectId}/`, endpoint.origin), { method: 'GET', headers }, config));
    if (String(project.id) !== config.projectId) throw new ConnectorError('PROJECT_IDENTITY_MISMATCH');
    const definitions = new Map<string, { type: unknown; numerical: unknown }>(); let offset = 0, completed = false;
    for (let page = 0; page < 10; page++) {
      const url = new URL(`/api/projects/${config.projectId}/property_definitions/`, endpoint.origin);
      url.search = new URLSearchParams({ type: 'event', limit: '100', offset: String(offset) }).toString();
      const payload = object(await readJson(url, { method: 'GET', headers }, config));
      if (!Array.isArray(payload.results) || payload.results.length > 100 || (payload.next && !payload.results.length)) throw new ConnectorError('INVALID_POSTHOG_SCHEMA');
      for (const raw of payload.results) {
        const row = object(raw);
        if (typeof row.name !== 'string' || definitions.has(row.name)) throw new ConnectorError('POSTHOG_SCHEMA_PAGINATION_CHANGED');
        definitions.set(row.name, { type: row.property_type, numerical: row.is_numerical });
      }
      if (!payload.next) { completed = true; break; }
      // Follow only our fixed endpoint/offset, never the upstream next URL.
      offset += payload.results.length;
    }
    if (!completed) throw new ConnectorError('POSTHOG_SCHEMA_PAGE_LIMIT');
    if (definitions.get('$host')?.type !== 'String' || definitions.get('$current_url')?.type !== 'String') throw new ConnectorError('POSTHOG_HOST_SCHEMA_MISSING');
    report.schema.sessionIdAvailable = definitions.get('$session_id')?.type === 'String';
    report.schema.questionNumberProperty = definitions.get('numero')?.type === 'Numeric' && definitions.get('numero')?.numerical === true ? 'numero' : null;
    const queries = postHogAggregateQueries(config.from, config.to, report.schema);
    const query = async (name: keyof typeof queries, columns: string[], limit: number) => rows(await readJson(new URL(`/api/projects/${config.projectId}/query/`, endpoint.origin), {
      method: 'POST', headers, body: JSON.stringify({ query: { kind: 'HogQLQuery', query: queries[name] }, refresh: 'force_blocking', name: `BLG production aggregate ${name}` }),
    }, { ...config, timeoutMs: 60_000 }), columns, limit);
    const overviewRows = await query('overview', [...countColumns, 'observed_tracked_events', 'missing_host_events', 'conflicting_host_events', 'excluded_host_events', 'identifiable_test_events', 'first_observed_at', 'last_observed_at'], 2);
    if (overviewRows.length !== 1) throw new ConnectorError('INVALID_POSTHOG_RESPONSE');
    const overview = overviewRows[0]; report.overview = counts(overview.slice(0, 5), report.schema.sessionIdAvailable);
    const [observed, missing, conflict, excluded, tests] = overview.slice(5, 10).map(count);
    if (BigInt(report.overview.events) + BigInt(missing) + BigInt(conflict) + BigInt(excluded) + BigInt(tests) !== BigInt(observed)) throw new ConnectorError('POSTHOG_HOST_COVERAGE_MISMATCH');
    Object.assign(report.coverage, { observedTrackedEvents: observed, missingHostEvents: missing, conflictingHostEvents: conflict, excludedHostEvents: excluded, identifiableTestEvents: tests });
    if (report.overview.events) {
      for (const value of overview.slice(10, 12)) {
        if (typeof value !== 'string' || Temporal.Instant.compare(value, config.from) < 0 || Temporal.Instant.compare(value, config.to) >= 0) throw new ConnectorError('POSTHOG_DATE_MISMATCH');
      }
      report.coverage.firstObservedAt = Temporal.Instant.from(String(overview[10])).toString(); report.coverage.lastObservedAt = Temporal.Instant.from(String(overview[11])).toString();
    }
    report.byEvent = (await query('byEvent', ['event', ...countColumns], 12)).map(row => ({ event: eventName(row[0]), ...counts(row.slice(1), report.schema.sessionIdAvailable) }));
    report.byHostEvent = (await query('byHostEvent', ['host', 'event', ...countColumns], 23)).map(row => {
      if (!POSTHOG_PRODUCTION_HOSTS.includes(row[0] as ProductionHost)) throw new ConnectorError('POSTHOG_SCOPE_MISMATCH');
      return { host: row[0] as ProductionHost, event: eventName(row[1]), ...counts(row.slice(2), report.schema.sessionIdAvailable) };
    });
    report.daily = (await query('daily', ['day', 'event', 'host', ...countColumns], 10000)).map(row => {
      if (typeof row[0] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row[0]) || !POSTHOG_PRODUCTION_HOSTS.includes(row[2] as ProductionHost)) throw new ConnectorError('POSTHOG_SCOPE_MISMATCH');
      const start = Temporal.PlainDate.from(row[0]).toZonedDateTime('Europe/Paris').toInstant();
      if (Temporal.Instant.compare(start, config.from) < 0 || Temporal.Instant.compare(start, config.to) >= 0) throw new ConnectorError('POSTHOG_DATE_MISMATCH');
      return { day: row[0], event: eventName(row[1]), host: row[2] as ProductionHost, ...counts(row.slice(3), report.schema.sessionIdAvailable) };
    });
    if (new Set(report.byEvent.map(r => r.event)).size !== report.byEvent.length || new Set(report.byHostEvent.map(r => JSON.stringify([r.host, r.event]))).size !== report.byHostEvent.length || new Set(report.daily.map(r => JSON.stringify([r.day, r.event, r.host]))).size !== report.daily.length) throw new ConnectorError('DUPLICATE_POSTHOG_AGGREGATE');
    reconcile(report.overview, report.byEvent); reconcile(report.overview, report.byHostEvent); reconcile(report.overview, report.daily);
    for (const event of report.byEvent) {
      reconcile(event, report.daily.filter(row => row.event === event.event));
      reconcile(event, report.byHostEvent.filter(row => row.event === event.event));
    }
    for (const hostEvent of report.byHostEvent) reconcile(hostEvent, report.daily.filter(row => row.event === hostEvent.event && row.host === hostEvent.host));
    if (queries.questions) {
      report.questions = (await query('questions', ['question_number', ...countColumns], 102)).map(row => {
        const number = count(row[0]); if (number > 100) throw new ConnectorError('INVALID_POSTHOG_QUESTION');
        return { questionNumber: number || null, ...counts(row.slice(1), report.schema.sessionIdAvailable) };
      });
      if (new Set(report.questions.map(r => r.questionNumber)).size !== report.questions.length) throw new ConnectorError('DUPLICATE_POSTHOG_AGGREGATE');
      const total = report.byEvent.find(row => row.event === 'question_repondue');
      if (total) reconcile(total, report.questions); else if (report.questions.length) throw new ConnectorError('POSTHOG_TOTALS_CHANGED');
    }
    report.coverage.queryComplete = true;
    report.coverage.reason = 'Événements capturés sur les hôtes autorisés, hors tests identifiables. Couverture du trafic réel non démontrée ; visiteurs PostHog distincts des personnes CRM. Les comptes par étape ne prouvent pas un parcours séquentiel.';
    report.status = report.overview.events ? 'complete' : 'empty';
    return report;
  } catch (error) {
    report.status = report.overview ? 'partial' : 'failed'; report.safeError = safeConnectorError(error);
    report.coverage.reason = 'Lecture agrégée incomplète ; ne pas publier de métrique canonique à partir de ce résultat.';
    return report;
  }
}
