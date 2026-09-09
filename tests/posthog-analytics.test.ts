import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postHogAggregateQueries, readPostHogAnalytics, POSTHOG_JOURNEY_EVENTS, type PostHogAnalyticsConfig } from '../src/connectors/posthog-analytics';

const countColumns = ['events', 'visitors', 'sessions', 'events_with_visitor_id', 'events_with_session_id'];
const overviewColumns = [...countColumns, 'observed_tracked_events', 'missing_host_events', 'conflicting_host_events', 'excluded_host_events', 'identifiable_test_events', 'first_observed_at', 'last_observed_at'];
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const result = (columns: string[], results: unknown[][], extra = {}) => response({ columns, results, hasMore: null, ...extra });
function definitions(options = { sessions: true, questions: true }) {
  return { next: null, results: [
    ...['$host', '$current_url', 'environment', ...(options.sessions ? ['$session_id'] : [])].map(name => ({ name, property_type: 'String', is_numerical: false })),
    ...(options.questions ? [{ name: 'numero', property_type: 'Numeric', is_numerical: true }] : []),
    { name: 'private_response', description: 'FORBIDDEN_PRIVATE_METADATA', property_type: 'String' },
  ] };
}
const baseOverview = () => [12, 7, 8, 12, 12, 15, 1, 1, 1, 0, '2026-08-17T10:00:00Z', '2026-08-18T14:00:00Z'];
const eventRows = () => [['question_repondue', 6, 4, 4, 6, 6], ['quiz_demarre', 6, 5, 5, 6, 6]];
const hostEventRows = () => eventRows().map(row => ['quizz.blg-studio.fr', ...row]);
const dailyRows = () => [['2026-08-17', 'question_repondue', 'quizz.blg-studio.fr', 6, 4, 4, 6, 6],
  ['2026-08-17', 'quiz_demarre', 'quizz.blg-studio.fr', 3, 3, 3, 3, 3], ['2026-08-18', 'quiz_demarre', 'quizz.blg-studio.fr', 3, 3, 3, 3, 3]];
const questionRows = () => [[1, 3, 3, 3, 3, 3], [2, 3, 3, 3, 3, 3]];
function fixtures(options = { sessions: true, questions: true }): Response[] {
  const stripSession = (rows: unknown[][], start: number) => rows.map(row => { if (!options.sessions) { row[start + 2] = 0; row[start + 4] = 0; } return row; });
  return [response({ id: 98765, name: 'FORBIDDEN_PROJECT_NAME', timezone: 'UTC' }), response(definitions(options)),
    result(overviewColumns, stripSession([baseOverview()], 0)), result(['event', ...countColumns], stripSession(eventRows(), 1)),
    result(['host', 'event', ...countColumns], stripSession(hostEventRows(), 2)),
    result(['day', 'event', 'host', ...countColumns], stripSession(dailyRows(), 3)),
    ...(options.questions ? [result(['question_number', ...countColumns], stripSession(questionRows(), 1))] : []),
  ];
}
function queue(responses: Response[], inspect?: (url: URL, init: RequestInit) => void): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => { inspect?.(new URL(String(input)), init ?? {}); const value = responses.shift(); assert.ok(value, 'Unexpected request'); return value; }) as typeof fetch;
}
const config = (fetcher: typeof fetch): PostHogAnalyticsConfig => ({ host: 'https://eu.posthog.com', projectId: '98765', personalApiKey: 'synthetic-key',
  from: '2026-08-16T22:00:00Z', to: '2026-08-20T22:00:00Z', now: () => '2026-09-07T18:00:00Z', fetcher, sleep: async () => {} });

test('PostHog only queries closed production aggregates with exact distinct counts and Paris boundaries', () => {
  const queries = postHogAggregateQueries('2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z', { sessionIdAvailable: true, questionNumberProperty: 'numero' });
  const all = Object.values(queries).join('\n');
  assert.ok(all.includes('uniqExactIf')); assert.ok(all.includes('toTimeZone(timestamp, \'Europe/Paris\')'));
  assert.ok(all.includes('timestamp < fromUnixTimestamp64Milli')); assert.ok(all.includes('quizz.blg-studio.fr')); assert.ok(all.includes('www.blg-studio.fr'));
  assert.ok(all.includes('NOT')); assert.ok(all.includes("'test', 'testing', 'development'")); assert.ok(all.includes("'blg_test'"));
  for (const event of POSTHOG_JOURNEY_EVENTS) assert.ok(all.includes(`'${event}'`));
  assert.ok(!/SELECT\s+\*|SELECT\s+distinct_id|groupArray|groupUniqArray|person_id|properties\.(email|reponse|profil)/i.test(all));
  assert.ok(queries.questions!.includes('properties.numero')); assert.ok(queries.questions!.includes("'^([1-9][0-9]?|100)$'"));
  assert.ok(queries.byHostEvent.includes('GROUP BY host, event')); assert.ok(!queries.byHostEvent.includes('GROUP BY day'));
  assert.throws(() => postHogAggregateQueries("2026-01-01'; SELECT * FROM persons", '2026-02-01T00:00:00Z', { sessionIdAvailable: true, questionNumberProperty: null }));
  assert.throws(() => postHogAggregateQueries('2026-03-29T12:00:00Z', '2026-03-29T22:00:00Z', { sessionIdAvailable: true, questionNumberProperty: null }), /INVALID_PERIOD/);
});

test('PostHog preserves deduplicated whole-period counts without summing visitors across days or steps', async () => {
  const cfg = config(queue(fixtures(), (url, init) => {
    assert.equal(url.origin, 'https://eu.posthog.com'); assert.equal(init.redirect, 'error'); assert.ok(!String(url).includes('synthetic-key'));
    if (init.method === 'POST') { const body = JSON.parse(String(init.body)); assert.equal(body.query.kind, 'HogQLQuery'); assert.equal(body.refresh, 'force_blocking'); assert.ok(body.name.startsWith('BLG production aggregate')); }
  }));
  const report = await readPostHogAnalytics(cfg);
  assert.equal(report.status, 'complete'); assert.equal(report.overview?.visitors, 7); assert.equal(report.byEvent.reduce((n, r) => n + r.visitors!, 0), 9);
  assert.equal(report.overview?.sessions, 8); assert.equal(report.daily.length, 3); assert.equal(report.questions.length, 2);
  assert.equal(report.byHostEvent.find(row => row.event === 'quiz_demarre')?.visitors, 5);
  assert.equal(report.daily.filter(row => row.event === 'quiz_demarre').reduce((n, row) => n + row.visitors!, 0), 6);
  assert.equal(report.coverage.queryComplete, true); assert.equal(report.coverage.allTrafficComplete, false); assert.equal(report.coverage.excludedHostEvents, 1);
  assert.equal(report.semantics.verifiedBackendLeads, false); assert.equal(report.semantics.sequentialFunnel, false); assert.ok(!JSON.stringify(report).includes('FORBIDDEN'));
});

test('PostHog separates production hosts while retaining whole-period distinct counts', async () => {
  const inputs = fixtures();
  inputs[4] = result(['host', 'event', ...countColumns], [
    ['quizz.blg-studio.fr', 'question_repondue', 6, 4, 4, 6, 6],
    ['quizz.blg-studio.fr', 'quiz_demarre', 3, 3, 3, 3, 3],
    ['www.blg-studio.fr', 'quiz_demarre', 3, 3, 3, 3, 3],
  ]);
  inputs[5] = result(['day', 'event', 'host', ...countColumns], dailyRows().map((row, i) => i === 2 ? [row[0], row[1], 'www.blg-studio.fr', ...row.slice(3)] : row));
  const report = await readPostHogAnalytics(config(queue(inputs)));
  assert.equal(report.status, 'complete'); assert.equal(report.coverage.queryComplete, true);
  const quiz = report.byHostEvent.find(row => row.host === 'quizz.blg-studio.fr' && row.event === 'quiz_demarre');
  const site = report.byHostEvent.find(row => row.host === 'www.blg-studio.fr' && row.event === 'quiz_demarre');
  assert.equal(quiz?.events, 3); assert.equal(quiz?.visitors, 3); assert.equal(quiz?.sessions, 3);
  assert.equal(site?.events, 3); assert.equal(site?.visitors, 3); assert.equal(site?.sessions, 3);
  assert.equal(report.byEvent.find(row => row.event === 'quiz_demarre')?.visitors, 5);
  assert.equal(report.overview?.visitors, 7);
});

test('PostHog rejects duplicated, foreign or unreconciled host-event aggregates', async () => {
  for (const rows of [
    [...hostEventRows(), hostEventRows()[0]],
    hostEventRows().map(row => ['quizz.blg-studio.fr.hostile.test', ...row.slice(1)]),
    hostEventRows().map(row => ['www.blg-studio.fr', ...row.slice(1)]),
    hostEventRows().slice(0, 1),
  ]) {
    const inputs = fixtures(); inputs[4] = result(['host', 'event', ...countColumns], rows);
    const report = await readPostHogAnalytics(config(queue(inputs)));
    assert.equal(report.status, 'partial'); assert.equal(report.coverage.queryComplete, false);
  }
});

test('PostHog missing session and question properties stay unavailable without inventing IDs', async () => {
  const report = await readPostHogAnalytics(config(queue(fixtures({ sessions: false, questions: false }))));
  assert.equal(report.status, 'complete'); assert.equal(report.overview?.sessions, null); assert.ok(report.daily.every(row => row.sessions === null));
  assert.equal(report.schema.questionNumberProperty, null); assert.deepEqual(report.questions, []);
  const queries = postHogAggregateQueries(config(queue([])).from, config(queue([])).to, report.schema);
  assert.equal(queries.questions, null); assert.ok(!queries.daily.includes('properties.$session_id'));
});

test('PostHog source scope rejects hostile API hosts, mismatched projects and absent host schema', async () => {
  for (const host of ['https://hostile.test', 'https://eu.posthog.com/path', 'https://eu.posthog.com?token=secret', 'https://eu.posthog.com@hostile.test']) {
    const report = await readPostHogAnalytics({ ...config(queue([])), host }); assert.equal(report.status, 'failed'); assert.equal(report.safeError, 'INVALID_CONFIGURATION');
  }
  const mismatch = await readPostHogAnalytics(config(queue([response({ id: 123 })]))); assert.equal(mismatch.safeError, 'PROJECT_IDENTITY_MISMATCH');
  const inputs = fixtures(); inputs[1] = response({ results: [], next: null });
  assert.equal((await readPostHogAnalytics(config(queue(inputs)))).safeError, 'POSTHOG_HOST_SCHEMA_MISSING');
});

test('PostHog schema pagination uses fixed offsets and ignores upstream next URLs', async () => {
  const inputs = fixtures(); const second = inputs.splice(1, 1)[0];
  inputs.splice(1, 0, response({ results: [{ name: 'technical_extra', property_type: 'String' }], next: 'https://hostile.test/STEAL_KEY' }), second);
  const paths: URL[] = [];
  const report = await readPostHogAnalytics(config(queue(inputs, url => { paths.push(url); })));
  assert.equal(report.status, 'complete'); assert.equal(paths[2].searchParams.get('offset'), '1'); assert.ok(paths.every(url => url.hostname === 'eu.posthog.com'));
});

test('PostHog rejects changed totals, duplicate groups, malformed counts and production host spoofing', async () => {
  for (const altered of [
    result(['day', 'event', 'host', ...countColumns], dailyRows().slice(0, 2)),
    result(['day', 'event', 'host', ...countColumns], [...dailyRows(), dailyRows()[0]]),
    result(['day', 'event', 'host', ...countColumns], dailyRows().map((row, i) => i ? row : [...row.slice(0, 3), 6, 99, 4, 6, 6])),
    result(['day', 'event', 'host', ...countColumns], dailyRows().map(row => [row[0], row[1], 'quizz.blg-studio.fr.hostile.test', ...row.slice(3)])),
    result(['day', 'event', 'host', ...countColumns], dailyRows().map(row => ['2026-08-21', ...row.slice(1)])),
  ]) {
    const inputs = fixtures(); inputs[5] = altered;
    const report = await readPostHogAnalytics(config(queue(inputs))); assert.equal(report.status, 'partial'); assert.equal(report.coverage.queryComplete, false);
  }
});

test('PostHog truncation, asynchronous execution and upstream secrets cannot become a complete report', async () => {
  for (const altered of [
    result(['event', ...countColumns], eventRows(), { hasMore: true }),
    response({ query_status: { complete: false, id: 'FORBIDDEN_QUERY_ID' } }),
    response({ message: 'FORBIDDEN_UPSTREAM_ERROR' }, 403),
    result(['event', ...countColumns, 'private_extra'], eventRows().map(row => [...row, 'FORBIDDEN_EXTRA'])),
  ]) {
    const inputs = fixtures(); inputs[3] = altered;
    const report = await readPostHogAnalytics(config(queue(inputs))); assert.equal(report.status, 'partial'); assert.equal(report.coverage.queryComplete, false); assert.ok(!JSON.stringify(report).includes('FORBIDDEN'));
  }
});

test('PostHog question output is limited to technical integer indexes, never text or answers', async () => {
  for (const raw of ['FORBIDDEN_ANSWER', -1, 101, 1.5]) {
    const inputs = fixtures(); inputs[6] = result(['question_number', ...countColumns], [[raw, 6, 4, 4, 6, 6]]);
    const report = await readPostHogAnalytics(config(queue(inputs))); assert.equal(report.status, 'partial'); assert.deepEqual(report.questions, []); assert.ok(!JSON.stringify(report).includes('FORBIDDEN'));
  }
  const inputs = fixtures(); inputs[6] = result(['question_number', ...countColumns], [[0, 6, 4, 4, 6, 6]]);
  const missing = await readPostHogAnalytics(config(queue(inputs))); assert.equal(missing.status, 'complete'); assert.equal(missing.questions[0].questionNumber, null);
});

test('PostHog reports an empty captured scope without claiming all traffic or verified leads', async () => {
  const inputs = fixtures(); inputs[2] = result(overviewColumns, [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z']]);
  inputs[3] = result(['event', ...countColumns], []); inputs[4] = result(['host', 'event', ...countColumns], []);
  inputs[5] = result(['day', 'event', 'host', ...countColumns], []); inputs[6] = result(['question_number', ...countColumns], []);
  const report = await readPostHogAnalytics(config(queue(inputs))); assert.equal(report.status, 'empty'); assert.equal(report.coverage.queryComplete, true); assert.equal(report.coverage.allTrafficComplete, false); assert.equal(report.coverage.firstObservedAt, null);
  const absent = await readPostHogAnalytics({ ...config(queue([])), personalApiKey: undefined }); assert.equal(absent.status, 'not_configured');
});
