import { Temporal } from '@js-temporal/polyfill';
import { attributeCohort, type AttributionInput } from './attribution';
import { startOfParisDay, validInstant } from './dates';
import { evidenceKey } from './metrics';

export interface AttributionScopeRequest {
  source: 'all' | 'paid' | 'organic' | 'unknown';
  tunnel: 'all' | 'quiz' | 'masterclass';
  /** Empty, meta:<campaign>, meta-ad:<external ad>, or meta-creative:<creative>. */
  campaign: string;
}
export interface ScopeAdEvidence {
  id: string; source: string; source_namespace: string; external_id: string;
  campaign_id: string | null; creative_id?: string | null;
}
export interface ScopeCostEvidence {
  id: string; ad_id: string; sync_run_id: string; date: string;
  spend_minor: number | null; currency: string; currency_exponent: number;
  timezone: string; base_profile_key: string; campaign_id?: string | null;
}
export interface ScopeSyncEvidence {
  id: string; source: string; source_namespace: string; stream_key: string;
  query_profile_key: string; status: string; pagination_complete: boolean;
  date_from: string | null; date_to: string | null;
  covered_from: string | null; covered_to: string | null;
  rows_rejected: number; source_as_of: string; started_at: string;
}
export interface AttributionScopeEvidence {
  accountId: string;
  /** Complete account metadata and canonical v_ad_daily rows, never prefiltered by conversions. */
  ads: readonly ScopeAdEvidence[];
  daily: readonly ScopeCostEvidence[];
  syncRuns: readonly ScopeSyncEvidence[];
  /** Set only by the trusted adapter after complete database reads; not browser input. */
  readsComplete: { ads: boolean; daily: boolean; syncRuns: boolean };
}
export interface AttributionScopeProof {
  version: 'attribution-scope-v1'; scope: AttributionScopeRequest; accountId: string;
  queryProfileKey: string; baseProfileKey: 'ad-day-no-breakdown-v1';
  currency: 'EUR'; timezone: 'Europe/Paris';
  cohort: NonNullable<AttributionInput['policy']>['cohort']; inputCutoffAt: string;
  adIds: string[]; costRowIds: string[]; accountCostRowIds: string[]; syncRunIds: string[];
  /** Detached values explain a historical scope even after mutable ad metadata changes. */
  adSnapshots: ScopeAdEvidence[]; costSnapshots: ScopeCostEvidence[]; runSnapshots: ScopeSyncEvidence[];
  days: { date: string; syncRunId: string; accountCostRowIds: string[]; costRowIds: string[] }[];
  eligiblePersonIds: string[];
  globalSelectedEvidenceByPerson: Record<string, string | null>;
  globalManifest: AttributionInput['manifest'];
  spendMinor: number;
}
export type AttributionScopeErrorCode =
  | 'unsupported_scope' | 'global_unavailable' | 'incomplete_reads' | 'account_mismatch'
  | 'mapping_incomplete' | 'creative_metadata_missing' | 'cost_coverage' | 'cost_missing'
  | 'cost_profile' | 'cost_conflict' | 'cost_after_cutoff' | 'invalid_input';
export type PreparedAttributionScope =
  | { ok: true; input: AttributionInput; proof: AttributionScopeProof }
  | { ok: false; code: AttributionScopeErrorCode; reason: string };

class ScopeError extends Error {
  constructor(readonly code: AttributionScopeErrorCode, message: string) { super(message); }
}
function fail(code: AttributionScopeErrorCode, reason: string): never { throw new ScopeError(code, reason); }
const baseProfile = 'ad-day-no-breakdown-v1' as const;
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
function unique<T>(rows: readonly T[], key: (row: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    const id = key(row);
    if (!id || map.has(id)) fail('cost_conflict', 'Références absentes ou en double dans les preuves.');
    map.set(id, row);
  }
  return map;
}
function calendarDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('invalid_input', 'Une date journalière est invalide.');
  return Temporal.PlainDate.from(value);
}

/** Pure preparation. The publisher must separately authenticate provenance of this result. */
export function prepareAttributionScope(args: {
  global: AttributionInput; scope: AttributionScopeRequest; evidence: AttributionScopeEvidence;
}): PreparedAttributionScope {
  try { return prepare(args); }
  catch (error) {
    return error instanceof ScopeError
      ? { ok: false, code: error.code, reason: error.message }
      : { ok: false, code: 'invalid_input', reason: 'Les entrées ne respectent pas le contrat du préparateur.' };
  }
}

function prepare({ global, scope, evidence }: Parameters<typeof prepareAttributionScope>[0]): PreparedAttributionScope {
  if (!['all', 'paid'].includes(scope.source) || scope.tunnel !== 'all' ||
      Object.keys(scope).some(key => !['source', 'tunnel', 'campaign'].includes(key))) {
    fail('unsupported_scope', 'Ce périmètre source ou tunnel ne dispose pas de preuves de coûts V1.');
  }
  const selector = scope.campaign === '' ? null : /^(meta|meta-ad|meta-creative):([^:\s]+)$/.exec(scope.campaign);
  if (scope.campaign !== '' && !selector) fail('unsupported_scope', 'Le périmètre doit désigner une campagne, une publicité ou une créative Meta persistée.');
  if (!evidence.readsComplete.ads || !evidence.readsComplete.daily || !evidence.readsComplete.syncRuns) {
    fail('incomplete_reads', 'La lecture complète des preuves du compte est requise.');
  }

  // This MUST precede person filtering: A then B remains attributed to B in an A report.
  const globalResult = attributeCohort(global);
  if (!globalResult.available || !global.policy) fail('global_unavailable', globalResult.reason || 'Attribution globale indisponible.');
  const cohort = global.policy.cohort;
  if (global.currency !== 'EUR' || cohort.timezone !== 'Europe/Paris') fail('cost_profile', 'Le périmètre V1 exige des euros et le calendrier Europe/Paris.');
  const from = Temporal.Instant.from(cohort.from).toZonedDateTimeISO('Europe/Paris').toPlainDate();
  const to = Temporal.Instant.from(cohort.to).toZonedDateTimeISO('Europe/Paris').toPlainDate();
  if (validInstant(startOfParisDay(from.toString())) !== validInstant(cohort.from) ||
      validInstant(startOfParisDay(to.toString())) !== validInstant(cohort.to) || Temporal.PlainDate.compare(from, to) >= 0) {
    fail('cost_coverage', 'La cohorte doit couvrir des jours complets de Paris.');
  }
  const dayStrings: string[] = [];
  for (let day = from; Temporal.PlainDate.compare(day, to) < 0; day = day.add({ days: 1 })) dayStrings.push(day.toString());

  if (!evidence.accountId || evidence.ads.some(ad => ad.source !== 'meta' || ad.source_namespace !== evidence.accountId) ||
      evidence.syncRuns.some(run => run.source !== 'meta' || run.source_namespace !== evidence.accountId)) {
    fail('account_mismatch', 'Les preuves doivent appartenir à un compte Meta unique.');
  }
  const ads = unique(evidence.ads, ad => ad.id);
  const adsByExternal = unique(evidence.ads, ad => ad.external_id);
  unique(evidence.syncRuns, run => run.id);
  if (selector?.[1] === 'meta-creative' && evidence.ads.some(ad => !ad.creative_id)) {
    fail('creative_metadata_missing', 'Les métadonnées de créative sont incomplètes dans le compte.');
  }
  const scopedAds = evidence.ads.filter(ad => !selector ||
    (selector[1] === 'meta' ? ad.campaign_id === selector[2] :
      selector[1] === 'meta-ad' ? ad.external_id === selector[2] : ad.creative_id === selector[2]));
  if (scopedAds.length === 0) fail(selector?.[1] === 'meta-creative' ? 'creative_metadata_missing' : 'mapping_incomplete', 'Aucune publicité persistée ne justifie ce périmètre.');
  const scopedAdIds = new Set(scopedAds.map(ad => ad.id));
  const eligible = new Set<string>();
  const selectedEvidence: Record<string, string | null> = {};
  for (const anchor of globalResult.anchors) {
    const selected = anchor.selected;
    selectedEvidence[anchor.personId] = selected ? evidenceKey(selected) : null;
    let ad: ScopeAdEvidence | undefined;
    if (selected?.sourceType === 'paid') {
      ad = selected.adId ? adsByExternal.get(selected.adId) : undefined;
      if (!ad || !ad.campaign_id || ad.campaign_id !== selected.campaignId) {
        fail('mapping_incomplete', 'Un contact payant global ne correspond pas à une publicité et une campagne du compte.');
      }
    }
    if (anchor.inCohort && selected && (!selector || (ad && scopedAdIds.has(ad.id))) &&
        (scope.source === 'all' || selected.sourceType === 'paid')) eligible.add(anchor.personId);
  }

  const cutoff = validInstant(global.manifest.inputCutoffAt);
  const accountRows = evidence.daily.filter(row => {
    calendarDay(row.date);
    return row.date >= from.toString() && row.date < to.toString();
  });
  unique(accountRows, row => row.id);
  unique(accountRows, row => `${row.ad_id}:${row.date}`);
  let accountSpendMinor = 0;
  for (const row of accountRows) {
    const ad = ads.get(row.ad_id);
    if (!ad || !ad.campaign_id || (row.campaign_id !== undefined && row.campaign_id !== ad.campaign_id)) {
      fail('mapping_incomplete', 'Une mesure publicitaire ne possède pas de rattachement stable à sa campagne.');
    }
    if (row.currency !== 'EUR' || row.currency_exponent !== 2 || row.timezone !== 'Europe/Paris' || row.base_profile_key !== baseProfile) {
      fail('cost_profile', 'Les coûts mélangent des devises, fuseaux ou profils incompatibles.');
    }
    if (!Number.isSafeInteger(row.spend_minor) || row.spend_minor === null || row.spend_minor < 0) {
      fail('cost_missing', 'Une dépense est absente ou non représentable en centimes.');
    }
    accountSpendMinor += row.spend_minor;
    if (!Number.isSafeInteger(accountSpendMinor)) fail('cost_missing', 'La somme des coûts du compte dépasse la précision des centimes.');
  }

  const days: AttributionScopeProof['days'] = [];
  const profiles = new Set<string>();
  let spendMinor = 0;
  for (const date of dayStrings) {
    const start = validInstant(startOfParisDay(date));
    const end = validInstant(startOfParisDay(calendarDay(date).add({ days: 1 }).toString()));
    const candidates = evidence.syncRuns.filter(run => {
      if (run.stream_key !== 'ad_daily' || !['complete', 'empty'].includes(run.status) || !run.pagination_complete || !run.date_from || !run.date_to) return false;
      calendarDay(run.date_from); calendarDay(run.date_to);
      return run.date_from <= date && run.date_to > date;
    }).sort((a, b) => validInstant(b.source_as_of) - validInstant(a.source_as_of) ||
      validInstant(b.started_at) - validInstant(a.started_at) || b.id.localeCompare(a.id));
    const run = candidates[0];
    if (!run || run.status !== 'complete' || run.rows_rejected !== 0 || !run.covered_from || !run.covered_to ||
        validInstant(run.covered_from) > start || validInstant(run.covered_to) < end) {
      fail('cost_coverage', 'Chaque jour exige une synchronisation complète du compte ; un résultat vide ne vaut pas zéro.');
    }
    if (validInstant(run.source_as_of) > cutoff || validInstant(run.started_at) > cutoff) {
      fail('cost_after_cutoff', 'Les coûts canoniques sont postérieurs à la date limite du calcul.');
    }
    const profile = /^v(\d+)\.0-ad-day-none$/.exec(run.query_profile_key);
    if (!profile || Number(profile[1]) < 23) fail('cost_profile', 'Le profil doit prouver une requête complète du compte, par publicité et par jour.');
    profiles.add(run.query_profile_key);
    if (profiles.size > 1) fail('cost_profile', 'La cohorte mélange plusieurs profils de requête.');
    const dailyRows = accountRows.filter(row => row.date === date);
    if (dailyRows.some(row => row.sync_run_id !== run.id)) fail('cost_conflict', 'Les mesures ne proviennent pas de la synchronisation canonique du jour.');
    const scopedRows = dailyRows.filter(row => scopedAdIds.has(row.ad_id));
    if (dailyRows.length === 0 || scopedRows.length === 0) fail('cost_missing', 'Une journée ne contient aucune mesure explicite pour le compte ou le périmètre.');
    for (const row of scopedRows) {
      spendMinor += row.spend_minor!;
      if (!Number.isSafeInteger(spendMinor)) fail('cost_missing', 'La somme des dépenses dépasse la précision des centimes.');
    }
    days.push({ date, syncRunId: run.id, accountCostRowIds: sorted(dailyRows.map(row => row.id)), costRowIds: sorted(scopedRows.map(row => row.id)) });
  }
  if (accountSpendMinor !== global.spend?.minor) fail('cost_conflict', 'Les coûts complets du compte ne correspondent pas aux dépenses de la cohorte globale.');

  // Include all candidate contacts and all receipts for retained people. Late refunds with
  // no direct person_id inherit the original receipt via its full source namespace.
  const retainedReceipts = new Set(global.payments.filter(row => row.kind === 'payment' && row.personId && eligible.has(row.personId)).map(evidenceKey));
  const input = structuredClone(global);
  input.acquiredAt = Object.fromEntries(Object.entries(global.acquiredAt).filter(([person]) => eligible.has(person)));
  input.newCustomerEvidence = Object.fromEntries(Object.entries(global.newCustomerEvidence).filter(([person]) => eligible.has(person)));
  input.touches = global.touches.filter(touch => touch.personId && eligible.has(touch.personId));
  input.payments = global.payments.filter(row => (row.personId && eligible.has(row.personId)) ||
    (row.kind === 'refund' && row.originalPaymentId && retainedReceipts.has(evidenceKey({ ...row, externalId: row.originalPaymentId }))));
  input.spend = { minor: spendMinor, currency: 'EUR' };
  input.spendCohort = { ...cohort };
  input.coverage.spend = { complete: true, from: cohort.from, to: cohort.to, observedAt: global.manifest.inputCutoffAt };
  input.manifest.costSnapshotIds = sorted(days.flatMap(day => day.costRowIds));
  const proof: AttributionScopeProof = {
    version: 'attribution-scope-v1', scope: { ...scope }, accountId: evidence.accountId,
    queryProfileKey: [...profiles][0], baseProfileKey: baseProfile, currency: 'EUR', timezone: 'Europe/Paris',
    cohort: { ...cohort }, inputCutoffAt: global.manifest.inputCutoffAt,
    adIds: sorted(scopedAdIds), costRowIds: input.manifest.costSnapshotIds,
    accountCostRowIds: sorted(days.flatMap(day => day.accountCostRowIds)), syncRunIds: sorted(days.map(day => day.syncRunId)), days,
    adSnapshots: evidence.ads.map(ad => ({ ...ad })), costSnapshots: accountRows.map(row => ({ ...row })),
    runSnapshots: evidence.syncRuns.filter(run => days.some(day => day.syncRunId === run.id)).map(run => ({ ...run })),
    eligiblePersonIds: sorted(eligible), globalSelectedEvidenceByPerson: selectedEvidence,
    globalManifest: structuredClone(global.manifest), spendMinor,
  };
  // Return detached arrays so consumers cannot mutate the original global evidence.
  return { ok: true, input: structuredClone(input), proof: structuredClone(proof) };
}
