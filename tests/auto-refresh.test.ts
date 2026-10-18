import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoRefresh, createVisibleReadRetry, type RefreshState } from '../src/lib/auto-refresh';

const state = (publicationId: string | null, stale = false, pending = false): RefreshState => ({ publicationId, stale, pending });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function harness(overrides: Partial<Parameters<typeof createAutoRefresh>[0]> = {}) {
  let time = 0, visible = true, publications = 0, reads = 0, kicks = 0;
  let current = state('first');
  let nextId = 1;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const controller = createAutoRefresh({
    read: async () => { reads++; return current; },
    kick: async () => { kicks++; return current; },
    isVisible: () => visible,
    onPublication: () => { publications++; },
    now: () => time,
    schedule: (callback, delay) => { const id = nextId++; timers.set(id, { callback, delay }); return id as unknown as ReturnType<typeof setTimeout>; },
    cancel: timer => { timers.delete(timer as unknown as number); },
    ...overrides,
  });
  return { controller, timers, counts: () => ({ publications, reads, kicks }), advance: (ms: number) => { time += ms; }, visible: (value: boolean) => { visible = value; }, current: (value: RefreshState) => { current = value; } };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('opening reads state, bridges initial dashboard read, and only changed publications reload it', async () => {
  const h = harness();
  await h.controller.wake(); await h.controller.wake();
  assert.deepEqual(h.counts(), { publications: 1, reads: 2, kicks: 0 });
  h.current(state('second')); await h.controller.check();
  assert.equal(h.counts().publications, 2);
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].delay, 30_000);
  h.controller.stop();
});

test('stale opening performs one bounded kick and observes its complete publication', async () => {
  let kicks = 0;
  const h = harness({ read: async () => state('old', true), kick: async () => { kicks++; return state('new'); } });
  await h.controller.wake();
  assert.equal(kicks, 1); assert.equal(h.counts().publications, 2);
  await h.controller.wake(); assert.equal(kicks, 1);
  h.advance(60_000); await h.controller.wake(); assert.equal(kicks, 2);
  h.controller.stop();
});

test('pending work is checked every poll and gets at most one rescue kick per minute', async () => {
  const h = harness(); h.current(state('old', true, true));
  await h.controller.check(); h.advance(30_000); await h.controller.check();
  assert.equal(h.counts().kicks, 1);
  h.advance(30_000); await h.controller.check(); assert.equal(h.counts().kicks, 2);
  h.controller.stop();
});

test('read failure never publishes success and the next scheduled poll recovers', async () => {
  let failed = true;
  const h = harness({ read: async () => { if (failed) throw Error('offline'); return state('recovered'); } });
  await assert.rejects(h.controller.wake(), /offline/);
  assert.equal(h.counts().publications, 0); assert.equal(h.timers.size, 1);
  failed = false;
  const timer = [...h.timers.values()][0]; h.timers.clear(); timer.callback(); await settle();
  assert.equal(h.counts().publications, 1);
  h.controller.stop();
});

test('failed kick backs off without preventing a later automatic recovery', async () => {
  let attempts = 0;
  const h = harness({ read: async () => state(null, true), kick: async () => { if (++attempts === 1) throw Error('source down'); return state('recovered'); } });
  await assert.rejects(h.controller.check(), /source down/);
  h.advance(30_000); await h.controller.check(); assert.equal(attempts, 1);
  h.advance(30_000); await h.controller.check();
  assert.equal(attempts, 2); assert.equal(h.counts().publications, 1);
  h.controller.stop();
});

test('hidden tab makes no request, clears timer and reloads on return to foreground', async () => {
  const h = harness(); h.visible(false); await h.controller.wake(); assert.equal(h.counts().reads, 0);
  h.visible(true); await h.controller.visibilityChanged(); assert.equal(h.counts().reads, 1);
  h.visible(false); await h.controller.visibilityChanged(); assert.equal(h.timers.size, 0);
  h.current(state('new')); h.visible(true); await h.controller.visibilityChanged(); assert.equal(h.counts().publications, 2);
  h.controller.stop();
});

test('simultaneous focus and poll share one request with no concurrent kick', async () => {
  const gate = deferred<RefreshState>(); let reads = 0, kicks = 0;
  const h = harness({ read: async () => { reads++; return gate.promise; }, kick: async () => { kicks++; return state('new'); } });
  const first = h.controller.wake(), second = h.controller.wake();
  assert.equal(reads, 1); gate.resolve(state('old', true)); await Promise.all([first, second]);
  assert.equal(kicks, 1); h.controller.stop();
});

test('hidden late result cannot overwrite the visible publication and aborted request recovers on focus', async () => {
  const old = deferred<RefreshState>(); let calls = 0;
  const h = harness({ read: async () => ++calls === 1 ? old.promise : state('current') });
  const first = h.controller.wake(); h.visible(false); await h.controller.visibilityChanged();
  h.visible(true); const second = h.controller.visibilityChanged();
  old.resolve(state('obsolete', true)); await Promise.all([first, second]);
  assert.equal(calls, 2); assert.equal(h.counts().publications, 1); assert.equal(h.counts().kicks, 0);
  h.controller.stop();
});

test('stop aborts requests and timers and forbids late publication or new request', async () => {
  const gate = deferred<RefreshState>(); let signal!: AbortSignal;
  const h = harness({ read: async s => { signal = s; return gate.promise; } });
  const pending = h.controller.wake(); h.controller.stop(); assert.equal(signal.aborted, true);
  gate.resolve(state('obsolete', true)); await pending; await h.controller.wake();
  assert.equal(h.counts().publications, 0); assert.equal(h.timers.size, 0);
});

test('manual refresh waits for existing work and then forces exactly one kick', async () => {
  const gate = deferred<RefreshState>(); let reads = 0, kicks = 0;
  const h = harness({ read: async () => ++reads === 1 ? gate.promise : state('first'), kick: async () => { kicks++; return state('second'); } });
  const initial = h.controller.wake(); const manual = h.controller.check(true);
  gate.resolve(state('first')); await Promise.all([initial, manual]);
  assert.equal(kicks, 1); assert.equal(h.counts().publications, 2); h.controller.stop();
});

test('malformed refresh response cannot become a publication or trigger a kick', async () => {
  const h = harness({ read: async () => ({ publicationId: 'x' } as RefreshState) });
  await assert.rejects(h.controller.wake(), /illisible/);
  assert.deepEqual(h.counts(), { publications: 0, reads: 0, kicks: 0 }); h.controller.stop();
});

test('failed screen read retries after 30 seconds and only once despite simultaneous focus', () => {
  let retries = 0, callback!: () => void, cancelled = 0;
  const retry = createVisibleReadRetry({
    retry: () => { retries++; }, isVisible: () => true,
    schedule: (work, delay) => { assert.equal(delay, 30_000); callback = work; return 1 as unknown as ReturnType<typeof setTimeout>; },
    cancel: () => { cancelled++; },
  });
  callback(); retry.wake(); retry.visibilityChanged();
  assert.equal(retries, 1); assert.equal(cancelled, 1); retry.stop();
});

test('failed screen retry is paused while hidden and immediately resumes at foreground', () => {
  let visible = false, retries = 0, timers = 0;
  const retry = createVisibleReadRetry({
    retry: () => { retries++; }, isVisible: () => visible,
    schedule: () => { timers++; return 1 as unknown as ReturnType<typeof setTimeout>; },
  });
  retry.wake(); retry.visibilityChanged(); assert.equal(retries, 0); assert.equal(timers, 0);
  visible = true; retry.visibilityChanged(); assert.equal(retries, 1); retry.stop();
});

test('hiding a scheduled failed screen retry clears it, and cleanup forbids a late read', () => {
  let visible = true, retries = 0, cancelled = 0, callback!: () => void;
  const retry = createVisibleReadRetry({
    retry: () => { retries++; }, isVisible: () => visible,
    schedule: work => { callback = work; return 1 as unknown as ReturnType<typeof setTimeout>; },
    cancel: () => { cancelled++; },
  });
  visible = false; retry.visibilityChanged(); assert.equal(cancelled, 1); callback(); assert.equal(retries, 0);
  retry.stop(); visible = true; retry.wake(); assert.equal(retries, 0);
});
