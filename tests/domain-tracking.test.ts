import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instrumentQuiz } from '../tracking/quiz.js';
import { instrumentMasterclass } from '../tracking/masterclass.js';
import { createBLGCollector } from '../tracking/collector.js';
import { browserEventSchema, type BrowserEvent } from '../src/domain/ingestion';
import { selectCashAuthority } from '../src/domain/financial-authority';
import { parisPeriod } from '../src/domain/dates';
import { watchedSeconds } from '../src/domain/video';
import type { SourceAggregate } from '../src/domain/models';

function browserEnvironment() {
  const original = new Map<string, PropertyDescriptor | undefined>();
  const events: BrowserEvent[] = [];
  const intervals: (() => void)[] = [];
  let time = 0;
  const document = Object.assign(new EventTarget(), { hidden: false });
  const storageData = new Map<string, string>();
  const storage = { getItem: (key: string) => storageData.get(key) ?? null, setItem: (key: string, value: string) => storageData.set(key, value) };
  const replacements: Record<string, unknown> = {
    location: { origin: 'https://quizz.blg-studio.fr', search: '?blg_link_id=11111111-1111-4111-8111-111111111111&meta_ad_id=12345&email=NEVER_SEND' }, sessionStorage: storage, localStorage: storage,
    document, window: new EventTarget(), performance: { now: () => time },
    setInterval: (callback: () => void) => { intervals.push(callback); return intervals.length; }, clearInterval: () => {},
    fetch: async (_url: unknown, init: { body: string }) => { const event = browserEventSchema.parse(JSON.parse(init.body)); events.push(event); return new Response(null, { status: 202 }); },
  };
  for (const [key, value] of Object.entries(replacements)) { original.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, writable: true, configurable: true }); }
  return { events, document, tick() { time += 500; intervals.forEach(callback => callback()); }, cleanup() { for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } } };
}

test('Quiz adapter keeps capture after twelve questions, waits for actual save and never emits trusted success', async () => {
  const environment = browserEnvironment();
  try {
    const quiz = instrumentQuiz({ endpoint: 'https://cockpit.example.test/api/ingest/events', pageVersion: 'test-v1' });
    quiz.start(); assert.throws(() => quiz.showCoordinates(() => {}));
    for (let number = 1; number <= 12; number++) quiz.questionAnswered(number);
    let coordinates = false, resultVisible = false;
    quiz.showCoordinates(() => { coordinates = true; }); assert.equal(coordinates, true); assert.equal(quiz.canShowResult(), false);
    await assert.rejects(quiz.submitCoordinates(async () => ({ saved: false }), {}, () => { resultVisible = true; }));
    assert.equal(resultVisible, false);
    await quiz.submitCoordinates(async () => ({ saved: true }), {}, () => { resultVisible = true; });
    await quiz.collector.flush(); assert.equal(resultVisible, true);
    assert.equal(environment.events.some(event => (event.event_name as string) === 'lead_registered'), false);
    assert.equal(environment.events.at(-1)?.event_name, 'result_viewed');
    assert.ok(!JSON.stringify(environment.events).includes('NEVER_SEND'));
  } finally { environment.cleanup(); }
});

test('Masterclass adapter waits for opt-in and reports disjoint playback intervals across a seek', async () => {
  const environment = browserEnvironment();
  try {
    const video = Object.assign(new EventTarget(), { currentTime: 0, duration: 120, paused: true, ended: false, seeking: false, playbackRate: 1, pause() { this.paused = true; } });
    const bilanButton = new EventTarget();
    const player = instrumentMasterclass({ endpoint: 'https://cockpit.example.test/api/ingest/events', pageVersion: 'test-v1', video, videoId: 'video-test', videoVersion: 'v2', bilanButton });
    video.paused = false; video.dispatchEvent(new Event('play')); assert.equal(video.paused, true);
    let revealed = false; await player.submitOptin(async () => ({ saved: true }), {}, () => { revealed = true; }); assert.equal(revealed, true);
    video.paused = false; video.dispatchEvent(new Event('play'));
    for (let index = 0; index < 5; index++) { video.currentTime += .5; environment.tick(); }
    video.seeking = true; video.dispatchEvent(new Event('seeking')); video.currentTime = 90; video.seeking = false; video.dispatchEvent(new Event('seeked'));
    for (let index = 0; index < 5; index++) { video.currentTime += .5; environment.tick(); }
    bilanButton.dispatchEvent(new Event('click')); player.dispose(); await player.collector.flush();
    const watches = environment.events.filter((event): event is Extract<BrowserEvent, { event_name: 'video_watch' }> => event.event_name === 'video_watch');
    assert.equal(watches.length, 2); assert.equal(watchedSeconds(watches.flatMap(event => event.properties.intervals), 120), 4);
    assert.equal(new Set(watches.map(event => event.properties.playback_id)).size, 1);
    assert.ok(watches.every(event => event.properties.video_version === 'v2'));
    assert.equal(environment.events.at(-2)?.event_name, 'bilan_clicked');
  } finally { environment.cleanup(); }
});

test('Collector uses exactly the link revision and dynamic Meta IDs, never raw URL or UTM free text', async () => {
  const environment = browserEnvironment();
  try {
    const collector = createBLGCollector({ endpoint: 'https://cockpit.example.test/api/ingest/events', tunnel: 'quiz', pageVersion: 'test-v1' });
    await collector.emit('landing_arrival');
    assert.equal(environment.events[0].ad_id, '12345'); assert.equal(environment.events[0].link_revision_id, '11111111-1111-4111-8111-111111111111');
    assert.equal('url' in environment.events[0], false); assert.equal('email' in environment.events[0], false);
  } finally { environment.cleanup(); }
});

test('Cash authority selects transactions OR exact aggregate, rejects campaign filtering and overlapping sources', () => {
  const period = parisPeriod('2026-01-01', '2026-02-01');
  const authority = { version: 'test-v1', canonicalSource: 'wix', canonicalNamespace: 'test-site', transactions: { period, net: { minor: 10000, currency: 'EUR' }, complete: false, reconciled: false, taxBasis: 'gross' as const }, aggregateMetric: 'net-received' };
  const aggregate: SourceAggregate = { source: 'wix', accountId: 'test-site', externalId: 'aggregate', connectorVersion: 'test', observedAt: '2026-02-02T12:00:00Z', ...period, metric: 'net-received', amount: { minor: 30000, currency: 'EUR' }, count: null, taxBasis: 'gross', dimensions: {}, transactionGrain: false };
  const input = { authority, period, currency: 'EUR', dimensions: {}, aggregates: [aggregate], aggregateCoverage: { ...period, complete: true } };
  assert.equal(selectCashAuthority(input).value?.minor, 30000);
  authority.transactions.complete = true; authority.transactions.reconciled = true;
  assert.equal(selectCashAuthority(input).value?.minor, 10000);
  assert.equal(selectCashAuthority({ ...input, dimensions: { campaign: 'test' } }).value, null);
  authority.transactions.complete = false;
  assert.equal(selectCashAuthority({ ...input, aggregates: [aggregate, { ...aggregate, externalId: 'another-aggregate' }] }).value, null);
  assert.equal(selectCashAuthority({ ...input, aggregates: [{ ...aggregate, accountId: 'another-site' }] }).value, null);
});
