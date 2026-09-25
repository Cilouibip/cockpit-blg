import { Temporal } from '@js-temporal/polyfill';
import type { Database, Row, TableName } from '../lib/db';
import type { SourceFilter } from '../lib/ui-contract';
import { EXCLUDED_TEST_SESSION_IDS, isExcludedTestTraffic } from '../lib/traffic-scope';
import type { VisualJourneyPostHogTiming, VisualJourneyQueryOutcome, VisualJourneyReport } from '../lib/visual-journey-contract';
import {
  buildVisualJourneyReport,
  VISUAL_JOURNEY_FORM_ID,
  type VisualJourneyAppointmentRow,
  type VisualJourneyBrowserRow,
  type VisualJourneyRegistrationRow,
} from '../lib/visual-journey-report';
import { ConnectorError, object, safeConnectorError } from './http';
import type { PostHogConfig } from './posthog';
import { readPostHogQuery, PostHogQueryPending } from './posthog-query';
import type { VisualJourneyContinuation } from '../lib/visual-journey-resume';
import { appointmentBooking, appointmentOutcome, isEffectiveAppointment } from '../lib/appointment-semantics';
import { connectionFreshness } from '../lib/sync-freshness';
import { jobScope, type SyncJob } from '../lib/sync-jobs';
import { canonicalRegistrationOrigins } from '../lib/ad-funnel';
import { reconcileAcquisitionPeople } from '../lib/results-acquisition';
import { wixLeadEntryConfig } from './wix-lead-entries';

export const VISUAL_JOURNEY_ANALYTICS_VERSION = 'visual-journey-read-v1';
const EVENTS = [
  'mc_page_view', 'mc_cta_click', 'mc_section_view', 'mc_optin_open', 'mc_optin_start',
  'mc_video_start', 'mc_video_heartbeat', 'mc_video_pause', 'mc_page_exit', 'mc_video_end_reached',
  'mc_booking_click', 'mc_booking_open',
] as const;
const HOSTS = ['www.blg-studio.fr', 'blg-studio.fr'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface VisualJourneyAnalyticsConfig extends PostHogConfig {
  from: string;
  to: string;
  source: SourceFilter;
  campaign: string;
  includeTests: boolean;
  wixSiteId?: string;
  syncEnv?: NodeJS.ProcessEnv;
  now?: () => string;
  resumeBrowser?: VisualJourneyContinuation;
  onBrowserContinuation?: (state: VisualJourneyContinuation) => void;
  /** Receives one line of durations and statuses per read. Defaults to console.info. */
  log?: (line: string) => void;
}

const QUERY_KINDS = ['identity', 'overview'] as const;
type QueryKind = typeof QUERY_KINDS[number];

const literal = (value: string) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
const property = (key: string) => `coalesce(toString(properties.${key}), '')`;
const json = (source: string, key: string) => `JSONExtractString(${source}, '${key}')`;
const first = property('first_origin'), touch = property('first_touch');
const firstDimension = (key: string, fallback: string) => `coalesce(nullIf(${json(first, key)}, ''), nullIf(${json(first, `utm_${key}`)}, ''), nullIf(${json(touch, key)}, ''), nullIf(${json(touch, `utm_${key}`)}, ''), nullIf(${property(fallback)}, ''), '')`;
const firstSource = firstDimension('source', 'utm_source');
const firstMedium = firstDimension('medium', 'utm_medium');
const firstCampaign = firstDimension('campaign', 'utm_campaign');
const firstAd = `coalesce(nullIf(${json(first, 'ad')}, ''), nullIf(${json(first, 'utm_content')}, ''), nullIf(${json(touch, 'ad')}, ''), nullIf(${json(touch, 'utm_content')}, ''), nullIf(${property('utm_content')}, ''), '')`;
const firstLink = `coalesce(nullIf(${json(first, 'linkId')}, ''), nullIf(${json(first, 'link_id')}, ''), nullIf(${json(first, 'blg_link_id')}, ''), nullIf(${json(touch, 'linkId')}, ''), nullIf(${json(touch, 'link_id')}, ''), nullIf(${json(touch, 'blg_link_id')}, ''), nullIf(${property('blg_link_id')}, ''), '')`;
const browser = `coalesce(toString(distinct_id), '')`, visitor = `lower(${property('visitor_id')})`, session = property('sid');
const currentUrl = property('$current_url'), rawHost = `lower(${property('$host')})`, urlHost = `lower(domain(${currentUrl}))`;
const host = `coalesce(nullIf(${rawHost}, ''), ${urlHost})`;
const test = `(lower(coalesce(nullIf(${property('is_test')}, ''), extractURLParameter(${currentUrl}, 'is_test'), '')) IN ('1','true') OR lower(${session}) IN (${EXCLUDED_TEST_SESSION_IDS.map(literal).join(', ')}) OR lower(${property('test_traffic')}) IN ('1','true') OR lower(${property('traffic_type')}) = 'test' OR lower(${firstSource}) = 'test' OR lower(${firstMedium}) = 'recette' OR startsWith(lower(${firstCampaign}), 'test-mehdi'))`;
const numeric = (key: string) => `if(match(${property(key)}, '^[0-9]+([.][0-9]+)?$'), toFloatOrZero(${property(key)}), 0)`;
const numericValid = (key: string) => `match(${property(key)}, '^[0-9]+([.][0-9]+)?$')`;

function dateWindow(from: string, to: string) {
  let firstDay: Temporal.PlainDate, lastDay: Temporal.PlainDate;
  try { firstDay = Temporal.PlainDate.from(from); lastDay = Temporal.PlainDate.from(to); } catch { throw new ConnectorError('INVALID_PERIOD'); }
  if (firstDay.toString() !== from || lastDay.toString() !== to || Temporal.PlainDate.compare(firstDay, lastDay) > 0 || firstDay.until(lastDay).total('days') > 366) throw new ConnectorError('INVALID_PERIOD');
  return { start: firstDay.toZonedDateTime('Europe/Paris').toInstant(), end: lastDay.add({ days: 1 }).toZonedDateTime('Europe/Paris').toInstant() };
}

function safeFilter(value: string) {
  if (value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new ConnectorError('INVALID_JOURNEY_SCOPE');
}

export function visualJourneyQueries(config: Pick<VisualJourneyAnalyticsConfig, 'from' | 'to'>) {
  const { start, end } = dateWindow(config.from, config.to);
  const scope = `timestamp >= fromUnixTimestamp64Milli(${start.epochMilliseconds}) AND timestamp < fromUnixTimestamp64Milli(${end.epochMilliseconds}) AND event IN (${EVENTS.map(literal).join(', ')}) AND lower(${property('page_path')}) IN ('/masterclass26','/masterclass26/') AND ${property('page_id')} = 'blg-rugby-mc' AND lower(${property('environment')}) = 'production' AND (${host} = '' OR ${host} IN (${HOSTS.map(literal).join(', ')}))`;
  const minEvent = (name: string) => `nullIf(minIf(timestamp, event = '${name}'), toDateTime(0))`;
  const unique = numeric('unique_watched_seconds'), duration = numeric('duration_seconds');
  const identity = `SELECT ${browser} AS browser_id, ${visitor} AS visitor_id, ${session} AS sid, min(timestamp) AS first_seen_at, max(timestamp) AS last_seen_at,
    argMinIf(${firstSource}, timestamp, ${firstSource} != '') AS first_source,
    argMinIf(${firstMedium}, timestamp, ${firstMedium} != '') AS first_medium,
    argMinIf(${firstCampaign}, timestamp, ${firstCampaign} != '') AS first_campaign,
    argMinIf(${firstAd}, timestamp, ${firstAd} != '') AS first_ad,
    argMinIf(${firstLink}, timestamp, ${firstLink} != '') AS first_link,
    max(if(${test}, 1, 0)) AS is_test,
    ${minEvent('mc_page_view')} AS page_at, ${minEvent('mc_cta_click')} AS cta_at,
    ${minEvent('mc_optin_open')} AS form_open_at, ${minEvent('mc_optin_start')} AS form_start_at,
    ${minEvent('mc_video_start')} AS video_start_at, ${minEvent('mc_booking_click')} AS booking_click_at,
    ${minEvent('mc_booking_open')} AS booking_open_at,
    maxIf(${unique}, ${numericValid('unique_watched_seconds')}) AS unique_seconds,
    countIf(${numericValid('unique_watched_seconds')}) AS unique_observations,
    maxIf(${duration}, ${numericValid('duration_seconds')} AND ${duration} > 0) AS duration_seconds,
    countIf(${numericValid('duration_seconds')} AND ${duration} > 0) AS duration_observations,
    ${minEvent('mc_video_end_reached')} AS finished_at,
    groupUniqArrayIf(${property('section')}, event = 'mc_section_view' AND ${property('section')} != '') AS sections,
    groupUniqArrayIf(${property('placement')}, event = 'mc_cta_click' AND ${property('placement')} != '') AS cta_placements
    FROM events WHERE ${scope} AND (${browser} != '' OR ${visitor} != '' OR ${session} != '') GROUP BY browser_id, visitor_id, sid ORDER BY browser_id, visitor_id, sid LIMIT 20001`;
  const overview = `SELECT count() AS queried_events, countIf(${browser} = '' AND ${visitor} = '' AND ${session} = '') AS missing_identity_events, min(timestamp) AS first_observed_at, max(timestamp) AS last_observed_at FROM events WHERE ${scope} LIMIT 2`;
  if ([identity, overview].some(query => query.length > 100_000 || query.includes(';') || !query.startsWith('SELECT '))) throw new ConnectorError('INVALID_GENERATED_QUERY');
  return { identity, overview };
}

function integer(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ConnectorError('INVALID_POSTHOG_COUNT');
  return value;
}
function number(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new ConnectorError('INVALID_POSTHOG_NUMBER');
  return value;
}
function optionalText(value: unknown, max = 200) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new ConnectorError('INVALID_POSTHOG_ROW');
  return value;
}
function resultRows(payload: unknown, columns: string[], limit: number) {
  const body = object(payload);
  if (body.error || (body.query_status && (object(body.query_status).complete !== true || object(body.query_status).error))) throw new ConnectorError('POSTHOG_QUERY_INCOMPLETE');
  if (JSON.stringify(body.columns) !== JSON.stringify(columns) || !Array.isArray(body.results) || body.hasMore === true || body.results.length >= limit) throw new ConnectorError('INVALID_POSTHOG_RESPONSE');
  return body.results.map(row => { if (!Array.isArray(row) || row.length !== columns.length) throw new ConnectorError('INVALID_POSTHOG_ROW'); return row; });
}
function postHogInstant(value: unknown, required: boolean) {
  if (!required && (value === null || value === '1970-01-01T00:00:00Z')) return null;
  if (typeof value !== 'string') throw new ConnectorError('INVALID_POSTHOG_ROW');
  try { return Temporal.Instant.from(value).toString(); } catch { throw new ConnectorError('INVALID_POSTHOG_ROW'); }
}

/** PostHog `is_cached` / `last_refresh` (https://posthog.com/docs/api/queries). A cached
 * result was computed at `last_refresh`, not at this read. */
function cacheState(payload: unknown, at: number, generatedAt: string) {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const cached = typeof body.is_cached === 'boolean' ? body.is_cached : null;
  let computedAt: string | null = generatedAt;
  if (cached) {
    try { computedAt = typeof body.last_refresh === 'string' ? Temporal.Instant.from(body.last_refresh).toString() : null; } catch { computedAt = null; }
  }
  return { cached, cacheAgeMs: cached && computedAt ? Math.max(0, at - Date.parse(computedAt)) : null, computedAt };
}

async function readBrowser(config: VisualJourneyAnalyticsConfig, generatedAt: string, timing: VisualJourneyPostHogTiming) {
  if (!config.host || !config.projectId || !config.personalApiKey) {
    timing.outcome = 'not_configured';
    return { rows: null, error: 'Connexion PostHog non configurée.', firstObservedAt: null, lastObservedAt: null } as const;
  }
  const endpoint = new URL(config.host);
  if (!['https://eu.posthog.com', 'https://us.posthog.com', 'https://app.posthog.com'].includes(endpoint.origin) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['', '/'].includes(endpoint.pathname) || !/^\d+$/.test(config.projectId)) throw new ConnectorError('INVALID_CONFIGURATION');
  const headers = { Authorization: `Bearer ${config.personalApiKey}`, 'Content-Type': 'application/json' };
  const queries = visualJourneyQueries(config), controller = new AbortController(), deadline = Date.now() + (config.onBrowserContinuation ? 20_000 : 55_000);
  const continuations: VisualJourneyContinuation = { ...config.resumeBrowser };
  // Elapsed time counts from the initial submission carried by the continuation,
  // so a resumed read reports the full wait, not only this HTTP call.
  const callStartedAt = Date.now();
  const submittedAt = (kind: QueryKind) => {
    const value = config.resumeBrowser?.[kind]?.startedAt;
    return typeof value === 'number' && Number.isSafeInteger(value) && value <= callStartedAt ? value : callStartedAt;
  };
  const measured = {} as NonNullable<VisualJourneyPostHogTiming['queries']>;
  const computedAt: (string | null)[] = [];
  const settle = (kind: QueryKind, outcome: VisualJourneyQueryOutcome, payload?: unknown) => {
    const at = Date.now(), cache = outcome === 'complete' ? cacheState(payload, at, generatedAt) : { cached: null, cacheAgeMs: null, computedAt: null };
    if (outcome === 'complete') computedAt.push(cache.computedAt);
    measured[kind] = { outcome, elapsedMs: Math.max(0, at - submittedAt(kind)), cached: cache.cached, cacheAgeMs: cache.cacheAgeMs };
  };
  try {
    const results = await Promise.allSettled(QUERY_KINDS.map(kind => readPostHogQuery({
      endpoint, projectId: config.projectId!, headers, query: queries[kind], name: kind === 'identity' ? 'BLG visual journey identities' : 'BLG visual journey coverage', deadline, signal: controller.signal, fetcher: config.fetcher, sleep: config.sleep,
      // Same text for the same period: a reopening or a retry is served from PostHog's recent cache.
      refresh: 'async',
      ...(config.onBrowserContinuation ? {resumable:true,resume:config.resumeBrowser?.[kind],onContinuation:(value:NonNullable<VisualJourneyContinuation[typeof kind]>)=>{continuations[kind]=value;}} : {}),
    }).then(payload => { settle(kind, 'complete', payload); return payload; }, error => { settle(kind, error instanceof PostHogQueryPending ? 'pending' : 'failed'); throw error; })));
    const outcomes = QUERY_KINDS.map(kind => measured[kind].outcome);
    Object.assign(timing, {
      outcome: outcomes.includes('failed') ? 'failed' : outcomes.includes('pending') ? 'pending' : 'complete',
      elapsedMs: Math.max(0, Date.now() - Math.min(...QUERY_KINDS.map(submittedAt))), queries: measured,
    } satisfies Partial<VisualJourneyPostHogTiming>);
    const failures=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected');
    const hardFailure=failures.find(result=>!(result.reason instanceof PostHogQueryPending));
    if(hardFailure)throw hardFailure.reason;
    if(failures.length){
      // A result served from PostHog's cache has no background job to poll by ID:
      // the next call submits it again with `async` and is served from the cache again.
      for(const kind of QUERY_KINDS)if(measured[kind].cached===true)delete continuations[kind];
      config.onBrowserContinuation?.(continuations);return {rows:null,error:'La lecture des visites et de la vidéo est en cours.',pending:true,firstObservedAt:null,lastObservedAt:null};
    }
    const [identityPayload,overviewPayload]=results.map(result=>(result as PromiseFulfilledResult<unknown>).value);
    const identityColumns = ['browser_id','visitor_id','sid','first_seen_at','last_seen_at','first_source','first_medium','first_campaign','first_ad','first_link','is_test','page_at','cta_at','form_open_at','form_start_at','video_start_at','booking_click_at','booking_open_at','unique_seconds','unique_observations','duration_seconds','duration_observations','finished_at','sections','cta_placements'];
    const rows: VisualJourneyBrowserRow[] = resultRows(identityPayload, identityColumns, 20001).map(row => {
      const uniqueObservations = integer(row[19]), durationObservations = integer(row[21]);
      const sections = row[23];
      const ctaPlacements = row[24];
      if (!Array.isArray(sections) || sections.some(value => !optionalText(value)) || !Array.isArray(ctaPlacements) || ctaPlacements.some(value => !optionalText(value))) throw new ConnectorError('INVALID_POSTHOG_ROW');
      const browserId = optionalText(row[0]), rawVisitorId = optionalText(row[1]), visitorId = rawVisitorId && UUID.test(rawVisitorId) ? rawVisitorId.toLowerCase() : null, sessionId = optionalText(row[2]);
      if (!browserId && !visitorId && !sessionId) throw new ConnectorError('INVALID_POSTHOG_ROW');
      return {
        browserId, visitorId, sessionId, firstSeenAt: postHogInstant(row[3], true)!, lastSeenAt: postHogInstant(row[4], true)!,
        origin: { source: optionalText(row[5], 80), medium: optionalText(row[6], 80), campaign: optionalText(row[7]), ad: optionalText(row[8], 80), linkId: optionalText(row[9], 80) },
        explicitTest: integer(row[10]) > 0,
        pageAt: postHogInstant(row[11], false), ctaAt: postHogInstant(row[12], false), formOpenAt: postHogInstant(row[13], false), formStartAt: postHogInstant(row[14], false),
        videoStartAt: postHogInstant(row[15], false), bookingClickAt: postHogInstant(row[16], false), bookingOpenAt: postHogInstant(row[17], false),
        uniqueWatchedSeconds: uniqueObservations ? number(row[18]) : null, durationSeconds: durationObservations ? number(row[20]) : null,
        finishedAt: postHogInstant(row[22], false), sections: sections as string[], ctaPlacements: ctaPlacements as string[],
      };
    });
    const overview = resultRows(overviewPayload, ['queried_events','missing_identity_events','first_observed_at','last_observed_at'], 2);
    if (overview.length !== 1) throw new ConnectorError('INVALID_POSTHOG_RESPONSE');
    const queried = integer(overview[0][0]), missing = integer(overview[0][1]);
    if (missing > queried) throw new ConnectorError('INVALID_POSTHOG_COUNT');
    // A cached result is as old as its oldest computation; unknown stays unknown.
    const observedAt = computedAt.includes(null) ? null : (computedAt as string[]).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? generatedAt;
    return { rows, error: missing ? `${missing} événement${missing > 1 ? 's' : ''} sans visiteur ni session ${missing > 1 ? 'sont exclus' : 'est exclu'} des cohortes.` : null, observedAt, firstObservedAt: queried ? postHogInstant(overview[0][2], true) : null, lastObservedAt: queried ? postHogInstant(overview[0][3], true) : null };
  } finally { controller.abort(); }
}

async function pages(db: Database, table: TableName, options: Parameters<Database['select']>[1], max = 20_000) {
  const output: Row[] = [];
  for (let from = 0; from < max; from += 1000) {
    const rows = await db.select(table, { ...options, from, limit: 1000 }); output.push(...rows);
    if (rows.length < 1000) return output;
  }
  throw new ConnectorError('VISUAL_JOURNEY_READ_LIMIT');
}
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const dbInstant = (value: unknown) => {
  if (typeof value !== 'string') return null;
  try { return Temporal.Instant.from(value).toString(); } catch { return null; }
};

async function readRegistrations(db: Database, from: string, to: string, wixSiteId: string, env: NodeJS.ProcessEnv, prospects: Promise<Row[]>, includeTests: boolean) {
  const { start, end } = dateWindow(from, to);
  const [raw, people, publications] = await Promise.all([
    pages(db, 'lead_source_observations', { eq: { is_current: 'true' }, order: 'occurred_at,id' }),
    prospects.catch(() => []),
    pages(db, 'sync_runs', { in: { status: ['complete','empty'] }, eq: { pagination_complete: 'true' }, columns: ['id','source_namespace','stream_key','status','pagination_complete','rows_rejected','finished_at','started_at','query_profile_key'], order: 'started_at,id' }, 50_000),
  ]);
  const completed = publications.filter(row => row.pagination_complete === true && Number(row.rows_rejected ?? 0) === 0);
  const runIds = new Set(completed.map(row => String(row.id))), profiles = new Map<string,unknown>();
  for (const run of [...completed].sort((a,b) => String(a.finished_at ?? a.started_at).localeCompare(String(b.finished_at ?? b.started_at)) || String(a.id).localeCompare(String(b.id)))) {
    if (String(run.stream_key).startsWith('lead_entries_')) profiles.set(`${run.source_namespace}:${String(run.stream_key).slice(13)}`, run.query_profile_key);
  }
  const entryConfig = wixLeadEntryConfig(env.WIX_LEAD_ENTRY_CONFIG);
  const rows = reconcileAcquisitionPeople(raw.filter(row => row.published_at && (!row.run_id || runIds.has(String(row.run_id)) && row.mapping_profile === profiles.get(`${row.source_namespace}:${row.family}`)) && (
    row.family === 'client_history' ? !!env.NOTION_CLIENT_DATA_SOURCE_ID && row.source_namespace === env.NOTION_CLIENT_DATA_SOURCE_ID :
    row.source_namespace === wixSiteId && (!entryConfig || row.family === 'forms' && entryConfig.formIds.includes(String(row.source_container_id)) || row.family === 'quiz' && entryConfig.quiz?.collectionId === row.source_container_id)
  )), people, env.NOTION_DATA_SOURCE_ID);
  const origins = canonicalRegistrationOrigins(rows, includeTests);
  return rows.filter(row => row.family === 'forms' && row.source_container_id === VISUAL_JOURNEY_FORM_ID && row.eligible === true && String(row.source_status ?? '').toUpperCase() === 'CONFIRMED' && dbInstant(row.occurred_at) && Temporal.Instant.compare(String(row.occurred_at), start) >= 0 && Temporal.Instant.compare(String(row.occurred_at), end) < 0).map(row => {
    const occurredAt = dbInstant(row.occurred_at);
    if (!occurredAt) throw new ConnectorError('INVALID_REGISTRATION_ROW');
    const properties = record(row.properties);
    const retained = row.identity_state === 'linked' ? origins.get(String(row.person_id)) : undefined;
    return { id: String(row.id), personId: row.person_id ? String(row.person_id) : null, identityState: String(row.identity_state ?? 'unresolved'), occurredAt, publishedAt: dbInstant(row.published_at), origin: record(properties.origin), firstTouch: Object.keys(record(properties.firstTouch)).length ? record(properties.firstTouch) : null,
      explicitTest: isExcludedTestTraffic({ includeTests: false }, properties),
      canonicalOrigin: retained ? { source: retained.origin.source, medium: retained.origin.medium, campaign: retained.origin.campaignId, ad: retained.origin.adId, linkId: retained.origin.linkId, at: retained.at } : undefined,
    } satisfies VisualJourneyRegistrationRow;
  });
}

async function readAppointments(db: Database, env: NodeJS.ProcessEnv, prospects: Promise<Row[]>) {
  const [rows, people] = await Promise.all([pages(db, 'appointments', { order: 'id' }, 50_000), prospects]);
  const prospectById = new Map(people.map(row => [String(row.id),row]));
  return rows.flatMap(row => {
    const prospect = prospectById.get(String(row.prospect_id)), business = record(prospect?.business);
    if (prospect?.archived === true || row.source === 'notion' && env.NOTION_DATA_SOURCE_ID && row.source_namespace !== env.NOTION_DATA_SOURCE_ID || !isEffectiveAppointment(row, business)) return [];
    const booking = appointmentBooking(row, business);
    return [{ id: String(row.id), personId: row.person_id ? String(row.person_id) : prospect?.person_id ? String(prospect.person_id) : null,
      bookedAt: booking.at, bookedDay: booking.day, status: appointmentOutcome(row, business), observedAt: dbInstant(row.observed_at),
      displayName: typeof prospect?.display_name === 'string' ? prospect.display_name : null,
      scheduledAt: dbInstant(row.scheduled_at) ?? (typeof row.scheduled_day === 'string' ? row.scheduled_day : null),
      explicitTest: isExcludedTestTraffic({ includeTests: false }, row, business),
    } satisfies VisualJourneyAppointmentRow];
  });
}

async function scopedRuns(db: Database, job: SyncJob, source: string, stream: string, env: NodeJS.ProcessEnv) {
  const scope = jobScope(job, env);
  if (!scope) return [];
  const eq = { source, stream_key: stream, source_namespace: scope.namespace, query_profile_key: scope.profile };
  const columns = ['source','stream_key','status','started_at','finished_at','period_to','pagination_complete','error_code'];
  const [attempt, publication] = await Promise.all([
    db.select('sync_runs', { eq, columns, order: 'started_at', descending: true, limit: 1 }),
    db.select('sync_runs', { eq: { ...eq, pagination_complete: 'true' }, in: { status: ['complete','empty'] }, columns, order: 'finished_at', descending: true, limit: 1 }),
  ]);
  return [...attempt,...publication];
}
export function sourceFreshness(runs: Row[], source: string, stream: string, now: string, label: string): VisualJourneyReport['freshness']['wix'] {
  const state = connectionFreshness(runs, source, [stream], Date.parse(now));
  const observedAt = state.lastSyncAt, coveredThrough = state.dataAsOf;
  if (state.failed) return { observedAt, coveredThrough, status: 'failed', reason: `La dernière mise à jour de ${label} a échoué.` };
  if (state.running) return { observedAt, coveredThrough, status: 'running', reason: `${label} : mise à jour en cours.` };
  if (!observedAt || !coveredThrough) return { observedAt, coveredThrough, status: 'missing', reason: `La dernière mise à jour complète de ${label} est inconnue.` };
  if (!state.fresh) return { observedAt, coveredThrough, status: 'stale', reason: `${label} : les données attendent leur mise à jour horaire.` };
  return { observedAt, coveredThrough, status: 'available', reason: null };
}

async function availableAds(db: Database, browser: VisualJourneyBrowserRow[] | null, registrations: VisualJourneyRegistrationRow[], includeTests: boolean) {
  const ids = new Set<string>();
  for (const row of browser ?? []) if (includeTests || !row.explicitTest) { const value = row.origin.ad; if (typeof value === 'string' && /^\d{1,30}$/.test(value)) ids.add(value); }
  for (const row of registrations) {
    if (!includeTests && (row.explicitTest || isExcludedTestTraffic({ includeTests: false }, row.origin, row.firstTouch))) continue;
    const first = row.canonicalOrigin ?? (row.firstTouch && Object.keys(row.firstTouch).length ? row.firstTouch : row.origin);
    const value = first.ad ?? first.utm_content;
    if (typeof value === 'string' && /^\d{1,30}$/.test(value)) ids.add(value);
  }
  const labels = new Map<string, string>();
  const all = [...ids];
  for (let index = 0; index < all.length; index += 150) for (const row of await db.select('ads', { in: { external_id: all.slice(index, index + 150) }, columns: ['external_id','ad_name'], limit: 1000 })) labels.set(String(row.external_id), String(row.ad_name ?? row.external_id));
  return all.sort().map(id => ({ id: `meta-ad:${id}`, label: labels.get(id) ?? `Publicité ${id}` }));
}

export async function readVisualJourneyReport(db: Database, config: VisualJourneyAnalyticsConfig): Promise<VisualJourneyReport> {
  if (!['all','paid','organic','unknown'].includes(config.source)) throw new ConnectorError('INVALID_JOURNEY_SCOPE');
  safeFilter(config.campaign); dateWindow(config.from, config.to);
  const wixSiteId = config.wixSiteId ?? process.env.WIX_SITE_ID;
  if (!wixSiteId || wixSiteId.length > 200 || /[\u0000-\u001f\u007f]/.test(wixSiteId)) throw new ConnectorError('INVALID_CONFIGURATION');
  const generatedAt = Temporal.Instant.from(config.now?.() ?? new Date().toISOString()).toString();
  const syncEnv = config.syncEnv ?? process.env;
  const prospects = pages(db, 'prospects', { columns: ['id','external_id','source','source_namespace','person_id','business','archived','display_name'], order: 'id' }, 50_000);
  const timing: VisualJourneyPostHogTiming = { outcome: 'failed', elapsedMs: null, resumed: !!config.resumeBrowser && Object.keys(config.resumeBrowser).length > 0, periodDays: Temporal.PlainDate.from(config.from).until(Temporal.PlainDate.from(config.to)).total('days') + 1, queries: null };
  const browserPromise = readBrowser(config, generatedAt, timing).catch(error => { timing.outcome = 'failed'; return { rows: null, error: safeConnectorError(error), firstObservedAt: null, lastObservedAt: null }; });
  const [browserRead, registrationRead, appointmentRead, wixRun, appointmentRun] = await Promise.all([
    browserPromise,
    readRegistrations(db, config.from, config.to, wixSiteId, syncEnv, prospects, config.includeTests).then(rows => ({ rows, error: null as string | null })).catch(error => ({ rows: null, error: safeConnectorError(error) })),
    readAppointments(db, syncEnv, prospects).then(rows => ({ rows, error: null as string | null })).catch(error => ({ rows: null, error: safeConnectorError(error) })),
    scopedRuns(db, 'forms', 'wix', 'lead_entries_forms', syncEnv).catch(() => []),
    scopedRuns(db, 'notion', 'notion', 'prospects_business', syncEnv).catch(() => []),
  ]);
  const ads = await availableAds(db, browserRead.rows, registrationRead.rows ?? [], config.includeTests).catch(() => {
    const ids = new Set<string>();
    for (const row of browserRead.rows ?? []) if (typeof row.origin.ad === 'string' && /^\d{1,30}$/.test(row.origin.ad)) ids.add(row.origin.ad);
    for (const row of registrationRead.rows ?? []) { const value = (row.firstTouch ?? row.origin).ad; if (typeof value === 'string' && /^\d{1,30}$/.test(value)) ids.add(value); }
    return [...ids].sort().map(id => ({ id: `meta-ad:${id}`, label: `Publicité ${id}` }));
  });
  const posthogFreshness: VisualJourneyReport['freshness']['posthog'] = browserRead.rows === null
    ? { observedAt: null, coveredThrough: null, status: 'pending' in browserRead && browserRead.pending ? 'running' : config.host ? 'failed' : 'missing', reason: browserRead.error }
    : { observedAt: 'observedAt' in browserRead ? browserRead.observedAt : generatedAt, coveredThrough: browserRead.lastObservedAt, status: 'available', reason: browserRead.error };
  const wixFreshness: VisualJourneyReport['freshness']['wix'] = registrationRead.rows === null
    ? { observedAt: null, coveredThrough: null, status: 'failed', reason: registrationRead.error }
    : sourceFreshness(wixRun, 'wix', 'lead_entries_forms', generatedAt, 'les inscriptions');
  const appointmentFreshness: VisualJourneyReport['freshness']['appointments'] = appointmentRead.rows === null
    ? { observedAt: null, coveredThrough: null, status: 'failed', reason: appointmentRead.error }
    : sourceFreshness(appointmentRun, 'notion', 'prospects_business', generatedAt, 'les rendez-vous');
  const report = buildVisualJourneyReport({
    from: config.from, to: config.to, source: config.source, campaign: config.campaign, includeTests: config.includeTests, generatedAt,
    browser: browserRead.rows, browserError: browserRead.error,
    registrations: registrationRead.rows, registrationError: registrationRead.error,
    appointments: appointmentRead.rows, appointmentError: appointmentRead.error, availableAds: ads,
    freshness: { posthog: posthogFreshness, wix: wixFreshness, appointments: appointmentFreshness },
  });
  if (browserRead.error && browserRead.rows) report.limits.push(browserRead.error);
  report.timing = { posthog: timing };
  // Durations and statuses only: no visitor, query identifier, period date or credential.
  (config.log ?? console.info)(`[parcours] lecture PostHog ${JSON.stringify(timing)}`);
  return report;
}
