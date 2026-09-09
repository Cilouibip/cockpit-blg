import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributeCohort, type AttributionInput } from '../src/domain/attribution';
import {
  prepareAttributionScope, type AttributionScopeEvidence, type AttributionScopeRequest,
  type ScopeCostEvidence, type PreparedAttributionScope,
} from '../src/domain/attribution-scope';
import { parisPeriod } from '../src/domain/dates';
import { evidenceKey } from '../src/domain/metrics';
import type { Payment, Touchpoint } from '../src/domain/models';

function fixture() {
  const cohort = parisPeriod('2026-03-28', '2026-03-31');
  const cutoff = '2026-08-01T00:00:00Z';
  const base = { observedAt: cutoff, connectorVersion: 'synthetic-v1' };
  const receipt = (personId: string, accountId: string, amount: number): Payment => ({
    ...base, source: 'wix', accountId, externalId: 'same-receipt-id', personId,
    kind: 'payment', status: 'settled', effectiveAt: '2026-03-30T12:00:00Z',
    amount: { minor: amount, currency: 'EUR' }, taxBasis: 'gross',
  });
  const a = receipt('person-A', 'wix-one', 10000);
  const b = receipt('person-switch', 'wix-two', 50000);
  const touch = (externalId: string, personId: string, occurredAt: string, adId: string, campaignId: string): Touchpoint => ({
    ...base, source: 'first_party', accountId: 'browser-site', externalId, personId,
    eventType: 'landing_arrival', occurredAt, sourceType: 'paid', adId, campaignId, linkRevisionId: null,
  });
  const touches = [
    touch('A-earlier-B', 'person-A', '2026-03-28T09:00:00Z', 'external-B', 'campaign-B'),
    touch('A-selected-A', 'person-A', '2026-03-28T12:00:00Z', 'external-A', 'campaign-A'),
    touch('switch-earlier-A', 'person-switch', '2026-03-28T16:00:00Z', 'external-A', 'campaign-A'),
    touch('switch-selected-B', 'person-switch', '2026-03-29T10:00:00Z', 'external-B', 'campaign-B'),
    { ...touch('organic-contact', 'person-organic', '2026-03-29T10:00:00Z', '', ''), sourceType: 'organic' as const, adId: null, campaignId: null },
  ];
  const coverage = { complete: true, from: '2026-01-01T00:00:00Z', to: cutoff };
  const global: AttributionInput = {
    policy: { method: 'last_non_direct', windowDays: 30, observationDays: 90, version: 'v1', cohort },
    acquiredAt: { 'person-A': '2026-03-29T12:00:00Z', 'person-switch': '2026-03-29T12:00:00Z', 'person-organic': '2026-03-29T12:00:00Z' },
    newCustomerEvidence: {
      'person-A': { firstReceiptKey: evidenceKey(a), firstReceiptAt: a.effectiveAt, evidence: 'synthetic-history-A' },
      'person-switch': { firstReceiptKey: evidenceKey(b), firstReceiptAt: b.effectiveAt, evidence: 'synthetic-history-B' },
    },
    payments: [
      a, b,
      { ...a, externalId: 'second-installment', installmentId: 'installment-2', effectiveAt: '2026-04-02T12:00:00Z', amount: { minor: 3000, currency: 'EUR' } },
      { ...a, externalId: 'late-refund', personId: null, kind: 'refund', originalPaymentId: a.externalId, effectiveAt: '2026-07-15T12:00:00Z', amount: { minor: 2500, currency: 'EUR' } },
      { ...b, externalId: 'late-refund', personId: null, kind: 'refund', originalPaymentId: b.externalId, effectiveAt: '2026-07-15T12:00:00Z', amount: { minor: 5000, currency: 'EUR' } },
    ],
    touches, currency: 'EUR', spend: { minor: 21000, currency: 'EUR' }, spendCohort: cohort,
    coverage: { identities: true, history: true, firstCustomer: true, refunds: true, mappings: true, touches: coverage, payments: coverage, spend: coverage },
    observedThrough: cutoff,
    manifest: { identitySnapshotIds: ['identity-v1'], mappingSnapshotIds: ['mapping-v1'], costSnapshotIds: ['global-cost-v1'], coverageSnapshotIds: ['coverage-v1'], inputCutoffAt: cutoff },
  };
  const ads = [
    { id: 'ad-A', external_id: 'external-A', campaign_id: 'campaign-A', creative_id: 'creative-A' },
    { id: 'ad-no-sale', external_id: 'external-no-sale', campaign_id: 'campaign-A', creative_id: 'creative-A' },
    { id: 'ad-B', external_id: 'external-B', campaign_id: 'campaign-B', creative_id: 'creative-B' },
  ].map(ad => ({ ...ad, source: 'meta', source_namespace: 'meta-one' }));
  const daily: ScopeCostEvidence[] = ['2026-03-28', '2026-03-29', '2026-03-30'].flatMap(date => ads.map((ad, index) => ({
    id: `${ad.id}-${date}`, ad_id: ad.id, date, sync_run_id: 'run-one',
    spend_minor: [1000, 2000, 4000][index], currency: 'EUR', currency_exponent: 2,
    timezone: 'Europe/Paris', base_profile_key: 'ad-day-no-breakdown-v1', campaign_id: ad.campaign_id,
  })));
  const evidence: AttributionScopeEvidence = {
    accountId: 'meta-one', ads, daily,
    syncRuns: [{
      id: 'run-one', source: 'meta', source_namespace: 'meta-one', stream_key: 'ad_daily',
      query_profile_key: 'v23.0-ad-day-none', status: 'complete', pagination_complete: true,
      date_from: '2026-03-28', date_to: '2026-03-31', covered_from: cohort.from, covered_to: cohort.to,
      rows_rejected: 0, source_as_of: '2026-04-01T00:00:00Z', started_at: '2026-04-01T00:00:00Z',
    }],
    readsComplete: { ads: true, daily: true, syncRuns: true },
  };
  const scope: AttributionScopeRequest = { source: 'paid', tunnel: 'all', campaign: 'meta:campaign-A' };
  return { global, evidence, scope };
}
function success(result: PreparedAttributionScope) {
  if (!result.ok) assert.fail(`${result.code}: ${result.reason}`);
  return result;
}
function rejected(args: ReturnType<typeof fixture>, code: string) {
  const result = prepareAttributionScope(args);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, code, result.reason);
}

test('Campaign selection follows global anchors and keeps competing candidate contacts intact', () => {
  const args = fixture(), before = structuredClone(args);
  const result = success(prepareAttributionScope(args));
  assert.deepEqual(result.proof.eligiblePersonIds, ['person-A']);
  assert.deepEqual(Object.keys(result.input.acquiredAt), ['person-A']);
  assert.deepEqual(result.input.touches.map(touch => touch.externalId), ['A-earlier-B', 'A-selected-A']);
  assert.equal(result.proof.globalSelectedEvidenceByPerson['person-switch'], evidenceKey(args.global.touches[3]));
  const calculation = attributeCohort(result.input);
  assert.equal(calculation.available, true);
  assert.equal(calculation.anchors[0].selected?.adId, 'external-A');
  assert.equal(calculation.results.some(row => row.personId === 'person-switch'), false);
  assert.deepEqual(args, before);
  result.input.touches[0].adId = 'mutated';
  result.proof.adSnapshots[0].campaign_id = 'mutated';
  result.proof.costSnapshots[0].spend_minor = 99;
  assert.deepEqual(args, before, 'Output evidence must be detached from the global input');
});

test('Full campaign costs include ads with no sales and each Paris day across DST', () => {
  const result = success(prepareAttributionScope(fixture()));
  assert.equal(result.input.spend?.minor, 9000);
  assert.deepEqual(result.proof.adIds, ['ad-A', 'ad-no-sale']);
  assert.equal(result.proof.costRowIds.length, 6);
  assert.equal(result.proof.accountCostRowIds.length, 9);
  assert.equal(result.proof.costSnapshots.length, 9);
  assert.equal(result.proof.runSnapshots.length, 1);
  assert.deepEqual(result.proof.days.map(day => day.date), ['2026-03-28', '2026-03-29', '2026-03-30']);
  assert.equal((Date.parse(result.proof.cohort.to) - Date.parse(result.proof.cohort.from)) / 3600000, 71);
});

test('Installments and late anonymous refunds inherit only the selected original receipt namespace', () => {
  const result = success(prepareAttributionScope(fixture()));
  assert.equal(result.input.payments.length, 3);
  assert.equal(result.input.payments.every(payment => payment.accountId === 'wix-one'), true);
  const calculation = attributeCohort(result.input);
  assert.equal(calculation.available, true);
  assert.deepEqual(calculation.results.map(row => row.netMinor), [10000, 3000, -2500]);
  assert.equal(calculation.attributedPaidRevenue?.minor, 10500);
  assert.equal(calculation.roas, 10500 / 9000);
});

test('Ad scope with no conversions retains its explicit costs and yields zero attributed revenue', () => {
  const args = fixture(); args.scope.campaign = 'meta-ad:external-no-sale';
  const result = success(prepareAttributionScope(args));
  assert.deepEqual(result.proof.eligiblePersonIds, []);
  assert.equal(result.input.spend?.minor, 6000);
  const calculated = attributeCohort(result.input);
  assert.equal(calculated.available, true);
  assert.equal(calculated.attributedPaidRevenue?.minor, 0);
  assert.equal(calculated.roas, 0);
});

test('All and paid scopes share all account costs while organic people stay only in all', () => {
  const args = fixture(); args.scope.campaign = '';
  const paid = success(prepareAttributionScope(args));
  assert.deepEqual(paid.proof.eligiblePersonIds, ['person-A', 'person-switch']);
  args.scope.source = 'all';
  const all = success(prepareAttributionScope(args));
  assert.deepEqual(all.proof.eligiblePersonIds, ['person-A', 'person-organic', 'person-switch']);
  assert.equal(all.input.spend?.minor, 21000);
  assert.equal(paid.input.spend?.minor, all.input.spend?.minor);
});

test('Creative scope combines persisted ads and refuses incomplete creative metadata', () => {
  const args = fixture(); args.scope.campaign = 'meta-creative:creative-A';
  const result = success(prepareAttributionScope(args));
  assert.equal(result.input.spend?.minor, 9000);
  assert.deepEqual(result.proof.adIds, ['ad-A', 'ad-no-sale']);
  assert.equal(result.proof.adSnapshots.filter(ad => ad.creative_id === 'creative-A').length, 2);
  args.evidence.ads = args.evidence.ads.map(ad => ad.id === 'ad-no-sale' ? { ...ad, creative_id: null } : ad);
  rejected(args, 'creative_metadata_missing');
});

test('Unsupported source, tunnel and link selectors are refused rather than silently ignored', () => {
  const scopes: AttributionScopeRequest[] = [
    { source: 'organic', tunnel: 'all', campaign: '' },
    { source: 'unknown', tunnel: 'all', campaign: '' },
    { source: 'paid', tunnel: 'quiz', campaign: 'meta:campaign-A' },
    { source: 'all', tunnel: 'masterclass', campaign: 'meta:campaign-A' },
    { source: 'paid', tunnel: 'all', campaign: 'link:campaign-A' },
    { source: 'paid', tunnel: 'all', campaign: 'meta:' },
  ];
  for (const scope of scopes) rejected({ ...fixture(), scope }, 'unsupported_scope');
});

test('No filtered calculation can conceal incomplete or indeterminate global attribution', () => {
  const incomplete = fixture(); incomplete.global.coverage.identities = false;
  rejected(incomplete, 'global_unavailable');
  const ambiguous = fixture();
  ambiguous.global.touches = [...ambiguous.global.touches, { ...ambiguous.global.touches[3], externalId: 'tied-contact', adId: 'external-A', campaignId: 'campaign-A' }];
  rejected(ambiguous, 'global_unavailable');
  const immature = fixture(); immature.global.observedThrough = '2026-05-01T00:00:00Z'; immature.global.manifest.inputCutoffAt = immature.global.observedThrough;
  rejected(immature, 'global_unavailable');
});

test('Incomplete database reads and daily coverage cannot produce a scoped cost', () => {
  for (const key of ['ads', 'daily', 'syncRuns'] as const) {
    const args = fixture(); args.evidence.readsComplete[key] = false; rejected(args, 'incomplete_reads');
  }
  for (const patch of [
    { status: 'failed' }, { status: 'partial' }, { status: 'empty' }, { pagination_complete: false },
    { rows_rejected: 1 }, { covered_from: '2026-03-28T12:00:00Z' }, { covered_to: '2026-03-30T12:00:00Z' },
    { date_to: '2026-03-30' }, { stream_key: 'campaign_daily' },
  ]) {
    const args = fixture(); args.evidence.syncRuns = [{ ...args.evidence.syncRuns[0], ...patch }]; rejected(args, 'cost_coverage');
  }
});

test('Missing account or campaign days are not zero; explicit zero rows remain zero', () => {
  const accountGap = fixture(); accountGap.evidence.daily = accountGap.evidence.daily.filter(row => row.date !== '2026-03-29');
  rejected(accountGap, 'cost_missing');
  const campaignGap = fixture(); campaignGap.evidence.daily = campaignGap.evidence.daily.filter(row => row.date !== '2026-03-29' || row.ad_id === 'ad-B');
  rejected(campaignGap, 'cost_missing');
  const zero = fixture();
  zero.evidence.daily = zero.evidence.daily.map(row => row.ad_id === 'ad-B' ? row : { ...row, spend_minor: 0 });
  zero.global.spend = { minor: 12000, currency: 'EUR' };
  const result = success(prepareAttributionScope(zero));
  assert.equal(result.input.spend?.minor, 0);
  assert.equal(attributeCohort(result.input).roas, null);
});

test('Persisted metadata, money units and query profiles must be coherent across the account', () => {
  for (const patch of [
    { currency: 'USD' }, { currency_exponent: 0 }, { timezone: 'UTC' }, { base_profile_key: 'ad-day-breakdown' },
  ]) {
    const args = fixture(); args.evidence.daily = [{ ...args.evidence.daily[0], ...patch }, ...args.evidence.daily.slice(1)]; rejected(args, 'cost_profile');
  }
  for (const value of [null, -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    const args = fixture(); args.evidence.daily = [{ ...args.evidence.daily[0], spend_minor: value }, ...args.evidence.daily.slice(1)]; rejected(args, 'cost_missing');
  }
  for (const profile of ['v22.0-ad-day-none', 'v23.0-campaign-day-none', 'v23.0-ad-day-filtered']) {
    const args = fixture(); args.evidence.syncRuns = [{ ...args.evidence.syncRuns[0], query_profile_key: profile }]; rejected(args, 'cost_profile');
  }
  const mixed = fixture(); mixed.evidence.ads = [{ ...mixed.evidence.ads[0], source_namespace: 'meta-two' }, ...mixed.evidence.ads.slice(1)];
  rejected(mixed, 'account_mismatch');
  const campaign = fixture(); campaign.evidence.ads = [{ ...campaign.evidence.ads[0], campaign_id: 'another-campaign' }, ...campaign.evidence.ads.slice(1)];
  rejected(campaign, 'mapping_incomplete');
});

test('Canonical cost rows cannot be doubled, mixed across runs, stale, or newer than the calculation cutoff', () => {
  const duplicate = fixture(); duplicate.evidence.daily = [...duplicate.evidence.daily, { ...duplicate.evidence.daily[0], id: 'duplicate-row' }];
  rejected(duplicate, 'cost_conflict');
  const stale = fixture(); stale.evidence.syncRuns = [...stale.evidence.syncRuns, { ...stale.evidence.syncRuns[0], id: 'run-newer', source_as_of: '2026-04-02T00:00:00Z' }];
  rejected(stale, 'cost_conflict');
  const newerEmpty = fixture(); newerEmpty.evidence.syncRuns = [...newerEmpty.evidence.syncRuns, { ...newerEmpty.evidence.syncRuns[0], id: 'run-newer', source_as_of: '2026-04-02T00:00:00Z', status: 'empty' }];
  rejected(newerEmpty, 'cost_coverage');
  const future = fixture(); future.evidence.syncRuns = [{ ...future.evidence.syncRuns[0], source_as_of: '2026-09-01T00:00:00Z' }];
  rejected(future, 'cost_after_cutoff');
  const profileChange = fixture();
  profileChange.evidence.syncRuns = [...profileChange.evidence.syncRuns, {
    ...profileChange.evidence.syncRuns[0], id: 'run-newer', date_from: '2026-03-30',
    query_profile_key: 'v24.0-ad-day-none', source_as_of: '2026-04-02T00:00:00Z',
  }];
  profileChange.evidence.daily = profileChange.evidence.daily.map(row => row.date === '2026-03-30' ? { ...row, sync_run_id: 'run-newer' } : row);
  rejected(profileChange, 'cost_profile');
});

test('Cost input must reconcile to the global account spend before a filtered report is prepared', () => {
  const args = fixture();
  // Omitting a nonconverting ad on one day still leaves an observed campaign day.
  args.evidence.daily = args.evidence.daily.filter(row => row.id !== 'ad-no-sale-2026-03-29');
  rejected(args, 'cost_conflict');
});
