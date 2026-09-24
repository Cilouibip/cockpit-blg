import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessTickLock, jobScope, tickSyncJobs, type SyncJob } from '../src/lib/sync-jobs';
import type { Database, Row } from '../src/lib/db';

// Dimensionnement du déclencheur avec le vrai planificateur, une horloge et un budget virtuels (40 s de lecture sur 45 s).
// Durées d'unités : Notion est mesuré (passage du 18/09 : 36 unités, 95 s au total, 2,64 s par unité) ; tout le reste est SUPPOSÉ.
// Ce test ne prouve pas une durée de production : il montre, à durées données, quel intervalle de déclenchement tient 30 minutes.
const STREAM: Record<SyncJob, [string, string]> = {
  notion: ['notion', 'prospects_business'], meta: ['meta', 'meta_account_daily'], wix: ['wix', 'payments_analytics'], receipts: ['wix', 'receipt_observations'],
  meta_ads: ['meta', 'ad_daily'], meta_catalog: ['meta', 'ad_catalog'], quiz: ['posthog', 'quiz_observations'], masterclass: ['posthog', 'masterclass_observations'],
  forms: ['wix', 'lead_entries_forms'], quiz_entries: ['wix', 'lead_entries_quiz'], client_history: ['notion', 'lead_entries_client_history'],
  kpi_meta: ['meta', 'kpi_meta_daily'], kpi_posthog: ['posthog', 'kpi_posthog_daily'], kpi_email: ['wix', 'kpi_wix_daily'], commerce: ['notion', 'commerce_declared_snapshot'],
};
// Cadence 30 activée explicitement (le défaut de transition est 60) : ce test dimensionne le déclencheur pour 30 minutes.
const env = {
  COCKPIT_MODE: 'live', BLG_REFRESH_CADENCE_MINUTES: '30', NOTION_DATA_SOURCE_ID: 'notion', NOTION_TOKEN: 's', NOTION_CLIENT_DATA_SOURCE_ID: 'clients', META_AD_ACCOUNT_ID: 'meta', META_ACCESS_TOKEN: 's',
  WIX_SITE_ID: 'wix', WIX_API_KEY: 's', IDENTITY_HMAC_SECRET: 'x'.repeat(32), POSTHOG_PROJECT_ID: '123', POSTHOG_PERSONAL_API_KEY: 's',
  WIX_LEAD_ENTRY_CONFIG: JSON.stringify({ formIds: ['form-1'], quiz: { collectionId: 'Quiz', originFields: { ad: 'publicite' } } }),
} as unknown as NodeJS.ProcessEnv;
type Profile = Partial<Record<SyncJob, [units: number, seconds: number]>>;
// Pessimiste : Notion en delta (migration 021 : 5 unités par passage) à 4 s par unité, rapports PostHog en quatre unités de 20 s, autres unités deux
// fois plus longues que le profil central. La relecture Notion complète (36 unités, une fois par 24 h) est mesurée dans tests/refresh-mechanism.test.ts.
const PESSIMISTIC: Profile = { notion: [5, 4], meta: [1, 12], wix: [1, 12], receipts: [1, 12], meta_ads: [1, 20], meta_catalog: [1, 12], quiz: [4, 20], masterclass: [4, 20], forms: [1, 8], quiz_entries: [1, 8], client_history: [1, 8], kpi_meta: [1, 16], kpi_posthog: [1, 16], kpi_email: [1, 16] };
const PILOT: SyncJob[] = ['meta_ads', 'masterclass', 'forms', 'kpi_meta', 'kpi_posthog', 'kpi_email'];

async function simulate(profile: Profile, everyMinutes: number, hours: number) {
  const rows: Row[] = [], open = new Map<SyncJob, { row: Row; done: number }>(), published = new Map<SyncJob, number[]>();
  const db: Database = {
    select: async (_table, o) => rows.filter(r => Object.entries(o?.eq ?? {}).every(([k, v]) => String(r[k]) === v) && Object.entries(o?.in ?? {}).every(([k, v]) => v.includes(String(r[k]))))
      .sort((a, b) => String(a[o?.order ?? 'started_at'] ?? '').localeCompare(String(b[o?.order ?? 'started_at'] ?? '')) * (o?.descending ? -1 : 1)).slice(0, o?.limit ?? 1e9).map(r => ({ ...r })),
    upsert: async () => {}, rpc: async () => assert.fail('aucune RPC : les unités sont simulées'), probe: async () => {},
  };
  const start = Date.parse('2026-09-23T00:00:00Z');let t = start, seq = 0, maxTickMs = 0;
  for (let k = 0; t < start + hours * 3_600_000; k++) {
    const tickStart = start + k * everyMinutes * 60_000 + 2000;t = tickStart;
    await tickSyncJobs(db, env, {
      lock: createProcessTickLock(), now: () => t,
      // Fusion U4c-garde : la simulation du déclencheur détient le bail partagé, sinon la demi-heure n'est pas effective (60 signalé).
      sharedLease: { claim: async () => ({ state: 'acquired', release: async () => undefined }) },
      budget: { sourceFetch: async () => new Response('{}'), canStart: max => tickStart + 40_000 - t >= max, dispose: () => {} },
      execute: async job => {
        const [units, seconds] = profile[job] ?? assert.fail(`unité inattendue ${job}`), scope = jobScope(job, env)!;
        let state = open.get(job);
        if (!state) { state = { row: { id: `r${++seq}`, source: STREAM[job][0], stream_key: STREAM[job][1], source_namespace: scope.namespace, query_profile_key: scope.profile, status: 'running', started_at: new Date(t).toISOString() }, done: 0 };rows.push(state.row);open.set(job, state); }
        t += seconds * 1000;state.done++;
        if (state.done < units) { state.row.lease_until = new Date(t).toISOString();return { status: 'partial' }; }
        Object.assign(state.row, { status: 'complete', pagination_complete: true, finished_at: new Date(t).toISOString(), lease_until: null, ...(job === 'notion' ? { period_to: state.row.started_at } : {}) });
        open.delete(job);published.set(job, [...(published.get(job) ?? []), t]);
        return { status: 'complete' };
      },
    });
    maxTickMs = Math.max(maxTickMs, t - tickStart);
  }
  const warm = start + 2 * 3_600_000;
  const gaps = (job: SyncJob) => { const times = (published.get(job) ?? []).filter(x => x >= warm);return times.slice(1).map((x, i) => (x - times[i]) / 60_000); };
  return { gaps, maxTickMs };
}

test('dimensionnement : un déclenchement toutes les 2 minutes tient 30 minutes pour les flux Masterclass, même en profil pessimiste', async () => {
  const { gaps, maxTickMs } = await simulate(PESSIMISTIC, 2, 14);
  for (const job of PILOT) {
    const g = gaps(job), mean = g.reduce((a, b) => a + b, 0) / g.length;
    assert.ok(g.length >= 20, `${job} publié au moins toutes les demi-heures sur 12 h (${g.length + 1} publications)`);
    assert.ok(mean <= 31, `${job} : écart moyen ${mean.toFixed(1)} min`);
    assert.ok(Math.max(...g) <= 45, `${job} : écart maximal ${Math.max(...g).toFixed(1)} min`);
  }
  // Flux horaires : ils passent après les flux à 30 minutes (chooseSyncJob) ; en profil pessimiste ils attendent jusqu'à une demi-heure de plus
  // (mesure tests/refresh-mechanism.test.ts : 60 à 90 min), sans famine (garde d'échéance).
  const hourly = Object.fromEntries((['meta', 'wix', 'receipts', 'meta_catalog', 'quiz', 'quiz_entries', 'client_history'] as SyncJob[]).map(job => [job, Math.max(...gaps(job))]));
  console.log('HOURLY_MAX ' + JSON.stringify(hourly));
  for (const job of ['meta', 'wix', 'receipts', 'meta_catalog', 'quiz', 'quiz_entries', 'client_history'] as SyncJob[]) assert.ok(gaps(job).length >= 9 && Math.max(...gaps(job)) <= 95, `${job} : horaire, retardé d'au plus une demi-heure par les flux pilotes (${Math.max(...gaps(job)).toFixed(1)} min)`);
  assert.ok(maxTickMs <= 45_000, 'un passage ne dépasse jamais son budget, bien en dessous des 120 s entre deux déclenchements');
});

test('dimensionnement : un déclenchement toutes les 5 minutes ne suffit pas en profil pessimiste (unités de 30 s limitées à une par passage)', async () => {
  const { gaps } = await simulate(PESSIMISTIC, 5, 14);
  const worst = Math.max(...PILOT.map(job => { const g = gaps(job);return g.reduce((a, b) => a + b, 0) / g.length; }));
  assert.ok(worst > 40, `écart moyen du pire flux Masterclass ${worst.toFixed(1)} min : l’intervalle de 5 minutes est rejeté`);
});
