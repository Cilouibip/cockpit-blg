/** Client-side observation only. Source import and publication remain server-owned. */
export interface RefreshState {
  publicationId: string | null;
  pending: boolean;
  stale: boolean;
}

type Options = {
  read: (signal: AbortSignal) => Promise<RefreshState>;
  kick: (signal: AbortSignal) => Promise<RefreshState>;
  onPublication: () => void;
  isVisible: () => boolean;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
  pollMs?: number;
  kickMs?: number;
};

function validState(state: RefreshState): boolean {
  return !!state && (state.publicationId === null || typeof state.publicationId === 'string')
    && typeof state.pending === 'boolean' && typeof state.stale === 'boolean';
}

export function createAutoRefresh(options: Options) {
  const now = options.now ?? Date.now;
  const schedule: NonNullable<Options['schedule']> = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? clearTimeout;
  const pollMs = Math.max(1_000, options.pollMs ?? 30_000);
  const kickMs = Math.max(pollMs, options.kickMs ?? 60_000);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | undefined;
  let flight: Promise<void> | undefined;
  let publication: string | null | undefined;
  let lastKick = -Infinity;

  function clearTimer() { if (timer !== undefined) { cancel(timer); timer = undefined; } }
  function observe(state: RefreshState, signal: AbortSignal) {
    if (!validState(state)) throw new Error('La réponse d’actualisation est illisible.');
    if (stopped || signal.aborted || !options.isVisible()) return;
    // An initial observation also closes the gap with the first dashboard read.
    if (state.publicationId !== null && state.publicationId !== publication) {
      publication = state.publicationId;
      options.onPublication();
    }
  }
  function plan() {
    clearTimer();
    if (!stopped && options.isVisible()) timer = schedule(() => { timer = undefined; void check().catch(() => {}); }, pollMs);
  }
  function check(force = false): Promise<void> {
    if (stopped || !options.isVisible()) return Promise.resolve();
    clearTimer();
    if (flight) {
      // Focus/visibility may return before an aborted request has unwound.
      if (active?.signal.aborted || force) return flight.catch(() => {}).then(() => check(force));
      return flight;
    }
    const controller = new AbortController();
    active = controller;
    const signal = controller.signal;
    flight = (async () => {
      const state = await options.read(signal);
      observe(state, signal);
      if (stopped || signal.aborted || !options.isVisible()) return;
      const due = (state.stale || state.pending) && now() - lastKick >= kickMs;
      if (force || due) {
        // Timestamp attempts too: a failed source never creates a tight retry loop.
        lastKick = now();
        const result = await options.kick(signal);
        observe(result, signal);
      }
    })().finally(() => {
      if (active === controller) active = undefined;
      flight = undefined;
      plan();
    });
    return flight;
  }
  return {
    check,
    wake() { return check(); },
    visibilityChanged() {
      clearTimer();
      if (!options.isVisible()) { active?.abort(); return Promise.resolve(); }
      return check();
    },
    stop() { stopped = true; clearTimer(); active?.abort(); },
  };
}

/** One retry for a failed screen read, postponed while its tab is hidden. */
export function createVisibleReadRetry(options: {
  retry: () => void;
  isVisible: () => boolean;
  schedule?: Options['schedule'];
  cancel?: Options['cancel'];
}) {
  const schedule: NonNullable<Options['schedule']> = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const clear = () => { if (timer !== undefined) cancel(timer); timer = undefined; };
  const wake = () => {
    if (finished || !options.isVisible()) return;
    finished = true; clear(); options.retry();
  };
  if (options.isVisible()) timer = schedule(wake, 30_000);
  return {
    wake,
    visibilityChanged() { clear(); if (options.isVisible()) wake(); },
    stop() { finished = true; clear(); },
  };
}
