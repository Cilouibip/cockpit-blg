import { inPeriod, validInstant } from './dates';
import { deduplicate, evidenceKey, sumMoney } from './metrics';
import type { Coverage, Money, Payment, Period, Touchpoint } from './models';

/** Technical V1 from schema review §8; never silently selected as a user decision. */
export interface AttributionPolicy { method: 'last_non_direct'; windowDays: 30; observationDays: 90; version: string; cohort: Period }
export interface AttributionManifest { identitySnapshotIds: string[]; mappingSnapshotIds: string[]; costSnapshotIds: string[]; coverageSnapshotIds: string[]; inputCutoffAt: string }
export interface AnchorResult { personId: string; acquisitionFactAt: string; candidateEvidenceSnapshot: Touchpoint[]; selected: Touchpoint | null; reason: string | null; inCohort: boolean }
export interface AttributedResult { paymentKey: string; personId: string; touchpointKey: string; linkRevisionId: string | null; adId: string | null; campaignId: string | null; sourceType: Touchpoint['sourceType']; netMinor: number; currency: string; policyVersion: string; targetSnapshot: Payment }
export interface AttributionInput {
  policy: AttributionPolicy | null;
  /** First proven canonical registration, or first receipt only when first-purchase proof exists. */
  acquiredAt: Record<string, string>; newCustomerEvidence: Record<string, { firstReceiptKey: string; firstReceiptAt: string; evidence: string }>;
  payments: readonly Payment[]; touches: readonly Touchpoint[]; currency: string; spend: Money | null; spendCohort: Period | null;
  coverage: { identities: boolean; history: boolean; firstCustomer: boolean; refunds: boolean; mappings: boolean; touches: Coverage; payments: Coverage; spend: Coverage };
  observedThrough: string; manifest: AttributionManifest; maxCandidates?: number;
}

/** Cost input is ALL selected ad spend in contact-date cohort, including ads with no conversions. */
export function attributeCohort(input: AttributionInput) {
  input = structuredClone(input);
  const { policy, coverage } = input;
  const anchors: AnchorResult[] = [], results: AttributedResult[] = [];
  const unavailable = (reason: string) => ({ available: false as const, reason, results, anchors, manifest: input.manifest, attributedPaidRevenue: null, roas: null });
  if (!policy) return unavailable('Méthode et fenêtre non choisies');
  if (policy.method !== 'last_non_direct' || policy.windowDays !== 30 || policy.observationDays !== 90 || !policy.version) return unavailable('Politique V1 invalide');
  if (!coverage.identities || !coverage.history || !coverage.firstCustomer || !coverage.refunds || !coverage.mappings || !coverage.touches.complete || !coverage.payments.complete || !coverage.spend.complete) return unavailable('Couverture incomplète');
  if (!input.manifest.identitySnapshotIds.length || !input.manifest.mappingSnapshotIds.length || !input.manifest.costSnapshotIds.length || !input.manifest.coverageSnapshotIds.length || input.manifest.inputCutoffAt !== input.observedThrough) return unavailable('Manifeste de preuves incomplet');
  if (!input.spend || !input.spendCohort || input.spend.currency !== input.currency || input.spendCohort.from !== policy.cohort.from || input.spendCohort.to !== policy.cohort.to || input.spendCohort.timezone !== policy.cohort.timezone || !Number.isSafeInteger(input.spend.minor) || input.spend.minor < 0) return unavailable('Dépenses et cohorte non alignées');
  const day = 86_400_000, cutoff = validInstant(input.observedThrough);
  if (validInstant(coverage.touches.from) > validInstant(policy.cohort.from) - policy.windowDays * day || validInstant(coverage.touches.to) < Math.min(cutoff, validInstant(policy.cohort.to) + policy.windowDays * day) || validInstant(coverage.payments.to) < cutoff || validInstant(coverage.payments.from) > validInstant(policy.cohort.from)) return unavailable('Intervalles de couverture insuffisants');
  const mature = cutoff >= validInstant(policy.cohort.to) + policy.observationDays * day;
  const touches = deduplicate(input.touches).filter(touch => touch.eventType === 'landing_arrival' || touch.eventType === 'page_view');
  const payments = deduplicate(input.payments);
  let unknown = false;
  for (const [personId, acquiredAt] of Object.entries(input.acquiredAt)) {
    const acquisitionAt = validInstant(acquiredAt);
    if (acquisitionAt > cutoff) continue;
    const candidates = touches.filter(touch => touch.personId === personId && validInstant(touch.occurredAt) <= acquisitionAt && validInstant(touch.occurredAt) >= acquisitionAt - policy.windowDays * day)
      .sort((a, b) => validInstant(a.occurredAt) - validInstant(b.occurredAt));
    const anchor: AnchorResult = { personId, acquisitionFactAt: acquiredAt, candidateEvidenceSnapshot: candidates.slice(0, input.maxCandidates ?? 500), selected: null, reason: null, inCohort: false };
    if (candidates.length > (input.maxCandidates ?? 500)) anchor.reason = 'Candidats tronqués';
    else {
      const nonDirect = candidates.filter(touch => touch.sourceType !== 'direct');
      const considered = nonDirect.length ? nonDirect : candidates;
      const last = considered.at(-1);
      if (!last) anchor.reason = 'Aucun contact observé admissible';
      else {
        const tied = considered.filter(touch => validInstant(touch.occurredAt) === validInstant(last.occurredAt));
        let selected = last;
        if (tied.length > 1) {
          const sequences = tied.map(touch => touch.sourceSequence);
          const commonNamespace = tied.every(touch => touch.source === last.source && touch.accountId === last.accountId);
          if (!commonNamespace || sequences.some(value => value === undefined) || new Set(sequences).size !== tied.length) anchor.reason = 'Ordre de contacts indéterminé';
          else selected = [...tied].sort((a, b) => a.sourceSequence! - b.sourceSequence!).at(-1)!;
        }
        if (!anchor.reason && (selected.sourceType === 'unknown' || (selected.sourceType === 'paid' && !selected.adId))) anchor.reason = 'Source ou publicité non résolue';
        if (!anchor.reason) { anchor.selected = selected; anchor.inCohort = inPeriod(selected.occurredAt, policy.cohort); }
      }
    }
    if (anchor.reason) unknown = true;
    anchors.push(anchor);
  }
  if (unknown) return unavailable('Ancres inconnues ; preuves consultables');
  const receipts = new Map<string, AttributedResult>();
  for (const payment of payments.filter(row => row.kind === 'payment' && row.status === 'settled' && validInstant(row.effectiveAt) <= cutoff)) {
    if (!Number.isSafeInteger(payment.amount.minor) || payment.amount.minor <= 0) return unavailable('Montant de paiement invalide');
    if (!payment.personId) return unavailable('Paiement sans identité');
    const anchor = anchors.find(row => row.personId === payment.personId);
    if (!anchor?.inCohort || !anchor.selected) continue;
    const customer = input.newCustomerEvidence[payment.personId];
    if (!customer?.evidence) return unavailable('Premier client non prouvé');
    const first = payments.find(row => evidenceKey(row) === customer.firstReceiptKey && row.personId === payment.personId && row.kind === 'payment' && row.status === 'settled' && row.effectiveAt === customer.firstReceiptAt);
    if (!first) return unavailable('Preuve du premier paiement absente');
    const contactAt = validInstant(anchor.selected.occurredAt), horizon = contactAt + policy.observationDays * day;
    const firstAt = validInstant(customer.firstReceiptAt), paidAt = validInstant(payment.effectiveAt);
    if (firstAt < contactAt || firstAt >= horizon || paidAt < contactAt || paidAt >= horizon) continue;
    if (payment.amount.currency !== input.currency || payment.taxBasis !== 'gross') return unavailable('Devise ou base TTC incompatible');
    const result: AttributedResult = { paymentKey: evidenceKey(payment), personId: payment.personId, touchpointKey: evidenceKey(anchor.selected), linkRevisionId: anchor.selected.linkRevisionId, adId: anchor.selected.adId, campaignId: anchor.selected.campaignId, sourceType: anchor.selected.sourceType, netMinor: payment.amount.minor, currency: payment.amount.currency, policyVersion: policy.version, targetSnapshot: { ...payment, amount: { ...payment.amount } } };
    results.push(result); receipts.set(evidenceKey(payment), result);
  }
  const refundedByReceipt = new Map<string, number>();
  for (const refund of payments.filter(row => row.kind === 'refund' && row.status === 'settled' && validInstant(row.effectiveAt) <= cutoff)) {
    if (!Number.isSafeInteger(refund.amount.minor) || refund.amount.minor <= 0) return unavailable('Montant de remboursement invalide');
    if (!refund.originalPaymentId) return unavailable('Remboursement sans paiement d’origine');
    const original = payments.find(row => row.source === refund.source && row.accountId === refund.accountId && row.externalId === refund.originalPaymentId && row.kind === 'payment');
    if (!original) return unavailable('Paiement d’origine absent');
    const key = evidenceKey(original), result = receipts.get(key);
    if (!result) continue;
    if (refund.amount.currency !== result.currency || refund.taxBasis !== 'gross' || (refund.personId && refund.personId !== original.personId)) return unavailable('Remboursement incompatible');
    const refunded = (refundedByReceipt.get(key) ?? 0) + refund.amount.minor;
    if (refunded > original.amount.minor) return unavailable('Remboursements supérieurs au reçu');
    refundedByReceipt.set(key, refunded);
    results.push({ ...result, paymentKey: evidenceKey(refund), netMinor: -refund.amount.minor, targetSnapshot: { ...refund, amount: { ...refund.amount } } });
  }
  const revenue = sumMoney(results.filter(row => row.sourceType === 'paid').map(row => ({ minor: row.netMinor, currency: row.currency })), input.currency);
  if (!mature) return { ...unavailable('Cohorte observée à ce jour ; horizon de 90 jours non échu'), observedPaidRevenue: revenue };
  return { available: true as const, reason: input.spend.minor === 0 ? 'Dépense nulle' : null, results, anchors, manifest: input.manifest, attributedPaidRevenue: revenue, roas: input.spend.minor > 0 ? revenue.minor / input.spend.minor : null };
}
