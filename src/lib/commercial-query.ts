import type { CommercialQuery } from './commercial-contract';

/** Keeps an explicit all-history scope when dates are intentionally absent. */
export function serializeCommercialQuery(query: CommercialQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null) params.set(key === 'search' ? 'q' : key, String(value));
  }
  if (query.from === null && query.to === null) params.set('scope', 'all');
  return params.toString();
}
