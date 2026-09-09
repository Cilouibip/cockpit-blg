import type { DashboardFilters, Metric } from '../lib/ui-contract';

export function formatNumber(value: number | null | undefined, unit: Metric['unit'] = 'count'): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const digits = unit === 'count' ? 0 : ['ratio','eur'].includes(unit) ? 2 : 1;
  const number = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(value);
  if (unit === 'eur') return `${number} €`;
  if (unit === 'percent') return `${number} %`;
  if (unit === 'ratio') return `${number}×`;
  if (unit === 'seconds') return `${number} s`;
  return number;
}

export function formatDate(value: string | null | undefined, withTime = false): string {
  if (!value) return 'Non disponible';
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  if (!Number.isFinite(date.getTime())) return 'Non disponible';
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Paris', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(date);
}

export function variation(metric: Pick<Metric, 'value' | 'previous'>): { text: string; direction: 'up' | 'down' | 'neutral' } {
  if (metric.value == null || metric.previous == null) return { text: 'Comparaison indisponible', direction: 'neutral' };
  if (metric.previous === 0) return metric.value === 0 ? { text: '0 % · stable', direction: 'neutral' } : { text: 'Base précédente nulle', direction: 'neutral' };
  const change = (metric.value - metric.previous) / Math.abs(metric.previous) * 100;
  return { text: `${change > 0 ? '+' : ''}${formatNumber(change, 'percent')}`, direction: change > 0 ? 'up' : change < 0 ? 'down' : 'neutral' };
}

export function filtersQuery(filters: DashboardFilters): string {
  return new URLSearchParams({ ...filters, compare: String(filters.compare) }).toString();
}

export function validateDateRange(from: string, to: string): string | null {
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
  try {
    if (!valid(from) || !valid(to)) return 'Renseigne deux dates valides.';
  } catch { return 'Renseigne deux dates valides.'; }
  return from > to ? 'La date de fin doit suivre la date de début.' : null;
}

export function defaultFilters(now = new Date()): DashboardFilters {
  const parts = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const to = `${part('year')}-${part('month')}-${part('day')}`;
  return { from: `${to.slice(0, 8)}01`, to, source: 'all', tunnel: 'all', campaign: '', compare: true };
}
