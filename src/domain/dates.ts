import type { Period } from './models';

export function validInstant(value: string): number {
  if (!/(Z|[+-]\d\d:\d\d)$/.test(value)) throw new Error('INSTANT_REQUIRES_OFFSET');
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error('INVALID_INSTANT');
  return result;
}

export function inPeriod(value: string, period: Period): boolean {
  const from = validInstant(period.from), to = validInstant(period.to), instant = validInstant(value);
  if (from >= to) throw new Error('INVALID_PERIOD');
  return instant >= from && instant < to;
}

function dateParts(day: string): number[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('INVALID_CALENDAR_DAY');
  const [year, month, date] = day.split('-').map(Number);
  const stamp = new Date(Date.UTC(year, month - 1, date));
  if (stamp.toISOString().slice(0, 10) !== day) throw new Error('INVALID_CALENDAR_DAY');
  return [year, month, date];
}

/** Calendar-day boundaries, not a fixed 24h subtraction (Paris DST days are 23/25h). */
export function startOfParisDay(day: string): string {
  const [year, month, date] = dateParts(day);
  const target = Date.UTC(year, month - 1, date);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  let guess = target;
  for (let iteration = 0; iteration < 4; iteration++) {
    const parts = Object.fromEntries(formatter.formatToParts(guess).map(part => [part.type, part.value]));
    const rendered = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    const delta = target - rendered;
    guess += delta;
    if (delta === 0) return new Date(guess).toISOString();
  }
  throw new Error('UNRESOLVABLE_CALENDAR_DAY');
}

export function parisPeriod(fromDay: string, exclusiveToDay: string): Period {
  const period = { from: startOfParisDay(fromDay), to: startOfParisDay(exclusiveToDay), timezone: 'Europe/Paris' };
  if (validInstant(period.from) >= validInstant(period.to)) throw new Error('INVALID_PERIOD');
  return period;
}

export function previousCalendarDay(day: string): string {
  const [year, month, date] = dateParts(day);
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
}
