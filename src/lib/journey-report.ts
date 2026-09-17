import { createHash } from 'node:crypto';
import { readJourneyAnalytics, type JourneyAnalyticsConfig } from '../connectors/journey-analytics';
import type { JourneyReport } from './journey-contract';

// Aggregate-only, short-lived cache. Its scope includes credentials and every
// filter so separate projects, versions and test selections never share data.
const pending = new Map<string, Promise<JourneyReport>>();
const completed = new Map<string, { until: number; report: JourneyReport }>();
export async function journeyReport(config: JourneyAnalyticsConfig): Promise<JourneyReport> {
  // Injected transports/clocks used by tests must not share a production cache.
  if (config.fetcher || config.now) return readJourneyAnalytics(config);
  const key = createHash('sha256').update(JSON.stringify({ host: config.host, project: config.projectId, credential: config.personalApiKey, from: config.from, to: config.to, tunnel: config.tunnel, source: config.source, campaign: config.campaign, tests: config.includeTests, version: config.version ?? null })).digest('hex');
  const now = Date.now();
  for (const [id, entry] of completed) if (entry.until <= now) completed.delete(id);
  const cached = completed.get(key); if (cached) return cached.report;
  const running = pending.get(key); if (running) return running;
  const work = readJourneyAnalytics(config).then(report => {
    if (report.status === 'complete' || report.status === 'empty') {
      while (completed.size >= 32) completed.delete(completed.keys().next().value!);
      completed.set(key, { until: Date.now() + 15_000, report });
    }
    return report;
  }).finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}
