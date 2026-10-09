import { Temporal } from '@js-temporal/polyfill';
import type { Database } from './db';
import { syncKpiSource, type KpiSource } from './kpi-source-store';
import { readKpiMeta } from '../connectors/kpi-meta';
import { readKpiPostHog } from '../connectors/kpi-posthog';
import { readKpiWixEmail } from '../connectors/kpi-wix-email';
/** Runs inside the existing tick. Source systems remain read-only; only the existing private aggregate tables are updated. */
export async function synchronizeKpi(source: KpiSource, options: { db: Database; env: NodeJS.ProcessEnv; fetcher: typeof fetch; signal?: AbortSignal; from?: string; to?: string }) {
 const { db, env, fetcher } = options;
 const today = Temporal.Now.plainDateISO('Europe/Paris'), from = options.from ?? today.subtract({ days: 35 }).toString(), to = options.to ?? today.add({ days: 1 }).toString();
 const namespace = source === 'meta' ? env.META_AD_ACCOUNT_ID?.replace(/^act_/, '') : source === 'posthog' ? env.POSTHOG_PROJECT_ID : env.WIX_SITE_ID;
 if (!namespace) throw new Error('KPI_NAMESPACE_MISSING');
 const read = source === 'meta' ? readKpiMeta : source === 'posthog' ? readKpiPostHog : readKpiWixEmail;
 return syncKpiSource(db, source, namespace, from, to, () => source === 'wix' ? readKpiWixEmail(from, to, env, fetcher, options.signal) : read(from, to, env, fetcher));
}
