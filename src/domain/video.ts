export type WatchedInterval = { start: number; end: number };

export function mergeWatchedIntervals(intervals: readonly WatchedInterval[], duration: number): WatchedInterval[] {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('INVALID_VIDEO_DURATION');
  const sorted = intervals.map(interval => {
    if (![interval.start, interval.end].every(Number.isFinite) || interval.start < 0 || interval.end <= interval.start || interval.end > duration) throw new Error('INVALID_WATCHED_INTERVAL');
    return { ...interval };
  }).sort((a, b) => a.start - b.start);
  const merged: WatchedInterval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push(interval);
  }
  return merged;
}

export function watchedSeconds(intervals: readonly WatchedInterval[], duration: number): number {
  return mergeWatchedIntervals(intervals, duration).reduce((total, interval) => total + interval.end - interval.start, 0);
}
