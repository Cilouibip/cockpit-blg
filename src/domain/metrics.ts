import { inPeriod, validInstant } from './dates';
import type { Appointment, Coverage, Deal, Evidence, LeadRegistration, Money, Payment, Period, Ratio } from './models';

export function evidenceKey(row: Evidence): string { return JSON.stringify([row.source, row.accountId, row.externalId]); }

/** The caller supplies authoritative latest records; exact retries never multiply a metric. */
export function deduplicate<T extends Evidence>(rows: readonly T[]): T[] {
  const map = new Map<string, T>();
  for (const row of rows) {
    const existing = map.get(evidenceKey(row));
    const version = row.sourceUpdatedAt ?? row.observedAt;
    if (!existing || validInstant(version) >= validInstant(existing.sourceUpdatedAt ?? existing.observedAt)) map.set(evidenceKey(row), row);
  }
  return [...map.values()];
}

export function moneyFromDecimal(value: string, currency: string, exponent: number): Money {
  if (!/^[A-Z]{3}$/.test(currency) || !Number.isInteger(exponent) || exponent < 0 || exponent > 4) throw new Error('INVALID_CURRENCY');
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error('INVALID_AMOUNT');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > exponent && /[1-9]/.test(fraction.slice(exponent))) throw new Error('UNREPRESENTABLE_AMOUNT');
  const minor = BigInt(whole) * (10n ** BigInt(exponent)) + BigInt((fraction.slice(0, exponent).padEnd(exponent, '0')) || '0');
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('AMOUNT_OVERFLOW');
  return { minor: Number(minor), currency };
}

export function sumMoney(values: readonly Money[], currency: string): Money {
  let minor = 0;
  for (const amount of values) {
    if (amount.currency !== currency) throw new Error('MIXED_CURRENCIES');
    if (!Number.isSafeInteger(amount.minor)) throw new Error('INVALID_MINOR_UNITS');
    minor += amount.minor;
    if (!Number.isSafeInteger(minor)) throw new Error('AMOUNT_OVERFLOW');
  }
  return { minor, currency };
}

export function ratio(numerator: number, denominator: number, complete = true): Ratio {
  if (![numerator, denominator].every(value => Number.isFinite(value) && value >= 0)) throw new Error('INVALID_RATIO');
  return { value: complete && denominator > 0 ? numerator / denominator : null, numerator, denominator, reason: !complete ? 'Couverture incomplète' : denominator === 0 ? 'Dénominateur nul' : null };
}

export function leadMetrics(rows: readonly LeadRegistration[], period: Period, coverage: Coverage) {
  const registrations = deduplicate(rows).filter(row => row.verified && inPeriod(row.registeredAt, period));
  const identified = registrations.filter(row => row.personId !== null);
  const unresolvedRegistrations = registrations.length - identified.length;
  return { uniqueIdentifiedPeople: new Set(identified.map(row => row.personId)).size, registrations: registrations.length, unresolvedRegistrations,
    totalUniquePeople: coverage.complete && unresolvedRegistrations === 0 ? new Set(identified.map(row => row.personId)).size : null, coverage };
}

export function appointmentMetrics(rows: readonly Appointment[], period: Period) {
  const appointments = deduplicate(rows).filter(row => inPeriod(row.scheduledAt, period));
  const counts = { scheduled: 0, attended: 0, no_show: 0, cancelled: 0, rescheduled: 0, unknown: 0 };
  const attendedPeople = new Set<string>();
  let unresolvedAttendees = 0;
  for (const row of appointments) {
    // A CRM closed status or an old scheduled date is never evidence of attendance.
    const status = row.status === 'attended' && (!row.attendedAt || !row.attendanceEvidence) ? 'unknown' : row.status;
    counts[status]++;
    if (status === 'attended') { if (row.personId) attendedPeople.add(row.personId); else unresolvedAttendees++; }
  }
  return { ...counts, total: appointments.length, attendedPeople: attendedPeople.size, unresolvedAttendees,
    showUp: ratio(counts.attended, counts.attended + counts.no_show), unknownOutcome: counts.unknown + counts.scheduled };
}

export function cashMetrics(rows: readonly Payment[], period: Period, coverage: Coverage) {
  const selected = deduplicate(rows).filter(row => inPeriod(row.effectiveAt, period));
  const totals = new Map<string, { receipts: Money[]; refunds: Money[]; unresolved: number; unknownTaxBasis: number; bases: Set<Payment['taxBasis']> }>();
  let pending = 0, rejected = 0;
  for (const row of selected) {
    if (!Number.isSafeInteger(row.amount.minor) || row.amount.minor <= 0 || !/^[A-Z]{3}$/.test(row.amount.currency)) throw new Error('INVALID_PAYMENT_AMOUNT');
    if (row.status === 'pending') { pending++; continue; }
    if (row.status !== 'settled') { rejected++; continue; }
    const aggregate = totals.get(row.amount.currency) ?? { receipts: [], refunds: [], unresolved: 0, unknownTaxBasis: 0, bases: new Set<Payment['taxBasis']>() };
    aggregate[row.kind === 'payment' ? 'receipts' : 'refunds'].push(row.amount);
    if (!row.personId) aggregate.unresolved++;
    if (row.taxBasis === 'unknown') aggregate.unknownTaxBasis++;
    aggregate.bases.add(row.taxBasis);
    totals.set(row.amount.currency, aggregate);
  }
  return { byCurrency: [...totals].map(([currency, data]) => {
    const received = sumMoney(data.receipts, currency), refunded = sumMoney(data.refunds, currency);
    const mixedTaxBasis = data.bases.size > 1;
    return { currency, received: mixedTaxBasis ? null : received.minor, refunded: mixedTaxBasis ? null : refunded.minor, net: mixedTaxBasis ? null : received.minor - refunded.minor,
      normalizedNet: coverage.complete && !mixedTaxBasis && data.bases.has('gross') ? received.minor - refunded.minor : null,
      unresolvedTransactions: data.unresolved, unknownTaxBasis: data.unknownTaxBasis, mixedTaxBasis };
  }), pending, rejected, coverage, missing: !coverage.complete || totals.size === 0 };
}

export function contractedMetrics(rows: readonly Deal[], period: Period) {
  const selected = deduplicate(rows).filter(row => row.status === 'signed' && row.signedAt && inPeriod(row.signedAt, period));
  const eligible = selected.filter(row => row.amount && row.amountEvidence && row.taxBasis !== 'unknown');
  const groups = new Map<string, Money[]>();
  for (const deal of eligible) {
    const amount = deal.amount!;
    const key = `${amount.currency}:${deal.taxBasis}`;
    groups.set(key, [...(groups.get(key) ?? []), amount]);
  }
  return { deals: selected.length, missingAmountOrBasis: selected.length - eligible.length,
    byCurrencyAndBasis: [...groups].map(([key, money]) => ({ key, ...sumMoney(money, money[0].currency) })) };
}

/** Explicit technical definition: first settled receipt. It must be selected and history proven complete. */
export function newClientMetrics(rows: readonly Payment[], period: Period, options: { definition: 'first_settled_payment' | null; historyComplete: boolean }) {
  if (!options.definition || !options.historyComplete) return { count: null, reason: !options.definition ? 'Définition non choisie' : 'Historique incomplet' };
  const payments = deduplicate(rows).filter(row => row.kind === 'payment' && row.status === 'settled');
  if (payments.some(row => row.personId === null)) return { count: null, reason: 'Identités non résolues' };
  const first = new Map<string, string>();
  for (const row of payments) if (!first.has(row.personId!) || validInstant(row.effectiveAt) < validInstant(first.get(row.personId!)!)) first.set(row.personId!, row.effectiveAt);
  return { count: [...first.values()].filter(date => inPeriod(date, period)).length, reason: null };
}
