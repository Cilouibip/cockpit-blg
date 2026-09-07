import { Temporal } from '@js-temporal/polyfill';
import { defaultFilters } from './ui-format';

export type PeriodId = 'today' | 'yesterday' | 'last7' | 'last30' | 'month' | 'previousMonth' | 'year' | 'previousYear' | 'quarter' | 'previousQuarter' | 'q1' | 'q2' | 'q3' | 'q4' | 'custom';
export type PeriodOption = { id: PeriodId; label: string; from: string; to: string };

/** Inclusive calendar dates in Paris; no milliseconds or backend boundary conversion. */
export function resultPeriods(now = new Date()): PeriodOption[] {
  const today = Temporal.PlainDate.from(defaultFilters(now).to);
  const month = today.with({day:1});
  const year = today.with({month:1,day:1});
  const quarter = today.with({month:Math.floor((today.month-1)/3)*3+1,day:1});
  const range = (id: PeriodId, label: string, from: Temporal.PlainDate, to: Temporal.PlainDate): PeriodOption => ({id,label,from:from.toString(),to:to.toString()});
  return [
    range('today','Aujourd’hui',today,today),
    range('yesterday','Hier',today.subtract({days:1}),today.subtract({days:1})),
    range('last7','7 derniers jours',today.subtract({days:6}),today),
    range('last30','30 derniers jours',today.subtract({days:29}),today),
    range('month','Ce mois-ci',month,today),
    range('previousMonth','Mois dernier',month.subtract({months:1}),month.subtract({days:1})),
    range('year','Cette année',year,today),
    range('previousYear','Année dernière',year.subtract({years:1}),year.subtract({days:1})),
    range('quarter','Trimestre en cours',quarter,today),
    range('previousQuarter','Trimestre précédent',quarter.subtract({months:3}),quarter.subtract({days:1})),
    ...([1,2,3,4] as const).map(q => {
      const start = year.with({month:(q-1)*3+1});
      return range(`q${q}`,`T${q} ${today.year}`,start,start.add({months:3}).subtract({days:1}));
    }),
  ];
}

export function matchingPeriod(from: string, to: string, now = new Date()): PeriodId {
  const periods = resultPeriods(now);
  // The existing default opens at month-to-date, even on the first day of a month.
  const month = periods.find(p=>p.id==='month');
  if(month?.from===from && month.to===to) return 'month';
  return periods.find(p=>p.from===from && p.to===to)?.id ?? 'custom';
}
