import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inPeriod, parisPeriod, startOfParisDay } from '../src/domain/dates';
import { appointmentMetrics, cashMetrics, contractedMetrics, evidenceKey, leadMetrics, moneyFromDecimal, newClientMetrics, ratio, sumMoney } from '../src/domain/metrics';
import { emailIdentity, normalizeEmail, resolveIdentity } from '../src/domain/identity';
import { browserEventSchema, serverLeadSchema, signIngestion, verifyIngestionSignature } from '../src/domain/ingestion';
import { watchedSeconds } from '../src/domain/video';
import { attributeCohort, type AttributionInput } from '../src/domain/attribution';
import type { Appointment, Evidence, Payment, Touchpoint } from '../src/domain/models';
import { advertisingCostPerAction } from '../src/domain/costs';

const evidence = (id: string): Evidence => ({ source: 'wix', accountId: 'synthetic-account', externalId: id, observedAt: '2026-09-07T10:00:00Z', connectorVersion: 'test-v1' });
const period = parisPeriod('2026-01-01', '2026-02-01');
const coverage = { ...period, complete: true };
const payment = (id: string, overrides: Partial<Payment> = {}): Payment => ({ ...evidence(id), personId: 'person-a', kind: 'payment', status: 'settled', effectiveAt: '2026-01-10T12:00:00Z', amount: { minor: 10000, currency: 'EUR' }, taxBasis: 'gross', ...overrides });

test('Paris calendar boundaries preserve 23h and 25h DST days and exclusive end', () => {
  const spring = parisPeriod('2026-03-29', '2026-03-30'), autumn = parisPeriod('2026-10-25', '2026-10-26');
  assert.equal((Date.parse(spring.to) - Date.parse(spring.from)) / 3600000, 23);
  assert.equal((Date.parse(autumn.to) - Date.parse(autumn.from)) / 3600000, 25);
  assert.equal(inPeriod(spring.from, spring), true); assert.equal(inPeriod(spring.to, spring), false);
  assert.throws(() => startOfParisDay('2026-02-30'));
  assert.throws(() => inPeriod('2026-01-01T12:00:00', period), /OFFSET/);
});

test('Money is exact, exponents explicit, fractional minor units and mixed currencies rejected', () => {
  assert.deepEqual(moneyFromDecimal('0.29', 'EUR', 2), { minor: 29, currency: 'EUR' });
  assert.equal(moneyFromDecimal('12.123', 'KWD', 3).minor, 12123);
  assert.equal(moneyFromDecimal('12', 'JPY', 0).minor, 12);
  assert.throws(() => moneyFromDecimal('12.001', 'EUR', 2), /UNREPRESENTABLE/);
  assert.throws(() => moneyFromDecimal('9007199254740992', 'JPY', 0), /OVERFLOW/);
  assert.throws(() => sumMoney([{ minor: 100, currency: 'EUR' }, { minor: 100, currency: 'USD' }], 'EUR'), /MIXED/);
});

test('Two tunnels and retries count one known person; unknown identities remain exposed', () => {
  const quiz = { ...evidence('registration-a'), personId: 'person-a', tunnel: 'quiz' as const, registeredAt: '2026-01-10T12:00:00Z', verified: true };
  const masterclass = { ...quiz, externalId: 'registration-b', tunnel: 'masterclass' as const };
  const result = leadMetrics([quiz, quiz, masterclass], period, coverage);
  assert.equal(result.registrations, 2); assert.equal(result.totalUniquePeople, 1);
  const unresolved = leadMetrics([quiz, { ...masterclass, personId: null }], period, coverage);
  assert.equal(unresolved.totalUniquePeople, null); assert.equal(unresolved.unresolvedRegistrations, 1);
  assert.equal(leadMetrics([{ ...quiz, verified: false }], period, coverage).registrations, 0);
});

test('Identity matching uses keyed HMAC; ambiguity, aliases and homonyms never silently merge', () => {
  const secret = 'synthetic-identity-key-only-'.repeat(2);
  assert.equal(emailIdentity(' Test.User@example.test ', secret), emailIdentity('test.user@EXAMPLE.TEST', secret));
  assert.notEqual(emailIdentity('test.user@example.test', secret), emailIdentity('testuser@example.test', secret));
  assert.notEqual(emailIdentity('test+one@example.test', secret), emailIdentity('test@example.test', secret));
  assert.equal(normalizeEmail(' A@EXAMPLE.TEST '), 'a@example.test');
  assert.deepEqual(resolveIdentity(['a', 'b']), { personId: null, state: 'ambiguous' });
  assert.deepEqual(resolveIdentity(['a', 'a']), { personId: 'a', state: 'resolved' });
  assert.throws(() => emailIdentity('a@example.test', 'short'));
});

test('Installments and late refunds are cash movements, not new acquisitions', () => {
  const installments = [payment('receipt-a'), payment('receipt-b', { installmentId: 'two' }), payment('receipt-c', { installmentId: 'three' })];
  const refund = payment('refund-a', { kind: 'refund', originalPaymentId: 'receipt-a', amount: { minor: 2500, currency: 'EUR' } });
  const result = cashMetrics([...installments, installments[0], refund, payment('pending', { status: 'pending' })], period, coverage);
  assert.deepEqual(result.byCurrency[0], { currency: 'EUR', received: 30000, refunded: 2500, net: 27500, normalizedNet: 27500, unresolvedTransactions: 0, unknownTaxBasis: 0, mixedTaxBasis: false });
  assert.equal(result.pending, 1);
  assert.equal(newClientMetrics(installments, period, { definition: 'first_settled_payment', historyComplete: true }).count, 1);
  assert.equal(newClientMetrics(installments, period, { definition: 'first_settled_payment', historyComplete: false }).count, null);
  assert.equal(newClientMetrics(installments, period, { definition: null, historyComplete: true }).count, null);
  assert.equal(cashMetrics([], period, coverage).missing, true);
  const later = payment('refund-late', { kind: 'refund', effectiveAt: '2026-02-03T12:00:00Z' });
  assert.equal(cashMetrics([later], parisPeriod('2026-02-01', '2026-03-01'), coverage).byCurrency[0].net, -10000);
  assert.equal(cashMetrics([installments[0], payment('incompatible-basis', { taxBasis: 'net' })], period, coverage).byCurrency[0].net, null);
  assert.equal(cashMetrics([payment('unknown-basis', { taxBasis: 'unknown' })], period, coverage).byCurrency[0].normalizedNet, null);
});

test('Same transaction ID in separate namespaces is two distinct records', () => {
  const rows = [payment('same'), payment('same', { accountId: 'other-account', amount: { minor: 8000, currency: 'USD' } })];
  const result = cashMetrics(rows, period, coverage);
  assert.equal(result.byCurrency.length, 2); assert.equal(result.byCurrency[0].net, 10000); assert.equal(result.byCurrency[1].net, 8000);
});

test('Advertising action cost names its action and refuses mismatched cohort or an invented full CAC', () => {
  const input = { action: 'new_customer' as const, spend: { minor: 10000, currency: 'EUR' }, actionCount: 2, spendCohort: period, actionCohort: period, complete: true, mature: true };
  assert.equal(advertisingCostPerAction(input).valueMinor, 5000); assert.equal(advertisingCostPerAction(input).completeCac, false);
  assert.equal(advertisingCostPerAction({ ...input, actionCount: 0 }).valueMinor, null);
  assert.equal(advertisingCostPerAction({ ...input, actionCohort: parisPeriod('2026-02-01', '2026-03-01') }).valueMinor, null);
});

test('Signed commitment is counted once and needs amount evidence and tax basis', () => {
  const deal = { ...evidence('deal'), personId: 'person-a', signedAt: '2026-01-02T10:00:00Z', amount: { minor: 30000, currency: 'EUR' }, status: 'signed' as const, amountEvidence: 'synthetic-contract', taxBasis: 'gross' as const };
  assert.equal(contractedMetrics([deal, deal], period).byCurrencyAndBasis[0].minor, 30000);
  assert.equal(contractedMetrics([{ ...deal, amountEvidence: null }], period).missingAmountOrBasis, 1);
});

test('Appointments preserve reports, attendance evidence and unknown outcomes', () => {
  const base: Appointment = { ...evidence('appointment'), source: 'notion', personId: 'person-a', scheduledAt: '2026-01-10T12:00:00Z', status: 'rescheduled', sourceStatus: 'Reporté', rescheduledTo: 'appointment-two' };
  const held = { ...base, externalId: 'appointment-two', status: 'attended' as const, attendedAt: '2026-01-12T12:00:00Z', attendanceEvidence: 'source-observation' };
  const absent = { ...base, externalId: 'appointment-three', personId: 'person-b', status: 'no_show' as const };
  const closed = { ...base, externalId: 'appointment-four', status: 'attended' as const, sourceStatus: 'Closé' };
  const result = appointmentMetrics([base, held, held, absent, closed], period);
  assert.equal(result.rescheduled, 1); assert.equal(result.attended, 1); assert.equal(result.unknown, 1); assert.equal(result.attendedPeople, 1);
  assert.deepEqual(result.showUp, { value: .5, numerator: 1, denominator: 2, reason: null });
  assert.equal(ratio(0, 0).value, null);
});

function browserEvent() { return { event_id: randomUUID(), schema_version: 1, occurred_at: '2026-09-07T12:00:00Z', anonymous_id: randomUUID(), session_id: randomUUID(), journey_id: randomUUID(), tunnel: 'quiz', link_revision_id: null, page_version: 'test-v1', event_name: 'quiz_question_answered', properties: { question_number: 12 } }; }
test('Browser ingestion refuses lead proof, identity, finance, health answers and unknown fields', () => {
  assert.equal(browserEventSchema.safeParse(browserEvent()).success, true);
  for (const invalid of [
    { ...browserEvent(), event_name: 'lead_registered' }, { ...browserEvent(), person_id: randomUUID() },
    { ...browserEvent(), trust_level: 'verified' }, { ...browserEvent(), amount: 10000 },
    { ...browserEvent(), properties: { question_number: 12, answer: 'private-answer' } },
    { ...browserEvent(), properties: { question_number: 13 } }, { ...browserEvent(), tunnel: 'masterclass' },
  ]) assert.equal(browserEventSchema.safeParse(invalid).success, false);
});

test('Signed lead API has a distinct schema, bounded signature age and unchanged raw payload', () => {
  const context = browserEvent();
  const body = { event_id: context.event_id, schema_version: 1, event_name: 'lead_registered', registered_at: context.occurred_at, tunnel: 'quiz', source: 'wix', source_account_id: 'test-site', external_id: 'registration-synthetic', journey_id: context.journey_id, anonymous_id: context.anonymous_id, session_id: context.session_id, link_revision_id: null, identity: { namespace: 'test-contact', external_id: 'contact-synthetic' } };
  assert.equal(serverLeadSchema.safeParse(body).success, true); assert.equal(browserEventSchema.safeParse(body).success, false);
  const raw = JSON.stringify(body), secret = 'test-ingest-secret-'.repeat(3), timestamp = '1788782400', now = Number(timestamp) * 1000;
  const signature = signIngestion(raw, timestamp, secret);
  assert.equal(verifyIngestionSignature(raw, timestamp, signature, secret, now), true);
  assert.equal(verifyIngestionSignature(raw + ' ', timestamp, signature, secret, now), false);
  assert.equal(verifyIngestionSignature(raw, timestamp, signature, secret, now + 301000), false);
  assert.equal(verifyIngestionSignature(raw, timestamp, 'short', secret, now), false);
});

test('Video seeks, overlaps and retries cannot become watched duration', () => {
  assert.equal(watchedSeconds([{ start: 0, end: 10 }, { start: 5, end: 15 }, { start: 50, end: 60 }, { start: 50, end: 60 }], 100), 25);
  assert.throws(() => watchedSeconds([{ start: 1, end: 110 }], 100));
  const event = { ...browserEvent(), tunnel: 'masterclass', event_name: 'video_watch', properties: { video_id: 'test-video', video_version: 'v1', playback_id: randomUUID(), duration: 100, intervals: [{ start: 5, end: 95 }] } };
  assert.equal(browserEventSchema.safeParse(event).success, false);
  event.properties.intervals = [{ start: 5, end: 10 }]; assert.equal(browserEventSchema.safeParse(event).success, true);
});

const touch = (id: string, occurredAt: string, sourceType: Touchpoint['sourceType'] = 'paid'): Touchpoint => ({ ...evidence(id), source: 'first_party', personId: 'person-a', occurredAt, eventType: 'landing_arrival', sourceType, linkRevisionId: null, adId: sourceType === 'paid' ? 'ad-synthetic' : null, campaignId: 'campaign-synthetic' });
function attributionInput(): AttributionInput {
  const first = payment('first');
  return { policy: { method: 'last_non_direct', windowDays: 30, observationDays: 90, version: 'review-v1', cohort: period }, acquiredAt: { 'person-a': '2026-01-09T12:00:00Z' }, newCustomerEvidence: { 'person-a': { firstReceiptKey: evidenceKey(first), firstReceiptAt: first.effectiveAt, evidence: 'history-complete' } },
    payments: [first], touches: [touch('arrival', '2026-01-08T12:00:00Z')], currency: 'EUR', spend: { minor: 5000, currency: 'EUR' }, spendCohort: period,
    coverage: { identities: true, history: true, firstCustomer: true, refunds: true, mappings: true, touches: { complete: true, from: '2025-11-01T00:00:00Z', to: '2026-06-01T12:00:00Z' }, payments: { complete: true, from: '2025-11-01T00:00:00Z', to: '2026-06-01T12:00:00Z' }, spend: coverage }, observedThrough: '2026-06-01T12:00:00Z', manifest: { identitySnapshotIds: ['identity-snapshot'], mappingSnapshotIds: ['mapping-snapshot'], costSnapshotIds: ['all-ads-spend-snapshot'], coverageSnapshotIds: ['coverage-snapshot'], inputCutoffAt: '2026-06-01T12:00:00Z' } };
}

test('Attribution uses one observed acquisition anchor and includes later refunds against it', () => {
  const input = attributionInput();
  input.payments = [...input.payments, payment('second', { effectiveAt: '2026-02-10T12:00:00Z' }), payment('late-refund', { kind: 'refund', originalPaymentId: 'first', effectiveAt: '2026-05-01T12:00:00Z', amount: { minor: 2500, currency: 'EUR' } })];
  input.touches = [...input.touches, touch('later-ad', '2026-02-09T12:00:00Z')];
  const result = attributeCohort(input);
  assert.equal(result.available, true); assert.equal(result.attributedPaidRevenue?.minor, 17500); assert.equal(result.roas, 3.5);
  assert.equal(new Set(result.results.map(row => row.touchpointKey)).size, 1);
  assert.equal(result.anchors[0].candidateEvidenceSnapshot.length, 1);
  assert.equal(result.results[2].targetSnapshot.kind, 'refund');
});

test('Organic contact beats earlier paid contact; sole direct contact remains direct', () => {
  const input = attributionInput(); input.touches = [...input.touches, touch('organic', '2026-01-09T10:00:00Z', 'organic')];
  assert.equal(attributeCohort(input).attributedPaidRevenue?.minor, 0);
  input.touches = [touch('direct', '2026-01-08T12:00:00Z', 'direct')];
  const result = attributeCohort(input); assert.equal(result.available, true); assert.equal(result.anchors[0].selected?.sourceType, 'direct');
});

test('Unknown/tied contacts, missing coverage, wrong cohort and partial maturity keep ROAS unavailable', () => {
  let input = attributionInput(); input.touches = [...input.touches, touch('tie', input.touches[0].occurredAt, 'organic')];
  const tied = attributeCohort(input); assert.equal(tied.roas, null); assert.match(tied.anchors[0].reason!, /indéterminé/);
  input = attributionInput(); input.coverage.refunds = false; assert.equal(attributeCohort(input).roas, null);
  input = attributionInput(); input.spendCohort = parisPeriod('2026-02-01', '2026-03-01'); assert.equal(attributeCohort(input).roas, null);
  input = attributionInput(); input.observedThrough = '2026-02-01T12:00:00Z'; input.manifest.inputCutoffAt = input.observedThrough;
  const partial = attributeCohort(input); assert.equal(partial.roas, null); assert.equal(partial.available, false);
  input = attributionInput(); input.policy = null; assert.equal(attributeCohort(input).roas, null);
});

test('Contact cohort includes registration after its end, with 90-day horizon from contact', () => {
  const input = attributionInput(); input.acquiredAt = { 'person-a': '2026-02-05T12:00:00Z' }; input.touches = [touch('arrival', '2026-01-31T12:00:00Z')];
  const first = payment('first', { effectiveAt: '2026-02-06T12:00:00Z' });
  input.newCustomerEvidence['person-a'] = { firstReceiptKey: evidenceKey(first), firstReceiptAt: first.effectiveAt, evidence: 'complete' };
  input.payments = [first, payment('past-horizon', { effectiveAt: '2026-05-03T12:00:00Z' })];
  assert.equal(attributeCohort(input).attributedPaidRevenue?.minor, 10000);
});

test('Refund lookup is source/account scoped and over-refunding remains an anomaly', () => {
  const input = attributionInput();
  input.payments = [...input.payments, payment('first', { accountId: 'another-account', personId: 'person-b' }), payment('refund', { kind: 'refund', originalPaymentId: 'first', amount: { minor: 2500, currency: 'EUR' } })];
  assert.equal(attributeCohort(input).attributedPaidRevenue?.minor, 7500);
  input.payments = [...input.payments, payment('refund-two', { kind: 'refund', originalPaymentId: 'first' })];
  assert.match(attributeCohort(input).reason!, /supérieurs/);
});
