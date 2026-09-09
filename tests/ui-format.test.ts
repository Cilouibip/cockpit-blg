import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultFilters, filtersQuery, formatDate, formatNumber, validateDateRange, variation } from '../src/components/ui-format';

test('missing financial data never becomes a measured zero', () => {
  assert.equal(formatNumber(null, 'eur'), '—');
  assert.equal(formatNumber(undefined), '—');
  assert.equal(formatNumber(Number.NaN), '—');
  assert.equal(formatNumber(0, 'eur'), '0 €');
  assert.equal(formatNumber(0, 'count'), '0');
});

test('comparison is unavailable on missing evidence or previous zero', () => {
  assert.deepEqual(variation({ value: 10, previous: null }), { text: 'Comparaison indisponible', direction: 'neutral' });
  assert.deepEqual(variation({ value: 10, previous: 0 }), { text: 'Base précédente nulle', direction: 'neutral' });
  assert.deepEqual(variation({ value: 0, previous: 0 }), { text: '0 % · stable', direction: 'neutral' });
  assert.deepEqual(variation({ value: 0, previous: 20 }), { text: '-100 %', direction: 'down' });
  assert.deepEqual(variation({ value: 30, previous: 20 }), { text: '+50 %', direction: 'up' });
});

test('dates are inclusive and invalid calendar dates cannot be submitted', () => {
  assert.equal(validateDateRange('2026-03-29', '2026-03-29'), null);
  assert.ok(validateDateRange('2026-03-30', '2026-03-29'));
  assert.ok(validateDateRange('2026-02-30', '2026-03-02'));
  assert.ok(validateDateRange('', '2026-03-02'));
  assert.ok(validateDateRange('broken', '2026-03-02'));
  assert.equal(validateDateRange('2024-02-29', '2024-03-01'), null);
});

test('default range follows Europe/Paris through midnight and daylight-saving changes', () => {
  assert.equal(defaultFilters(new Date('2026-03-31T22:30:00Z')).from, '2026-04-01');
  assert.equal(defaultFilters(new Date('2026-03-31T22:30:00Z')).to, '2026-04-01');
  assert.equal(defaultFilters(new Date('2026-10-25T23:30:00Z')).to, '2026-10-26');
  assert.equal(formatDate('2026-09-01'), '1 sept. 2026');
  assert.equal(formatDate('invalid'), 'Non disponible');
});

test('filters use encoded campaign identities and an explicit comparison flag', () => {
  const params = new URLSearchParams(filtersQuery({ from: '2026-09-01', to: '2026-09-07', source: 'paid', tunnel: 'quiz', campaign: 'a&source=all', compare: false }));
  assert.equal(params.get('source'), 'paid');
  assert.equal(params.get('campaign'), 'a&source=all');
  assert.equal(params.get('compare'), 'false');
  assert.equal(params.get('to'), '2026-09-07');
});
