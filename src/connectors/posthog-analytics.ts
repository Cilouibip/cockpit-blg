import { createHash } from 'node:crypto';
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
export type ProductionHost = string;
export interface PostHogDimensionScope {source:'all'|'paid'|'organic'|'unknown';campaignId:string|null}
export const POSTHOG_DEFAULT_SCOPE:PostHogDimensionScope={source:'all',campaignId:null};
export interface PostHogClientProfile {quizHost:string;productionHosts:readonly string[];masterclassPageId:string}
export const POSTHOG_DEFAULT_CLIENT:PostHogClientProfile={quizHost:'quizz.blg-studio.fr',productionHosts:POSTHOG_PRODUCTION_HOSTS,masterclassPageId:'blg-rugby-mc'};
export function postHogClientProfile(env:Record<string,string|undefined>=process.env):PostHogClientProfile {
 const quizHost=env.POSTHOG_QUIZ_HOST??POSTHOG_DEFAULT_CLIENT.quizHost;
 const productionHosts=env.POSTHOG_PRODUCTION_HOSTS?env.POSTHOG_PRODUCTION_HOSTS.split(',').map(x=>x.trim()):POSTHOG_DEFAULT_CLIENT.productionHosts;
 const masterclassPageId=env.POSTHOG_MASTERCLASS_PAGE_ID??POSTHOG_DEFAULT_CLIENT.masterclassPageId;
 if(!productionHosts.length||productionHosts.length>10||!productionHosts.includes(quizHost)||productionHosts.some(x=>!/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(x))||!/^[A-Za-z0-9_.-]{1,100}$/.test(masterclassPageId))throw new ConnectorError('INVALID_POSTHOG_CLIENT');
 return {quizHost,productionHosts,masterclassPageId};
}
export function postHogScopeProfile(scope:PostHogDimensionScope=POSTHOG_DEFAULT_SCOPE,client:PostHogClientProfile=POSTHOG_DEFAULT_CLIENT){
 if(!['all','paid','organic','unknown'].includes(scope.source)||(scope.campaignId!==null&&!/^\d{1,30}$/.test(scope.campaignId)))throw new ConnectorError('INVALID_POSTHOG_SCOPE');
 const base=scope.source==='all'&&!scope.campaignId?POSTHOG_ANALYTICS_VERSION:`${POSTHOG_ANALYTICS_VERSION}:${scope.source}:${scope.campaignId??'all'}`;
 return JSON.stringify(client)===JSON.stringify(POSTHOG_DEFAULT_CLIENT)?base:`${base}:client-${createHash('sha256').update(JSON.stringify(client)).digest('hex').slice(0,16)}`;
}
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
export interface PostHogAnalyticsConfig extends PostHogConfig { from: string; to: string; now?: () => string; scope?:PostHogDimensionScope;client?:PostHogClientProfile }
export interface PostHogAnalyticsReport {
  source: 'posthog'; connectorVersion: string; projectId: string; from: string; to: string; timezone: 'Europe/Paris'; observedAt: string | null;
  status: 'not_configured' | 'complete' | 'empty' | 'partial' | 'failed'; safeError?: string;
  overview: PostHogAggregateCounts | null; daily: PostHogDailyAggregate[]; byEvent: PostHogEventAggregate[]; byHostEvent: PostHogHostEventAggregate[]; questions: PostHogQuestionAggregate[];
  schema: { sessionIdAvailable: boolean; questionNumberProperty: 'numero' | null };
  coverage: { queryComplete: boolean; allTrafficComplete: false; firstObservedAt: string | null; lastObservedAt: string | null;
    observedTrackedEvents: number | null; excludedHostEvents: number | null; missingHostEvents: number | null; conflictingHostEvents: number | null;
    identifiableTestEvents: number | null; reason: string };
  semantics: { visitorIdentity: 'distinct_id'; sessionIdentity: '$session_id'; verifiedBackendLeads: false; sequentialFunnel: false };
  scope?:PostHogDimensionScope;client?:PostHogClientProfile;
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const eventList = POSTHOG_JOURNEY_EVENTS.map(literal).join(', ');
const rawHost = "lower(coalesce(toString(properties.$host), ''))";
const url = "coalesce(toString(properties.$current_url), '')";
const urlHost = `lower(domain(${url}))`;
const host = `coalesce(nullIf(${rawHost}, ''), ${urlHost})`;
const hostConflict = `(${rawHost} != '' AND ${urlHost} != '' AND ${rawHost} != ${urlHost})`;
// Identifiable test traffic only. Missing environment is not evidence of a test.
const testTraffic = `(lower(coalesce(toString(properties.environment), '')) IN ('test', 'testing', 'development', 'dev', 'staging', 'preview', 'local', 'sandbox') OR
  match(lower(path(${url})), '(^|[-_/])(test|tests|preview|staging|sandbox|debug|e2e)([-_/]|$)') OR
  lower(extractURLParameter(${url}, 'test')) IN ('1', 'true') OR lower(extractURLParameter(${url}, 'blg_test')) IN ('1', 'true') OR
  lower(extractURLParameter(${url}, 'test_mode')) IN ('1', 'true') OR lower(extractURLParameter(${url}, 'debug')) IN ('1', 'true'))`;
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
export function postHogAggregateQueries(from: string, to: string, schema: PostHogAnalyticsReport['schema'],scope:PostHogDimensionScope=POSTHOG_DEFAULT_SCOPE,client:PostHogClientProfile=POSTHOG_DEFAULT_CLIENT) {
  const first = Temporal.Instant.from(from), last = Temporal.Instant.from(to);
  if (Temporal.Instant.compare(first, last) >= 0 || last.epochMilliseconds - first.epochMilliseconds > 367 * 86_400_000 ||
    [first, last].some(date => date.toZonedDateTimeISO('Europe/Paris').toPlainTime().toString() !== '00:00:00')) throw new ConnectorError('INVALID_PERIOD');
  postHogScopeProfile(scope,client);
  if(!client.productionHosts.length||client.productionHosts.some(x=>!/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(x)))throw new ConnectorError('INVALID_POSTHOG_CLIENT');
  const production=`(${host} IN (${client.productionHosts.map(literal).join(', ')}) AND NOT ${hostConflict})`;
  const eligible=`(${production} AND NOT ${testTraffic})`;
  const medium="lower(coalesce(toString(properties.utm_medium), ''))";
  const sourceClass=`multiIf(${medium} IN ('paid','cpc','ppc','paid_social','paid-search'),'paid',${medium} IN ('organic','social','email','referral'),'organic','unknown')`;
  const scopeFilter=(scope.source==='all'?'':` AND ${sourceClass} = ${literal(scope.source)}`)+(scope.campaignId?` AND coalesce(toString(properties.utm_campaign),'') = ${literal(scope.campaignId)}`:'');
  const interval = `timestamp >= fromUnixTimestamp64Milli(${first.epochMilliseconds}) AND timestamp < fromUnixTimestamp64Milli(${last.epochMilliseconds}) AND event IN (${eventList})${scopeFilter}`;
  const where = `FROM events WHERE ${interval} AND ${eligible}`;
  return {
    overview: `SELECT ${aggregateSql(schema.sessionIdAvailable, eligible)}, count() AS observed_tracked_events,
      countIf(${host} = '') AS missing_host_events,
      countIf(${hostConflict}) AS conflicting_host_events,
      countIf(${host} != '' AND NOT ${hostConflict} AND ${host} NOT IN (${client.productionHosts.map(literal).join(', ')})) AS excluded_host_events,
      countIf(${production} AND ${testTraffic}) AS identifiable_test_events,
      minIf(timestamp, ${eligible}) AS first_observed_at, maxIf(timestamp, ${eligible}) AS last_observed_at
      FROM events WHERE ${interval} LIMIT 2`,
    byEvent: `SELECT event, ${aggregateSql(schema.sessionIdAvailable)} ${where} GROUP BY event ORDER BY event LIMIT 12`,
    byHostEvent: `SELECT ${host} AS host, event, ${aggregateSql(schema.sessionIdAvailable)} ${where} GROUP BY host, event ORDER BY host, event LIMIT ${client.productionHosts.length*POSTHOG_JOURNEY_EVENTS.length+1}`,
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
    const scope=config.scope??POSTHOG_DEFAULT_SCOPE,client=config.client??POSTHOG_DEFAULT_CLIENT;
    report.scope=scope;report.client=client;report.connectorVersion=postHogScopeProfile(scope,client);
    postHogAggregateQueries(config.from, config.to, report.schema,scope,client);
    const deadline=Date.now()+45_000;
    const requestOptions=()=>{const remaining=deadline-Date.now();if(remaining<1_000)throw new ConnectorError('POSTHOG_TIME_BUDGET');return {...config,attempts:1,timeoutMs:Math.min(20_000,remaining)};};
    const headers = { Authorization: `Bearer ${config.personalApiKey}`, 'Content-Type': 'application/json' };
    const project = object(await readJson(new URL(`/api/projects/${config.projectId}/`, endpoint.origin), { method: 'GET', headers }, requestOptions()));
    if (String(project.id) !== config.projectId) throw new ConnectorError('PROJECT_IDENTITY_MISMATCH');
    const definitions = new Map<string, { type: unknown; numerical: unknown }>(); let offset = 0, completed = false;
    for (let page = 0; page < 10; page++) {
      const url = new URL(`/api/projects/${config.projectId}/property_definitions/`, endpoint.origin);
      url.search = new URLSearchParams({ type: 'event', limit: '100', offset: String(offset) }).toString();
      const payload = object(await readJson(url, { method: 'GET', headers }, requestOptions()));
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
    const queries = postHogAggregateQueries(config.from, config.to, report.schema,scope,client);
    const query = async (name: keyof typeof queries, columns: string[], limit: number) => rows(await readJson(new URL(`/api/projects/${config.projectId}/query/`, endpoint.origin), {
      method: 'POST', headers, body: JSON.stringify({ query: { kind: 'HogQLQuery', query: queries[name] }, refresh: 'force_blocking', name: `BLG production aggregate ${name}` }),
    }, requestOptions()), columns, limit);
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
    const [eventRows,hostRows,dailyRows,questionRows]=await Promise.all([
      query('byEvent',['event',...countColumns],12),
      query('byHostEvent',['host','event',...countColumns],client.productionHosts.length*POSTHOG_JOURNEY_EVENTS.length+1),
      query('daily',['day','event','host',...countColumns],10000),
      queries.questions?query('questions',['question_number',...countColumns],102):Promise.resolve([]),
    ]);
    report.byEvent = eventRows.map(row => ({ event: eventName(row[0]), ...counts(row.slice(1), report.schema.sessionIdAvailable) }));
    report.byHostEvent = hostRows.map(row => {
      if (!client.productionHosts.includes(row[0] as ProductionHost)) throw new ConnectorError('POSTHOG_SCOPE_MISMATCH');
      return { host: row[0] as ProductionHost, event: eventName(row[1]), ...counts(row.slice(2), report.schema.sessionIdAvailable) };
    });
    report.daily = dailyRows.map(row => {
      if (typeof row[0] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row[0]) || !client.productionHosts.includes(row[2] as ProductionHost)) throw new ConnectorError('POSTHOG_SCOPE_MISMATCH');
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
      report.questions = questionRows.map(row => {
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

export const POSTHOG_MASTERCLASS_VERSION='posthog-masterclass-observations-v1';
export const POSTHOG_MASTERCLASS_EVENTS=['mc_page_view','mc_page_exit','mc_visibility_change','mc_optin_recorded','mc_video_start','mc_video_progress','mc_video_heartbeat','mc_booking_confirmed'] as const;
export type MasterclassObservation={event:typeof POSTHOG_MASTERCLASS_EVENTS[number];events:number;visitors:number|null;kitSessions:number|null;eventsWithVisitorId:number;eventsWithKitSessionId:number;verifiedHostEvents:number;unlocatedEvents:number;excludedEvents:number};
export interface PostHogMasterclassReport {
 source:'posthog';profile:string;from:string;to:string;observedAt:string|null;status:'not_configured'|'complete'|'empty'|'failed';safeError?:string;
 byEvent:MasterclassObservation[];coverage:{queryComplete:boolean;hostVerified:boolean;reason:string};
}
export function postHogMasterclassProfile(client:PostHogClientProfile=POSTHOG_DEFAULT_CLIENT){return `${POSTHOG_MASTERCLASS_VERSION}:${createHash('sha256').update(JSON.stringify(client)).digest('hex').slice(0,16)}`;}
/** Kit observations stay separate from production-host traffic and SDK sessions. */
export function postHogMasterclassQuery(from:string,to:string,client:PostHogClientProfile=POSTHOG_DEFAULT_CLIENT){
 postHogAggregateQueries(from,to,{sessionIdAvailable:false,questionNumberProperty:null},POSTHOG_DEFAULT_SCOPE,client);
 if(!/^[A-Za-z0-9_.-]{1,100}$/.test(client.masterclassPageId))throw new ConnectorError('INVALID_POSTHOG_CLIENT');
 const allowed=client.productionHosts.filter(x=>x!==client.quizHost),knownHost=allowed.length?`(${host} IN (${allowed.map(literal).join(', ')}) AND NOT ${hostConflict} AND NOT ${testTraffic})`:'1 = 0';
 const kitSession="coalesce(toString(properties.sid), '')",unlocated=`(${host} = '')`;
 return `SELECT event, count() AS events, uniqExactIf(${visitor}, ${visitor} != '') AS visitors,
 uniqExactIf(${kitSession}, ${kitSession} != '') AS kit_sessions,
 countIf(${visitor} != '') AS events_with_visitor_id, countIf(${kitSession} != '') AS events_with_kit_session_id,
 countIf(${knownHost}) AS verified_host_events, countIf(${unlocated}) AS unlocated_events,
 countIf(NOT (${knownHost}) AND NOT ${unlocated}) AS excluded_events
 FROM events WHERE timestamp >= fromUnixTimestamp64Milli(${Temporal.Instant.from(from).epochMilliseconds})
 AND timestamp < fromUnixTimestamp64Milli(${Temporal.Instant.from(to).epochMilliseconds})
 AND event IN (${POSTHOG_MASTERCLASS_EVENTS.map(literal).join(', ')})
 AND coalesce(toString(properties.page_id), '') = ${literal(client.masterclassPageId)}
 AND lower(coalesce(toString(properties.environment), '')) = 'production'
 GROUP BY event ORDER BY event LIMIT ${POSTHOG_MASTERCLASS_EVENTS.length+1}`;
}
export async function readPostHogMasterclassAnalytics(config:PostHogAnalyticsConfig):Promise<PostHogMasterclassReport>{
 const client=config.client??POSTHOG_DEFAULT_CLIENT;
 const report:PostHogMasterclassReport={source:'posthog',profile:postHogMasterclassProfile(client),from:config.from,to:config.to,observedAt:null,status:'not_configured',byEvent:[],coverage:{queryComplete:false,hostVerified:false,reason:'Connexion non configurée.'}};
 if(!config.host||!config.projectId||!config.personalApiKey)return report;
 try {
  const endpoint=new URL(config.host);
  if(!['https://eu.posthog.com','https://us.posthog.com','https://app.posthog.com'].includes(endpoint.origin)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!['','/'].includes(endpoint.pathname)||!/^\d+$/.test(config.projectId))throw new ConnectorError('INVALID_CONFIGURATION');
  if(config.scope&&(config.scope.source!=='all'||config.scope.campaignId))throw new ConnectorError('POSTHOG_SCOPE_UNAVAILABLE');
  const sql=postHogMasterclassQuery(config.from,config.to,client),headers={Authorization:`Bearer ${config.personalApiKey}`,'Content-Type':'application/json'};
  const options={...config,attempts:1,timeoutMs:20_000};
  const project=object(await readJson(new URL(`/api/projects/${config.projectId}/`,endpoint.origin),{method:'GET',headers},options));
  if(String(project.id)!==config.projectId)throw new ConnectorError('PROJECT_IDENTITY_MISMATCH');
  const result=await readJson(new URL(`/api/projects/${config.projectId}/query/`,endpoint.origin),{method:'POST',headers,body:JSON.stringify({query:{kind:'HogQLQuery',query:sql},refresh:'force_blocking',name:'Masterclass aggregate observations'})},options);
  report.byEvent=rows(result,['event','events','visitors','kit_sessions','events_with_visitor_id','events_with_kit_session_id','verified_host_events','unlocated_events','excluded_events'],POSTHOG_MASTERCLASS_EVENTS.length+1).map(row=>{
   if(!POSTHOG_MASTERCLASS_EVENTS.includes(row[0] as MasterclassObservation['event']))throw new ConnectorError('UNEXPECTED_POSTHOG_EVENT');
   const c=counts(row.slice(1,6),true),[verifiedHostEvents,unlocatedEvents,excludedEvents]=row.slice(6).map(count);
   if(verifiedHostEvents+unlocatedEvents+excludedEvents!==c.events)throw new ConnectorError('POSTHOG_HOST_COVERAGE_MISMATCH');
   return {event:row[0] as MasterclassObservation['event'],events:c.events,visitors:c.visitors,kitSessions:c.sessions,eventsWithVisitorId:c.eventsWithVisitorId,eventsWithKitSessionId:c.eventsWithSessionId,verifiedHostEvents,unlocatedEvents,excludedEvents};
  });
  if(new Set(report.byEvent.map(r=>r.event)).size!==report.byEvent.length)throw new ConnectorError('DUPLICATE_POSTHOG_AGGREGATE');
  report.observedAt=Temporal.Instant.from(config.now?.()??new Date().toISOString()).toString();
  report.status=report.byEvent.some(r=>r.events)?'complete':'empty';
  report.coverage={queryComplete:true,hostVerified:report.byEvent.length>0&&report.byEvent.every(r=>r.events===r.verifiedHostEvents),reason:'Observations du kit sur la période entière. page_id et environment ne prouvent pas une URL de production ; sid est une session du kit, distincte de la session SDK. Aucun enregistrement métier ni durée vidéo ne se déduit de ces comptes.'};
 }catch(error){report.status='failed';report.byEvent=[];report.safeError=safeConnectorError(error);report.coverage.reason='Lecture masterclass incomplète.';}
 return report;
}
