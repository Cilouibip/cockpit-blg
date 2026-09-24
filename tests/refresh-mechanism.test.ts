import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createProcessTickLock, jobScope, tickSyncJobs, type SyncJob } from '../src/lib/sync-jobs';
import type { Database, Row } from '../src/lib/db';

// Reprise CP2 (24/09) · mécanisme des retards de la cadence 30 : le vrai planificateur (tickSyncJobs, chooseSyncJob, budget 40 s sur 45 s),
// une horloge virtuelle, un déclenchement toutes les 2 minutes (et 1 minute), Notion en delta (5 unités) avec une relecture complète
// (36 unités) toutes les 24 h. Pour chaque publication : instant dû (créneau), départ, publication, écart avec la précédente,
// attente en file (départ - dû) et âge visible juste avant la publication (publication - heure de lecture précédente ; Notion : coupure).
// Durées : Notion mesurée le 18/09 (2,64 s par unité) ; le reste est SUPPOSÉ (profils du runbook §1.3). Ce test ne prouve aucune durée
// de production : il montre, à durées données, d'où vient chaque minute de retard et ce que change une correction du planificateur.
const STREAM: Record<SyncJob, [string, string]> = {
  notion: ['notion', 'prospects_business'], meta: ['meta', 'meta_account_daily'], wix: ['wix', 'payments_analytics'], receipts: ['wix', 'receipt_observations'],
  meta_ads: ['meta', 'ad_daily'], meta_catalog: ['meta', 'ad_catalog'], quiz: ['posthog', 'quiz_observations'], masterclass: ['posthog', 'masterclass_observations'],
  forms: ['wix', 'lead_entries_forms'], quiz_entries: ['wix', 'lead_entries_quiz'], client_history: ['notion', 'lead_entries_client_history'],
  kpi_meta: ['meta', 'kpi_meta_daily'], kpi_posthog: ['posthog', 'kpi_posthog_daily'], kpi_email: ['wix', 'kpi_wix_daily'], commerce: ['notion', 'commerce_declared_snapshot'],
};
const env = {
  COCKPIT_MODE: 'live', BLG_REFRESH_CADENCE_MINUTES: '30', NOTION_DATA_SOURCE_ID: 'notion', NOTION_TOKEN: 's', NOTION_CLIENT_DATA_SOURCE_ID: 'clients', META_AD_ACCOUNT_ID: 'meta', META_ACCESS_TOKEN: 's',
  WIX_SITE_ID: 'wix', WIX_API_KEY: 's', IDENTITY_HMAC_SECRET: 'x'.repeat(32), POSTHOG_PROJECT_ID: '123', POSTHOG_PERSONAL_API_KEY: 's',
  WIX_LEAD_ENTRY_CONFIG: JSON.stringify({ formIds: ['form-1'], quiz: { collectionId: 'Quiz', originFields: { ad: 'publicite' } } }),
} as unknown as NodeJS.ProcessEnv;
type Profile = Partial<Record<SyncJob, [units: number, seconds: number]>> & { notionFull: [units: number, seconds: number] };
// Profil central (runbook §1.3) : Notion delta 5 unités de 2,64 s, relecture complète 36 unités ; PostHog 2 unités de 12 s ; autres supposées.
export const CENTRAL: Profile = { notion: [5, 2.64], notionFull: [36, 2.64], meta: [1, 6], wix: [1, 6], receipts: [1, 6], meta_ads: [1, 10], meta_catalog: [1, 6], quiz: [2, 12], masterclass: [2, 12], forms: [1, 4], quiz_entries: [1, 4], client_history: [1, 4], kpi_meta: [1, 8], kpi_posthog: [1, 8], kpi_email: [1, 8] };
// Profil pessimiste (tests/refresh-cycle.test.ts) : Notion 4 s par unité, PostHog 4 unités de 20 s, autres durées doublées.
export const PESSIMISTIC: Profile = { notion: [5, 4], notionFull: [36, 4], meta: [1, 12], wix: [1, 12], receipts: [1, 12], meta_ads: [1, 20], meta_catalog: [1, 12], quiz: [4, 20], masterclass: [4, 20], forms: [1, 8], quiz_entries: [1, 8], client_history: [1, 8], kpi_meta: [1, 16], kpi_posthog: [1, 16], kpi_email: [1, 16] };
export const PILOT: SyncJob[] = ['notion', 'meta_ads', 'masterclass', 'forms', 'kpi_meta', 'kpi_posthog', 'kpi_email'];
const HOURLY: SyncJob[] = ['meta', 'wix', 'receipts', 'meta_catalog', 'quiz', 'quiz_entries', 'client_history'];
type Publication = { job: SyncJob; dueAt: number; startAt: number; publishAt: number; readAt: number; units: number; full: boolean };
export type FlowStats = { publications: number; gapMeanMin: number; gapMaxMin: number; gapMinMin: number; queueMeanMin: number; queueMaxMin: number; ageMaxMin: number; ageMeanMin: number; ageMaxAtFullMin?: number };

export async function simulate(profile: Profile, everyMinutes: number, hours: number, options: { fullAtHour?: number } = {}) {
  const rows: Row[] = [], open = new Map<SyncJob, { row: Row; done: number; units: number; seconds: number; startAt: number; full: boolean }>(), publications: Publication[] = [];
  const db: Database = {
    select: async (_table, o) => rows.filter(r => Object.entries(o?.eq ?? {}).every(([k, v]) => String(r[k]) === v) && Object.entries(o?.in ?? {}).every(([k, v]) => v.includes(String(r[k]))))
      .sort((a, b) => String(a[o?.order ?? 'started_at'] ?? '').localeCompare(String(b[o?.order ?? 'started_at'] ?? '')) * (o?.descending ? -1 : 1)).slice(0, o?.limit ?? 1e9).map(r => ({ ...r })),
    upsert: async () => {}, rpc: async () => assert.fail('aucune RPC : les unités sont simulées'), probe: async () => {},
  };
  const start = Date.parse('2026-09-23T00:00:00Z');let t = start, seq = 0, maxTickMs = 0, lastFull = -Infinity;
  const cadenceOf = (job: SyncJob) => (PILOT.includes(job) ? 30 : 60) * 60_000;
  const lastPublish = new Map<SyncJob, Publication>();
  for (let k = 0; t < start + hours * 3_600_000; k++) {
    const tickStart = start + k * everyMinutes * 60_000 + 2000;t = tickStart;
    await tickSyncJobs(db, env, {
      lock: createProcessTickLock(), now: () => t,
      sharedLease: { claim: async () => ({ state: 'acquired', release: async () => undefined }) },
      budget: { sourceFetch: async () => new Response('{}'), canStart: max => tickStart + 40_000 - t >= max, dispose: () => {} },
      execute: async job => {
        let state = open.get(job);
        if (!state) {
          // Notion : relecture complète (36 unités) au premier passage puis toutes les 24 h (à l'heure demandée, sinon dès que 24 h sont écoulées).
          const wantsFull = job === 'notion' && (t - lastFull >= 24 * 3_600_000) && (options.fullAtHour === undefined || lastFull === -Infinity || new Date(t).getUTCHours() === options.fullAtHour);
          const [units, seconds] = wantsFull ? profile.notionFull : (profile[job] ?? assert.fail(`unité inattendue ${job}`)), scope = jobScope(job, env)!;
          state = { row: { id: `r${++seq}`, source: STREAM[job][0], stream_key: STREAM[job][1], source_namespace: scope.namespace, query_profile_key: scope.profile, status: 'running', started_at: new Date(t).toISOString() }, done: 0, units, seconds, startAt: t, full: wantsFull };
          rows.push(state.row);open.set(job, state);
          if (wantsFull) lastFull = t;
        }
        t += state.seconds * 1000;state.done++;
        if (state.done < state.units) { state.row.lease_until = new Date(t).toISOString();return { status: 'partial' }; }
        Object.assign(state.row, { status: 'complete', pagination_complete: true, finished_at: new Date(t).toISOString(), lease_until: null, ...(job === 'notion' ? { period_to: state.row.started_at } : {}) });
        open.delete(job);
        const previous = lastPublish.get(job), cadence = cadenceOf(job);
        // Instant dû : entrée dans le créneau UTC suivant de la cadence après le départ précédent (règle de syncStreamStates), sinon le départ.
        const dueAt = previous ? (Math.floor(previous.startAt / cadence) + 1) * cadence : state.startAt;
        const publication: Publication = { job, dueAt, startAt: state.startAt, publishAt: t, readAt: state.startAt, units: state.units, full: state.full };
        publications.push(publication);lastPublish.set(job, publication);
        return { status: 'complete' };
      },
    });
    maxTickMs = Math.max(maxTickMs, t - tickStart);
  }
  const warm = start + 2 * 3_600_000;
  const stats = (job: SyncJob): FlowStats => {
    const all = publications.filter(p => p.job === job), list = all.filter(p => p.publishAt >= warm);
    const gaps: number[] = [], queues: number[] = [], ages: number[] = [], agesAtFull: number[] = [];
    for (const p of list) {
      const index = all.indexOf(p), previous = all[index - 1];
      queues.push((p.startAt - Math.max(p.dueAt, warm - 3_600_000)) / 60_000);
      if (previous) { gaps.push((p.publishAt - previous.publishAt) / 60_000);const age = (p.publishAt - previous.readAt) / 60_000;(p.full ? agesAtFull : ages).push(age); }
    }
    const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN, round = (x: number) => Math.round(x * 10) / 10;
    return { publications: list.length, gapMeanMin: round(mean(gaps)), gapMaxMin: round(Math.max(...gaps)), gapMinMin: round(Math.min(...gaps)), queueMeanMin: round(mean(queues)), queueMaxMin: round(Math.max(...queues)), ageMaxMin: round(Math.max(...ages)), ageMeanMin: round(mean(ages)), ...(agesAtFull.length ? { ageMaxAtFullMin: round(Math.max(...agesAtFull)) } : {}) };
  };
  return { stats, publications, maxTickMs };
}
const table = (result: Awaited<ReturnType<typeof simulate>>) => Object.fromEntries([...PILOT, ...HOURLY].map(job => [job, result.stats(job)]));

test('mécanisme (mesure) : profils central et pessimiste, déclenchement 2 min puis 1 min, 26 h avec une relecture Notion complète ; rapport JSON', async () => {
  const report: Record<string, unknown> = {};
  for (const [name, profile] of [['central', CENTRAL], ['pessimiste', PESSIMISTIC]] as const) {
    for (const every of [2, 1]) {
      const result = await simulate(profile, every, 26);
      report[`${name}-${every}min`] = { maxTickMs: result.maxTickMs, flows: table(result) };
      assert.ok(result.maxTickMs <= 45_000, 'un passage ne dépasse jamais son budget');
    }
    // Relecture Notion complète placée la nuit (02 h UTC, 04 h Paris) : la pointe d'âge des rendez-vous se déplace à cette heure.
    const night = await simulate(profile, 2, 50, { fullAtHour: 2 });
    report[`${name}-2min-relecture-nuit`] = { maxTickMs: night.maxTickMs, flows: table(night), fullPasses: night.publications.filter(p => p.full).map(p => new Date(p.startAt).toISOString()) };
  }
  if (process.env.BLG_REPORT_DIR) fs.writeFileSync(path.join(process.env.BLG_REPORT_DIR, process.env.BLG_REPORT_NAME ?? 'cadence-mecanisme.json'), JSON.stringify({ head: process.env.BLG_REPORT_HEAD ?? null, generatedAt: new Date().toISOString(), synthetic: true, profiles: { central: CENTRAL, pessimiste: PESSIMISTIC }, scenarios: report }, null, 1));
  console.log('CADENCE_REPORT écrit : ' + Object.keys(report).join(', '));
  // Ce que le rapport doit montrer, sans juger d'une tolérance métier : la file au créneau (attente = départ - dû) explique l'écart.
  const central = (report['central-2min'] as { flows: Record<SyncJob, FlowStats> }).flows;
  for (const job of PILOT.filter(j => j !== 'notion')) assert.ok(central[job].gapMeanMin >= 29 && central[job].gapMeanMin <= 31.5, `${job} : écart moyen ${central[job].gapMeanMin}`);
});
