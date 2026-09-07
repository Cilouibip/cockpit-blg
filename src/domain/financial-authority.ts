import type { Coverage, Money, Period, SourceAggregate } from './models';

export interface CashAuthority {
  version: string; canonicalSource: string; canonicalNamespace: string;
  /** Metadata of the complete transaction query, not the first page of a list. */
  transactions: { period: Period; net: Money | null; complete: boolean; reconciled: boolean; taxBasis: 'gross' | 'net' | 'unknown' };
  aggregateMetric: string;
}

/** Exactly one provenance per reporting cell. Never add partial transactions to a month aggregate. */
export function selectCashAuthority(input: { authority: CashAuthority; period: Period; currency: string; dimensions: Record<string, string>; aggregates: readonly SourceAggregate[]; aggregateCoverage: Coverage }) {
  const { authority, period } = input;
  const samePeriod = (other: Period) => other.from === period.from && other.to === period.to && other.timezone === period.timezone;
  const tx = authority.transactions;
  const unfiltered = Object.keys(input.dimensions).length === 0;
  if (unfiltered && samePeriod(tx.period) && tx.complete && tx.reconciled && tx.taxBasis === 'gross' && tx.net?.currency === input.currency) return { value: tx.net, provenance: 'transactions' as const, definitionVersion: authority.version, reason: null };
  const aggregates = input.aggregates.filter(row => row.source === authority.canonicalSource && row.accountId === authority.canonicalNamespace && samePeriod(row) && row.metric === authority.aggregateMetric && row.amount?.currency === input.currency && row.taxBasis === 'gross' && Object.entries(input.dimensions).every(([key, value]) => row.dimensions[key] === value) && Object.keys(row.dimensions).length === Object.keys(input.dimensions).length);
  if (input.aggregateCoverage.complete && input.aggregateCoverage.from === period.from && input.aggregateCoverage.to === period.to && aggregates.length === 1) return { value: aggregates[0].amount, provenance: 'aggregate' as const, definitionVersion: authority.version, reason: null };
  return { value: null, provenance: null, definitionVersion: authority.version, reason: !unfiltered ? 'Source non répartissable selon ces filtres' : aggregates.length > 1 ? 'Plusieurs agrégats compatibles ; autorité à réconcilier' : 'Couverture ou définition financière incomplète' };
}
