import type { Money, Period } from './models';

export type CostAction = 'acquired_lead' | 'appointment_booked' | 'appointment_attended' | 'new_customer';
const labels: Record<CostAction, string> = { acquired_lead: 'Coût publicitaire par lead acquis', appointment_booked: 'Coût publicitaire par RDV pris', appointment_attended: 'Coût publicitaire par RDV réalisé', new_customer: 'Coût publicitaire par nouveau client' };

export function advertisingCostPerAction(input: { action: CostAction; spend: Money | null; actionCount: number | null; spendCohort: Period; actionCohort: Period; complete: boolean; mature: boolean }) {
  const { spend, actionCount } = input;
  const scopeMatches = input.spendCohort.from === input.actionCohort.from && input.spendCohort.to === input.actionCohort.to && input.spendCohort.timezone === input.actionCohort.timezone;
  const reason = !scopeMatches ? 'Cohortes incompatibles' : !input.complete ? 'Couverture incomplète' : !input.mature ? 'Cohorte non arrivée à maturité' : !spend || actionCount === null ? 'Valeur manquante' : actionCount === 0 ? 'Aucune action au dénominateur' : null;
  if (spend && (!Number.isSafeInteger(spend.minor) || spend.minor < 0)) throw new Error('INVALID_SPEND');
  if (actionCount !== null && (!Number.isSafeInteger(actionCount) || actionCount < 0)) throw new Error('INVALID_ACTION_COUNT');
  return { label: labels[input.action], action: input.action, valueMinor: reason === null ? spend!.minor / actionCount! : null, currency: spend?.currency ?? null, numeratorMinor: spend?.minor ?? null, denominator: actionCount, reason, completeCac: false as const };
}
