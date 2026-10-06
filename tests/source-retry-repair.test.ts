import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson, safeConnectorError } from '../src/connectors/http';
import { readMetaJson } from '../src/connectors/meta-http';
import { syncMeta } from '../src/connectors/meta';
import { createSyncExecutionBudget } from '../src/lib/sync-budget';
import { synchronizeMetaAds } from '../src/lib/sync';
import type { Database, Row } from '../src/lib/db';
import { tickSyncJobs } from '../src/lib/sync-jobs';
import { Temporal } from '@js-temporal/polyfill';

const insights = new URL('https://graph.facebook.com/v23.0/act_123/insights');
const transient = { error: { code: 2, error_subcode: 1504044, message: 'Synthetic temporary service fault' } };
test('Meta exact transient HTTP400 is retried with bounded backoff, retains its real HTTP status on exhaustion', async () => {
  let calls = 0; const waits: number[] = [];
  await assert.rejects(readMetaJson(insights, {}, { fetcher: async () => { calls++; return Response.json(transient, { status: 400 }); }, sleep: async ms => { waits.push(ms); } }), error => {
    assert.equal(safeConnectorError(error), 'UPSTREAM_HTTP_ERROR (HTTP 400)');
    assert.equal(String(error).includes('Synthetic temporary'), false); return true;
  });
  assert.equal(calls, 3); assert.deepEqual(waits, [250, 500]);
  calls = 0; waits.length = 0;
  const result = await readMetaJson(insights, {}, { attempts: 99, fetcher: async () => { calls++; return Response.json(transient, { status: 400, headers: { 'retry-after': '600' } }); }, sleep: async ms => { waits.push(ms); } }).catch(safeConnectorError);
  assert.equal(result, 'UPSTREAM_HTTP_ERROR (HTTP 400)'); assert.equal(calls, 4); assert.deepEqual(waits, [5000, 5000, 5000]);
});
test('Meta auth, parameters, wrong subcode, explicit non-transient and oversized errors never use this retry', async () => {
  for (const [body, status] of [
    [{ error: { code: 190, is_transient: true } }, 400],
    [{ error: { code: 100, error_subcode: 1504044, is_transient: true } }, 400],
    [{ error: { code: 2, error_subcode: 1, is_transient: true } }, 400],
    [{ error: { code: 2, error_subcode: 1504044, is_transient: false } }, 400],
    [transient, 401], [transient, 403],
    [{ ...transient, padding: 'x'.repeat(20000) }, 400],
  ] as const) {
    let calls = 0;
    await assert.rejects(readMetaJson(insights, {}, { fetcher: async () => { calls++; return Response.json(body, { status }); }, sleep: async () => assert.fail('no backoff for this error') }));
    assert.equal(calls, 1);
  }
});
test('default HTTP behavior and non-insights URLs remain unchanged by the optional Meta policy', async () => {
  let calls = 0;
  for (const reader of [
    () => readJson(insights, {}, { fetcher, sleep: async () => assert.fail() }),
    () => readMetaJson(new URL('https://graph.facebook.com/v23.0/act_123'), {}, { fetcher, sleep: async () => assert.fail() }),
    () => readMetaJson(new URL('https://example.invalid/v23.0/act_123/insights'), {}, { fetcher, sleep: async () => assert.fail() }),
  ]) {
    let before = calls; await assert.rejects(reader()); assert.equal(calls - before, 1);
  }
  function fetcher() { calls++; return Promise.resolve(Response.json(transient, { status: 400 })); }
});
test('caller cancellation before fetch and during retry backoff is terminal, safe and never sends the next request', async () => {
  const already = new AbortController(); already.abort(new Error('synthetic private abort reason'));
  let calls = 0;
  await assert.rejects(readMetaJson(insights, { signal: already.signal }, { fetcher: async () => { calls++; return Response.json({}); } }), error => {
    assert.equal(safeConnectorError(error), 'CONNECTOR_ABORTED'); return true;
  });
  assert.equal(calls, 0);
  const controller = new AbortController(); let startBackoff!: () => void;
  const waiting = new Promise<void>(resolve => { startBackoff = resolve; });
  const request = readMetaJson(insights, { signal: controller.signal }, {
    fetcher: async (_input, init) => {
      calls++; assert.notEqual(init?.signal, controller.signal); assert.equal(init?.signal?.aborted, false);
      return calls === 1 ? Response.json(transient, { status: 400 }) : Response.json({ success: true });
    },
    sleep: async () => { startBackoff(); await new Promise<void>(() => {}); },
  });
  await waiting; controller.abort(new Error('synthetic private abort reason'));
  await assert.rejects(request, error => { assert.equal(safeConnectorError(error), 'CONNECTOR_ABORTED'); return true; });
  assert.equal(calls, 1);
});
test('caller cancellation is combined with the request timeout signal and network retry cannot override it', async () => {
  const controller = new AbortController(); let calls = 0; let combined: AbortSignal | null | undefined;
  await assert.rejects(readJson(insights, { signal: controller.signal }, {
    fetcher: async (_input, init) => { calls++; combined = init?.signal; controller.abort(); assert.equal(combined?.aborted, true); throw new Error('synthetic network'); },
    sleep: async () => assert.fail('cancellation is not retryable'),
  }), { code: 'CONNECTOR_ABORTED' });
  assert.equal(calls, 1); assert.notEqual(combined, controller.signal);
});
test('the real source budget cancels Retry-After backoff before its reserved write margin is lost', async () => {
  let calls = 0;
  const budget = createSyncExecutionBudget({ totalMs: 100, writeMarginMs: 20, fetcher: async () => { calls++; return Response.json(transient, { status: 400, headers: { 'retry-after': '5' } }); } });
  const started = performance.now();
  try {
    await assert.rejects(readMetaJson(insights, { signal: budget.sourceSignal }, { fetcher: budget.sourceFetch }), { code: 'CONNECTOR_ABORTED' });
    assert.equal(calls, 1); assert.ok(performance.now() - started < 500, 'the 5-second pause cannot outlive the source deadline');
    assert.equal(budget.canStart(1), false); assert.ok(budget.remainingTotalMs() > 0, 'cleanup margin still available');
    await budget.writeFetch('https://example.invalid/synthetic-cleanup'); assert.equal(calls, 2);
  } finally { budget.dispose(); }
});
test('discarding a body whose cancel never settles cannot retain cancellation, retries or original terminal failures', async () => {
  const blockedBody = () => new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(() => {}) });
  const controller = new AbortController(); let calls = 0;
  const timer = setTimeout(() => controller.abort(), 10);
  const started = performance.now();
  try {
    await assert.rejects(readJson(insights, { signal: controller.signal }, { fetcher: async () => { calls++; return new Response(blockedBody(), { status: 503 }); } }), { code: 'CONNECTOR_ABORTED' });
    assert.equal(calls, 1); assert.ok(performance.now() - started < 100, 'cancel hook cannot retain the caller');
  } finally { clearTimeout(timer); }
  for (const status of [400, 401]) {
    await assert.rejects(readJson(insights, {}, { attempts: 1, fetcher: async () => new Response(blockedBody(), { status }) }), { code: status === 401 ? 'ACCESS_DENIED' : 'UPSTREAM_HTTP_ERROR', status });
  }
  calls = 0;
  const result = await readJson(insights, {}, { sleep: async () => {}, fetcher: async () => ++calls === 1 ? new Response(blockedBody(), { status: 503 }) : Response.json({ success: true }) });
  assert.deepEqual(result, { success: true }); assert.equal(calls, 2);
  await assert.rejects(readJson(insights, {}, { fetcher: async () => new Response(blockedBody(), { headers: { 'content-length': '2000001' } }) }), { code: 'RESPONSE_TOO_LARGE' });
  await assert.rejects(readJson(insights, {}, { fetcher: async () => new Response(new ReadableStream<Uint8Array>({ start: c => { c.enqueue(new Uint8Array(2000001)); }, cancel: () => new Promise<void>(() => {}) })) }), { code: 'RESPONSE_TOO_LARGE' });
});
const ad = (id: string, spend: string) => ({ account_id: '123', ad_id: id, date_start: '2026-01-01', date_stop: '2026-01-01', spend, impressions: '5', outbound_clicks: [{ action_type: 'outbound_click', value: '1' }] });
test('Meta retry resumes the same page and cursor, commits each successful page once and preserves sums', async () => {
  let secondPageCalls = 0; const waits: number[] = [], commits: string[][] = [], requestedCursors: (string | null)[] = [];
  const result = await syncMeta({ from: '2026-01-01', to: '2026-01-02', accountId: '123', accessToken: 'synthetic', sleep: async ms => { waits.push(ms); }, commitPage: async page => { commits.push(page.records.map(row => row.externalId)); }, fetcher: async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.searchParams.has('access_token'), false); assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer synthetic');
    if (!url.pathname.endsWith('/insights')) return Response.json({ account_id: '123', currency: 'EUR', timezone_name: 'Europe/Paris' });
    requestedCursors.push(url.searchParams.get('after'));
    if (!url.searchParams.has('after')) return Response.json({ data: [ad('1', '1.25')], paging: { next: 'https://graph.facebook.com/opaque-not-followed', cursors: { after: 'synthetic-after' } } });
    secondPageCalls++;
    return secondPageCalls === 1 ? Response.json(transient, { status: 400 }) : Response.json({ data: [ad('2', '2.50')] });
  } });
  assert.equal(result.status, 'complete'); assert.equal(result.coverage.complete, true);
  assert.equal(result.records.reduce((sum, row) => sum + (row.spendMinor ?? 0), 0), 375);
  assert.equal(result.records.reduce((sum, row) => sum + (row.impressions ?? 0), 0), 10);
  assert.deepEqual(requestedCursors, [null, 'synthetic-after', 'synthetic-after']);
  assert.deepEqual(commits, [['1:2026-01-01'], ['2:2026-01-01']]); assert.deepEqual(waits, [250]);
});
test('Meta exhausted transient page preserves prior checkpoint and never claims complete coverage', async () => {
  const commits: string[][] = [];
  const result = await syncMeta({ from: '2026-01-01', to: '2026-01-02', accountId: '123', accessToken: 'synthetic', sleep: async () => {}, commitPage: async page => { commits.push(page.records.map(row => row.externalId)); }, fetcher: async input => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/insights')) return Response.json({ account_id: '123', currency: 'EUR', timezone_name: 'Europe/Paris' });
    return url.searchParams.has('after') ? Response.json(transient, { status: 400 }) : Response.json({ data: [ad('1', '1.25')], paging: { next: 'opaque', cursors: { after: 'synthetic-after' } } });
  } });
  assert.equal(result.status, 'partial'); assert.equal(result.coverage.complete, false); assert.equal(result.safeError, 'UPSTREAM_HTTP_ERROR (HTTP 400)');
  assert.deepEqual(result.checkpoint, { cursor: 'synthetic-after' }); assert.deepEqual(commits, [['1:2026-01-01']]);
});
test('Meta caller cancellation during a second-page retry preserves the committed checkpoint without another request', async () => {
  const controller = new AbortController(); const commits: string[][] = []; let secondPageCalls = 0;
  const result = await syncMeta({ from: '2026-01-01', to: '2026-01-02', accountId: '123', accessToken: 'synthetic', signal: controller.signal,
    sleep: async () => { controller.abort(new Error('synthetic private abort reason')); },
    commitPage: async page => { commits.push(page.records.map(row => row.externalId)); },
    fetcher: async input => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith('/insights')) return Response.json({ account_id: '123', currency: 'EUR', timezone_name: 'Europe/Paris' });
      if (!url.searchParams.has('after')) return Response.json({ data: [ad('1', '1.25')], paging: { next: 'opaque', cursors: { after: 'synthetic-after' } } });
      secondPageCalls++; return secondPageCalls === 1 ? Response.json(transient, { status: 400 }) : Response.json({ data: [ad('2', '2.50')] });
    },
  });
  assert.equal(result.status, 'partial'); assert.equal(result.coverage.complete, false); assert.equal(result.safeError, 'CONNECTOR_ABORTED');
  assert.deepEqual(result.checkpoint, { cursor: 'synthetic-after' }); assert.deepEqual(commits, [['1:2026-01-01']]); assert.equal(secondPageCalls, 1);
});
test('ad synchronization uses the real invocation budget through read/backoff and closes without publication inside its cleanup margin', async () => {
  const rpcCalls: string[] = []; let pageCalls = 0;
  const budget = createSyncExecutionBudget({ totalMs: 300, writeMarginMs: 100, fetcher: async input => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/insights')) return Response.json({ account_id: '123', currency: 'EUR', timezone_name: 'Europe/Paris' });
    pageCalls++;
    if (!url.searchParams.has('after')) return Response.json({ data: [ad('1', '1.25')], paging: { next: 'opaque', cursors: { after: 'synthetic-after' } } });
    return Response.json(transient, { status: 400, headers: { 'retry-after': '5' } });
  } });
  const db: Database = { probe: async () => {}, select: async () => [], upsert: async () => {}, rpc: async <T>(name: string, args: Row) => {
    rpcCalls.push(name);
    if (name === 'import_meta_page') assert.equal(args.p_cursor, 'synthetic-after');
    if (name === 'finish_sync') { assert.ok(budget.remainingTotalMs() > 0); assert.equal(args.p_complete, false); assert.equal(args.p_error, 'CONNECTOR_ABORTED'); }
    return 'synthetic-run' as T;
  } };
  try {
    const result = await synchronizeMetaAds('2026-01-01', '2026-01-02', { db, fetcher: budget.sourceFetch, signal: budget.sourceSignal, env: { NODE_ENV: 'test', COCKPIT_MODE: 'live', META_AD_ACCOUNT_ID: '123', META_ACCESS_TOKEN: 'synthetic' } });
    assert.equal(result.status, 'partial'); assert.equal(result.coverage.complete, false); assert.equal(pageCalls, 2);
    assert.deepEqual(rpcCalls, ['begin_sync_stream', 'import_meta_page', 'finish_sync']);
  } finally { budget.dispose(); }
});
test('the real tick propagates the budget signal to ad_daily, finishes cleanup and releases its lease when a body cancel never settles', async () => {
  const controller = new AbortController(); let pageCalls = 0, released = 0; let timer: ReturnType<typeof setTimeout> | undefined;
  const rpcCalls: string[] = [];
  const day = Temporal.Now.plainDateISO('Europe/Paris').subtract({ days: 1 }).toString();
  const budget = createSyncExecutionBudget({ signal: controller.signal, fetcher: async input => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/insights')) return Response.json({ account_id: '123', currency: 'EUR', timezone_name: 'Europe/Paris' });
    pageCalls++;
    if (!url.searchParams.has('after')) return Response.json({ data: [{ ...ad('1', '1.25'), date_start: day, date_stop: day }], paging: { next: 'opaque', cursors: { after: 'synthetic-after' } } });
    timer = setTimeout(() => controller.abort(), 10);
    return new Response(new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(() => {}) }), { status: 503 });
  } });
  const db: Database = { probe: async () => {}, upsert: async () => assert.fail('tick does not write through this method'), select: async (_table, options) => {
    if (options?.eq?.stream_key === 'ad_daily') return [];
    return [{ ...options?.eq, id: 'synthetic-current', status: 'complete', pagination_complete: true, started_at: new Date().toISOString(), finished_at: new Date().toISOString() }];
  }, rpc: async <T>(name: string, args: Row) => {
    rpcCalls.push(name);
    if (name === 'import_meta_page') { assert.equal(args.p_cursor, 'synthetic-after'); assert.equal((args.p_records as unknown[]).length, 1); }
    if (name === 'finish_sync') { assert.equal(args.p_error, 'CONNECTOR_ABORTED'); assert.equal(args.p_complete, false); assert.ok(budget.remainingTotalMs() > 0); }
    if (name === 'cockpit_cleanup_staged') return { source_aggregates: 0, ad_daily: 0, meta_conversions_daily: 0, lead_source_observations: 0 } as T;
    return 'synthetic-run' as T;
  } };
  const started = performance.now();
  try {
    const result = await tickSyncJobs(db, { NODE_ENV: 'test', COCKPIT_MODE: 'live', META_AD_ACCOUNT_ID: '123', META_ACCESS_TOKEN: 'synthetic' }, { budget, sharedLease: { claim: async () => ({ state: 'acquired', release: async () => { released++; } }) } });
    assert.deepEqual(result.jobs, ['meta_ads']); assert.deepEqual(result.unitResults, [{ job: 'meta_ads', status: 'partial' }]);
    assert.equal(pageCalls, 2); assert.equal(released, 1); assert.ok(performance.now() - started < 500);
    assert.deepEqual(rpcCalls, ['begin_sync_stream', 'import_meta_page', 'finish_sync', 'cockpit_cleanup_staged']);
  } finally { if (timer) clearTimeout(timer); budget.dispose(); }
});

import { readKpiWixEmail, MASTERCLASS_EMAIL_MESSAGES } from '../src/connectors/kpi-wix-email';
import { startOfParisDay } from '../src/domain/dates';
const emailFields = { day: 'em_automation.automation_action_timeframe', message: 'em_automation.message_id', recipient: 'em_automation.recipient_email', sent: 'em_automation.automations_count', delivered: 'em_automation.automation_emails_delivered_count', opens: 'em_automation.automation_emails_opens_count', clicks: 'em_automation.automation_emails_clicks_count' };
const emailMeasures = ['sent', 'delivered', 'opens', 'clicks'] as const;
const emailEnv: NodeJS.ProcessEnv = { NODE_ENV: 'test', WIX_API_KEY: 'synthetic', WIX_SITE_ID: 'synthetic-site', IDENTITY_HMAC_SECRET: 'synthetic-key-at-least-32-characters' };
type EmailValues = Record<typeof emailMeasures[number], number | null>;
type EmailFixture = { day: string; message: string; recipient: string; values: EmailValues };
const emailRow = (index: number, day = '2026-09-15'): EmailFixture => ({ day, message: MASTERCLASS_EMAIL_MESSAGES[index % 9], recipient: `synthetic-${String(index).padStart(6, '0')}@example.test`, values: { sent: 1, delivered: 1, opens: index % 2, clicks: index % 3 === 0 ? 1 : 0 } });
function emailSource(source: EmailFixture[], options: { overlap?: boolean; drift?: boolean; nullTotals?: boolean; nullOpens?: boolean; forceSaturated?: boolean; opensTotal?: number } = {}) {
  const queries: { offset: number; messages: string[]; sort: string; count: number; from: string; to: string }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    if (!String(input).endsWith('/query-data')) return Response.json({ semanticModel: { id: 'e660016a-e2be-4eee-9cd2-8cad8a4fd8f3', slug: 'email-marketing-automations-actions', dimensions: [emailFields.day, emailFields.message, emailFields.recipient].map(name => ({ name, type: name === emailFields.day ? 'DATE_TIME' : 'STRING', sortable: true, filters: { prefixes: ['IS'], conditions: ['EQUAL'] } })), measures: emailMeasures.map(key => ({ name: emailFields[key], type: 'NUMBER' })) } });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.totalsIncluded, true); assert.equal(body.formattingEnabled, false);
    assert.deepEqual(body.fields, Object.values(emailFields));
    const selected = source.filter(row => body.filters[0].values.includes(row.message) && startOfParisDay(row.day) >= body.interval.start && startOfParisDay(row.day) < body.interval.end);
    selected.sort(body.sort.fieldName === emailFields.recipient ? (a, b) => a.recipient.localeCompare(b.recipient) : (a, b) => a.day.localeCompare(b.day));
    const offset = body.paging.offset;
    // This reproduces the unsafe day-only offset page overlapping an earlier page.
    const emittedOffset = options.overlap && body.sort.fieldName === emailFields.day && offset > 0 ? offset - 28 : offset;
    let emitted = selected.slice(emittedOffset, emittedOffset + Math.min(body.paging.limit, selected.length - offset));
    if (options.forceSaturated && selected.length) emitted = Array.from({ length: 1000 }, (_, index) => ({ ...selected[0], recipient: `budget-${offset + index}@example.test` }));
    queries.push({ offset, messages: body.filters[0].values, sort: body.sort.fieldName, count: emitted.length, from: body.interval.start, to: body.interval.end });
    const totals = Object.fromEntries(emailMeasures.map(key => [emailFields[key], { numericValue: options.nullTotals || options.nullOpens && key === 'opens' ? null : key === 'opens' && options.opensTotal !== undefined ? options.opensTotal : selected.reduce((sum, row) => sum + Number(row.values[key] ?? 0), 0) + (options.drift && offset > 0 && key === 'sent' ? 1 : 0) }]));
    return Response.json({ results: emitted.map(row => ({ fields: { [emailFields.day]: { timestampValue: startOfParisDay(row.day) }, [emailFields.message]: { stringValue: row.message }, [emailFields.recipient]: { stringValue: row.recipient }, ...Object.fromEntries(emailMeasures.map(key => [emailFields[key], { numericValue: row.values[key] }])) } })), pagingMetadata: { offset, count: emitted.length }, totals: { fields: totals } });
  };
  return { fetcher, queries };
}
test('the original day-offset counterexample repeats 28 identical aggregate keys while retaining plausible page counts', async () => {
  const fixture = emailSource(Array.from({ length: 1691 }, (_, index) => emailRow(index)), { overlap: true });
  async function page(offset: number) {
    const response = await fixture.fetcher('https://www.wixapis.com/analytics/semantic-model/v3/semantic-models/query-data', { method: 'POST', body: JSON.stringify({ fields: Object.values(emailFields), formattingEnabled: false, totalsIncluded: true, interval: { start: startOfParisDay('2026-09-01'), end: startOfParisDay('2026-10-07') }, filters: [{ values: MASTERCLASS_EMAIL_MESSAGES }], sort: { fieldName: emailFields.day }, paging: { limit: 1000, offset } }) });
    return (await response.json()).results as { fields: Record<string, unknown> }[];
  }
  const first = await page(0), second = await page(1000);
  const key = (row: { fields: Record<string, unknown> }) => JSON.stringify([row.fields[emailFields.day], row.fields[emailFields.message], row.fields[emailFields.recipient]]);
  const byKey = new Map(first.map(row => [key(row), row]));
  const overlap = second.filter(row => byKey.has(key(row)));
  assert.equal(first.length, 1000); assert.equal(second.length, 691); assert.equal(overlap.length, 28);
  for (const row of overlap) assert.deepEqual(row, byKey.get(key(row)));
  assert.equal(new Set([...first, ...second].map(key)).size, 1663, 'dropping repeats would lose 28 real fixture rows');
});
test('email starts with small disjoint windows instead of reading broad saturated parents; sums preserved', async () => {
  const rows = Array.from({ length: 1691 }, (_, index) => emailRow(index, new Date(Date.UTC(2026, 8, 1 + index % 36)).toISOString().slice(0, 10)));
  const fixture = emailSource(rows, { overlap: true });
  const result = await readKpiWixEmail('2026-09-01', '2026-10-07', emailEnv, fixture.fetcher);
  assert.equal(result.rows.length, rows.length); assert.equal(new Set(result.rows.map(row => row.key)).size, rows.length);
  for (const key of emailMeasures) assert.equal(result.rows.reduce((sum, row) => sum + Number(row.data[key]), 0), rows.reduce((sum, row) => sum + Number(row.values[key]), 0));
  assert.equal(fixture.queries.length, 6, '36-day spread: six disjoint windows, each at most seven days');
  assert.ok(fixture.queries.every(query => query.offset === 0), 'unsafe offset pagination is never used for day ties');
  assert.equal(JSON.stringify(result).includes('@example.test'), false);
});
test('email 1691 rows concentrated on one day still fit the bounded query budget via binary dates then message groups', async () => {
  const source = Array.from({ length: 1691 }, (_, index) => emailRow(index));
  const fixture = emailSource(source, { overlap: true });
  const result = await readKpiWixEmail('2026-09-01', '2026-10-07', emailEnv, fixture.fetcher);
  assert.equal(result.rows.length, 1691); assert.equal(fixture.queries.length, 12);
  assert.ok(fixture.queries.length <= 20); assert.ok(fixture.queries.every(query => query.offset === 0));
  assert.equal(result.rows.reduce((sum, row) => sum + Number(row.data.sent), 0), 1691);
});
test('email 37-day scope consists of six complete contiguous windows of at most seven days, with the final bound preserved', async () => {
  const source = Array.from({ length: 37 }, (_, index) => emailRow(index, new Date(Date.UTC(2026, 7, 31 + index)).toISOString().slice(0, 10)));
  const fixture = emailSource(source);
  const result = await readKpiWixEmail('2026-08-31', '2026-10-07', emailEnv, fixture.fetcher);
  assert.equal(result.rows.length, 37); assert.equal(fixture.queries.length, 6);
  const expected = ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05'];
  assert.deepEqual(fixture.queries.map(query => query.from), expected.map(startOfParisDay));
  for (let index = 1; index < fixture.queries.length; index++) assert.equal(fixture.queries[index - 1].to, fixture.queries[index].from);
  assert.equal(result.from, '2026-08-31'); assert.equal(result.to, '2026-10-07');
  assert.equal(fixture.queries.at(-1)?.to, [startOfParisDay('2026-10-07'), result.observedAt].sort()[0]);
});
test('email uses at most two simultaneous requests, keeps internal splits sequential and preserves ordered keys/values', async () => {
  const source = Array.from({ length: 1691 }, (_, index) => emailRow(index));
  const reference = await readKpiWixEmail('2026-09-01', '2026-10-07', emailEnv, emailSource(source).fetcher);
  const fixture = emailSource(source); let active = 0, peak = 0;
  const fetcher: typeof fetch = async (input, init) => {
    if (!String(input).endsWith('/query-data')) return fixture.fetcher(input, init);
    active++; peak = Math.max(peak, active);
    try { await new Promise<void>(resolve => setImmediate(resolve)); return await fixture.fetcher(input, init); }
    finally { active--; }
  };
  const result = await readKpiWixEmail('2026-09-01', '2026-10-07', emailEnv, fetcher);
  assert.equal(peak, 2); assert.equal(active, 0); assert.deepEqual(result.rows, reference.rows); assert.equal(fixture.queries.length, 12);
});
test('email joins the other independent partition after one fails and never starts the next pair or returns partial rows', async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const otherEntered = new Promise<void>(resolve => { entered = resolve; });
  const fixture = emailSource([emailRow(0, '2026-09-08')]); let requests = 0, completed = 0, settled = false;
  const fetcher: typeof fetch = async (input, init) => {
    if (!String(input).endsWith('/query-data')) return fixture.fetcher(input, init);
    requests++;
    if (requests === 1) return Response.json({ results: [], pagingMetadata: { offset: 0, count: 1 } });
    entered(); await held; completed++; return fixture.fetcher(input, init);
  };
  const pending = readKpiWixEmail('2026-09-01', '2026-10-07', emailEnv, fetcher);
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await otherEntered; await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(completed, 0); assert.equal(requests, 2);
  release(); await assert.rejects(pending, { code: 'INVALID_PAGINATION' });
  assert.equal(completed, 1); assert.equal(requests, 2); assert.equal(settled, true);
});
test('email leaf offsets sort the unique recipient within exactly one day/message, preserving every recipient and sums', async () => {
  const rows = Array.from({ length: 1205 }, (_, index) => ({ ...emailRow(index), message: MASTERCLASS_EMAIL_MESSAGES[0] }));
  const fixture = emailSource(rows); const result = await readKpiWixEmail('2026-09-15', '2026-09-16', emailEnv, fixture.fetcher);
  assert.equal(result.rows.length, 1205); assert.equal(new Set(result.rows.map(row => row.key)).size, 1205);
  const offsetQueries = fixture.queries.filter(query => query.offset > 0);
  assert.equal(offsetQueries.length, 1); assert.equal(offsetQueries[0].sort, emailFields.recipient);
  assert.deepEqual(offsetQueries[0].messages, [MASTERCLASS_EMAIL_MESSAGES[0]]);
  assert.equal(offsetQueries[0].offset, 1000);
  assert.equal(result.rows.reduce((sum, row) => sum + Number(row.data.delivered), 0), 1205);
});
test('email true same-key collisions, even identical values, remain explicit failures; changed totals never publish partial rows', async () => {
  for (const values of [{ ...emailRow(0).values }, { ...emailRow(0).values, sent: 2 }]) {
    const fixture = emailSource([emailRow(0), { ...emailRow(0), values }]);
    await assert.rejects(readKpiWixEmail('2026-09-15', '2026-09-16', emailEnv, fixture.fetcher), { code: 'KPI_EMAIL_DUPLICATE' });
  }
  const many = Array.from({ length: 1205 }, (_, index) => ({ ...emailRow(index), message: MASTERCLASS_EMAIL_MESSAGES[0] }));
  await assert.rejects(readKpiWixEmail('2026-09-15', '2026-09-16', emailEnv, emailSource(many, { drift: true }).fetcher), { code: 'KPI_EMAIL_SOURCE_CHANGED' });
});
test('email complete leaves preserve row values even when totals are null or at a non-additive grain', async () => {
  const complete = await readKpiWixEmail('2026-09-15', '2026-09-16', emailEnv, emailSource([emailRow(0)], { nullTotals: true }).fetcher);
  assert.equal(complete.rows[0].data.sent, 1);
  const fixture = emailSource([{ ...emailRow(0), values: { ...emailRow(0).values, opens: null } }], { nullOpens: true });
  const result = await readKpiWixEmail('2026-09-15', '2026-09-16', emailEnv, fixture.fetcher);
  assert.equal(result.rows[0].data.opens, null); assert.equal(result.rows[0].data.sent, 1);
  const nonAdditive = emailSource([40, 30, 6].map((opens, index) => ({ ...emailRow(index), values: { ...emailRow(index).values, opens } })), { opensTotal: 70 });
  const sameGrain = await readKpiWixEmail('2026-09-15', '2026-09-16', emailEnv, nonAdditive.fetcher);
  assert.equal(sameGrain.rows.reduce((sum, row) => sum + Number(row.data.opens), 0), 76);
});
test('email structural proof checks page metadata and scope rather than replacing rows with totals', async () => {
  for (const invalidScope of [false, true]) {
    const fixture = emailSource([emailRow(0)]);
    const fetcher: typeof fetch = async (input, init) => {
      const response = await fixture.fetcher(input, init);
      if (!String(input).endsWith('/query-data')) return response;
      const payload = await response.json();
      if (invalidScope) payload.results[0].fields[emailFields.day].timestampValue = startOfParisDay('2026-09-14'); else payload.pagingMetadata.count = 0;
      return Response.json(payload);
    };
    await assert.rejects(readKpiWixEmail('2026-09-15', '2026-09-16', emailEnv, fetcher), { code: invalidScope ? 'KPI_EMAIL_SCOPE' : 'INVALID_PAGINATION' });
  }
});
test('email request budget exhaustion is explicit and bounded, never a partial successful batch', async () => {
  const fixture = emailSource([emailRow(0)], { forceSaturated: true });
  await assert.rejects(readKpiWixEmail('2026-09-01', '2026-10-07', emailEnv, fixture.fetcher), { code: 'PAGE_LIMIT_REACHED' });
  assert.equal(fixture.queries.length, 20);
});
