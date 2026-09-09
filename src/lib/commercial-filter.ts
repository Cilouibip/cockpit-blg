import type { CommercialDashboard } from './commercial-contract';

/** Client compatibility helper. The API now applies the complete filter before pagination. */
export function filterCommercialDashboard(data: CommercialDashboard, origin: string): CommercialDashboard {
  const records = origin === 'all' ? data.records : data.records.filter(record => record.origin === origin);
  if (data.summary.appointments === null) return { ...data, records };
  return {
    ...data,
    records,
    summary: {
      appointments: records.length,
      present: records.filter(record => record.appointment?.attendance === 'present').length,
      distinctProspects: new Set(records.map(record => record.prospectId).filter((value): value is string => value !== null)).size,
    },
  };
}
