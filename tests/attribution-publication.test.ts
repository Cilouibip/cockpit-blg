import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishAttribution, type AttributionReferences } from '../src/lib/attribution';
import type { Database, Row, SelectOptions, TableName } from '../src/lib/db';
import { AppError } from '../src/lib/errors';
import type { AttributionInput } from '../src/domain/attribution';
import { parisPeriod } from '../src/domain/dates';
import { evidenceKey } from '../src/domain/metrics';
import type { Payment, Touchpoint } from '../src/domain/models';

const ids = {
  person: '11111111-1111-4111-8111-111111111111',
  lead: '22222222-2222-4222-8222-222222222222',
  payment: '33333333-3333-4333-8333-333333333333',
  event: '44444444-4444-4444-8444-444444444444',
  ad: '55555555-5555-4555-8555-555555555555',
  run: '66666666-6666-4666-8666-666666666666',
};

function fixture() {
  const cohort = parisPeriod('2026-01-01', '2026-02-01');
  const evidence = {
    accountId: 'synthetic-account', observedAt: '2026-06-01T00:00:00Z',
    connectorVersion: 'synthetic-v1',
  };
  const payment: Payment = {
    ...evidence, source: 'wix', externalId: 'receipt-test', personId: ids.person,
    kind: 'payment', status: 'settled', effectiveAt: '2026-01-10T12:00:00Z',
    amount: { minor: 10000, currency: 'EUR' }, taxBasis: 'gross',
  };
  const touch: Touchpoint = {
    ...evidence, source: 'first_party', externalId: 'arrival-test', personId: ids.person,
    eventType: 'landing_arrival', occurredAt: '2026-01-08T12:00:00Z',
    sourceType: 'paid', linkRevisionId: null, adId: 'ad-A', campaignId: 'campaign-A',
  };
  const covered = { complete: true, from: '2025-11-01T00:00:00Z', to: '2026-06-01T00:00:00Z' };
  const input: AttributionInput = {
    policy: { method: 'last_non_direct', windowDays: 30, observationDays: 90, version: 'v1', cohort },
    acquiredAt: { [ids.person]: '2026-01-09T12:00:00Z' },
    newCustomerEvidence: {
      [ids.person]: { firstReceiptKey: evidenceKey(payment), firstReceiptAt: payment.effectiveAt, evidence: 'synthetic-history' },
    },
    payments: [payment], touches: [touch], currency: 'EUR',
    spend: { minor: 5000, currency: 'EUR' }, spendCohort: cohort,
    coverage: {
      identities: true, history: true, firstCustomer: true, refunds: true, mappings: true,
      touches: covered, payments: covered, spend: covered,
    },
    observedThrough: covered.to,
    manifest: {
      identitySnapshotIds: ['test-identity'], mappingSnapshotIds: ['test-mapping'],
      costSnapshotIds: ['test-cost'], coverageSnapshotIds: ['test-coverage'], inputCutoffAt: covered.to,
    },
  };
  const refs: AttributionReferences = {
    paidAccountId: 'synthetic-meta-account',
    acquisitionByPerson: { [ids.person]: { kind: 'lead', id: ids.lead } },
    paymentByEvidence: { [evidenceKey(payment)]: ids.payment },
    eventByEvidence: { [evidenceKey(touch)]: ids.event },
    adByExternal: { 'ad-A': ids.ad },
    scope: { source: 'all', tunnel: 'all', campaign: '' },
  };
  const ad: Row = {
    id: ids.ad, source: 'meta', source_namespace: refs.paidAccountId,
    external_id: 'ad-A', campaign_id: 'campaign-A',
  };
  return { input, refs, ad };
}

function databaseStub(adRows: Row[]) {
  const calls: { name: string; args: Row }[] = [];
  const reads: { table: TableName; options?: SelectOptions }[] = [];
  const db: Database = {
    async select(table, options) { reads.push({ table, options }); return adRows; },
    async upsert() { assert.fail('Publisher must use the atomic publication RPC'); },
    async probe() { assert.fail('No connection probe expected'); },
    async rpc<T>(name: string, args: Row) { calls.push({ name, args }); return ids.run as T; },
  };
  return { db, calls, reads };
}

const errorCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.status === 422 && error.code === code;

test('Publication refuses every filtered scope before reading or publishing a global cohort', async () => {
  const scopes: AttributionReferences['scope'][] = [
    { source: 'paid', tunnel: 'all', campaign: '' },
    { source: 'all', tunnel: 'quiz', campaign: '' },
    { source: 'all', tunnel: 'all', campaign: 'meta:campaign-B' },
  ];
  for (const scope of scopes) {
    const { input, refs, ad } = fixture();
    const { db, calls, reads } = databaseStub([ad]);
    await assert.rejects(publishAttribution(db, input, { ...refs, scope }), errorCode('attribution_scope'));
    assert.equal(calls.length, 0, JSON.stringify(scope));
    assert.equal(reads.length, 0, JSON.stringify(scope));
  }
});

test('Publication refuses absent or incompatible persisted ads without publishing a paid result', async () => {
  const { ad } = fixture();
  const cases: { label: string; refs?: Partial<AttributionReferences>; rows: Row[] }[] = [
    { label: 'missing mapping', refs: { adByExternal: {} }, rows: [ad] },
    { label: 'invalid mapping UUID', refs: { adByExternal: { 'ad-A': 'not-a-uuid' } }, rows: [ad] },
    { label: 'missing account', refs: { paidAccountId: '' }, rows: [ad] },
    { label: 'absent persisted ad', rows: [] },
    { label: 'ambiguous persisted ad', rows: [ad, ad] },
    { label: 'different source', rows: [{ ...ad, source: 'wix' }] },
    { label: 'different account', rows: [{ ...ad, source_namespace: 'another-account' }] },
    { label: 'different ad', rows: [{ ...ad, external_id: 'ad-B' }] },
    { label: 'different campaign', rows: [{ ...ad, campaign_id: 'campaign-B' }] },
  ];
  for (const scenario of cases) {
    const { input, refs } = fixture();
    const { db, calls } = databaseStub(scenario.rows);
    await assert.rejects(
      publishAttribution(db, input, { ...refs, ...scenario.refs }),
      errorCode('attribution_reference'), scenario.label,
    );
    assert.equal(calls.length, 0, scenario.label);
  }
});

test('Complete persisted mapping publishes one anchored receipt without counting the new-customer target as revenue', async () => {
  const { input, refs, ad } = fixture();
  const { db, calls, reads } = databaseStub([ad]);
  const outcome = await publishAttribution(db, input, refs);
  assert.equal(outcome.available, true);
  assert.equal(outcome.runId, ids.run);
  assert.deepEqual(reads, [{ table: 'ads', options: { eq: { id: ids.ad }, limit: 2 } }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'publish_attribution');
  const run = calls[0].args.p_run as Row;
  assert.deepEqual(run.scope, { source: 'all', tunnel: 'all', campaign: '' });
  assert.deepEqual((run.input_manifest as Row).spend, { minor: 5000, currency: 'EUR' });
  const results = calls[0].args.p_results as Row[];
  assert.deepEqual(results.map(row => row.target_kind).sort(), ['acquisition', 'new_customer', 'payment']);
  for (const row of results) {
    assert.equal(row.person_id, ids.person);
    assert.equal(row.ad_id, ids.ad);
    assert.equal(row.selected_event_id, ids.event);
    assert.equal(row.status, 'attributed');
  }
  const anchor = results.find(row => row.target_kind === 'acquisition')!;
  const receipt = results.find(row => row.target_kind === 'payment')!;
  const customer = results.find(row => row.target_kind === 'new_customer')!;
  assert.equal(anchor.lead_registration_id, ids.lead);
  assert.equal(anchor.contribution_minor, null);
  assert.equal(receipt.payment_id, ids.payment);
  assert.equal(receipt.anchor_result_id, anchor.id);
  assert.equal(receipt.contribution_minor, 10000);
  assert.equal(customer.payment_id, ids.payment);
  assert.equal(customer.anchor_result_id, anchor.id);
  assert.equal(customer.contribution_minor, null);
});
