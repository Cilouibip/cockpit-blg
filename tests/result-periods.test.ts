import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingPeriod, resultPeriods, type PeriodId } from '../src/components/result-periods';
const range = (id: PeriodId, date: string) => { const option = resultPeriods(new Date(date)).find(p=>p.id===id)!; return [option.from,option.to]; };

test('quick periods use the Paris date around midnight and retain inclusive day counts',()=>{
  assert.deepEqual(range('today','2026-03-31T22:30:00Z'),['2026-04-01','2026-04-01']);
  assert.deepEqual(range('yesterday','2026-03-31T22:30:00Z'),['2026-03-31','2026-03-31']);
  assert.deepEqual(range('last7','2026-03-30T10:00:00Z'),['2026-03-24','2026-03-30']);
  assert.deepEqual(range('last30','2026-03-30T10:00:00Z'),['2026-03-01','2026-03-30']);
  assert.deepEqual(range('last7','2026-10-26T10:00:00Z'),['2026-10-20','2026-10-26']);
});

test('completed month and year ranges handle leap years and January rollover',()=>{
  assert.deepEqual(range('previousMonth','2024-03-15T12:00:00Z'),['2024-02-01','2024-02-29']);
  assert.deepEqual(range('previousMonth','2026-01-01T12:00:00Z'),['2025-12-01','2025-12-31']);
  assert.deepEqual(range('previousYear','2025-01-01T12:00:00Z'),['2024-01-01','2024-12-31']);
  assert.deepEqual(range('month','2026-09-07T12:00:00Z'),['2026-09-01','2026-09-07']);
  assert.deepEqual(range('year','2026-09-07T12:00:00Z'),['2026-01-01','2026-09-07']);
});

test('current and previous quarters cross year boundaries with complete previous periods',()=>{
  assert.deepEqual(range('quarter','2026-01-01T12:00:00Z'),['2026-01-01','2026-01-01']);
  assert.deepEqual(range('previousQuarter','2026-01-01T12:00:00Z'),['2025-10-01','2025-12-31']);
  assert.deepEqual(range('quarter','2026-04-01T12:00:00Z'),['2026-04-01','2026-04-01']);
  assert.deepEqual(range('previousQuarter','2024-04-01T12:00:00Z'),['2024-01-01','2024-03-31']);
  assert.deepEqual(range('quarter','2026-09-07T12:00:00Z'),['2026-07-01','2026-09-07']);
  assert.deepEqual(range('previousQuarter','2026-10-01T12:00:00Z'),['2026-07-01','2026-09-30']);
});

test('T1–T4 explicitly name the Paris current year and cover whole calendar quarters',()=>{
  const periods=resultPeriods(new Date('2025-12-31T23:30:00Z')).filter(p=>/^q[1-4]$/.test(p.id));
  assert.deepEqual(periods.map(p=>[p.label,p.from,p.to]),[
    ['T1 2026','2026-01-01','2026-03-31'],['T2 2026','2026-04-01','2026-06-30'],
    ['T3 2026','2026-07-01','2026-09-30'],['T4 2026','2026-10-01','2026-12-31'],
  ]);
});

test('initial preset matches month-to-date and leaves an arbitrary range custom',()=>{
  const now=new Date('2026-09-07T12:00:00Z');
  assert.equal(matchingPeriod('2026-09-01','2026-09-07',now),'month');
  assert.equal(matchingPeriod('2026-02-03','2026-04-06',now),'custom');
});
