import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpointParts } from '../src/lib/sync-notion-commerce';

// Compatibility oracle: saved checkpoints already use these greedy boundaries.
function legacyParts(serialized: string, maxBytes: number): string[] {
  const parts: string[] = [];
  let part = '';
  for (const point of serialized) {
    if (part && Buffer.byteLength(JSON.stringify({ part: part + point }), 'utf8') > maxBytes) {
      parts.push(part);
      part = point;
    } else part += point;
  }
  if (part) parts.push(part);
  return parts;
}

test('les limites de fragments restent identiques pour les échappements JSON et Unicode', () => {
  const characters = [
    ...Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)),
    'é', '水', '\u07ff', '\u0800', '\uffff', '\u2028', '\u2029',
    '🧑‍💻', '\ud800', '\udc00', '\udbff', '\udfff',
  ];
  const text = characters.join('|').repeat(100);
  for (const limit of [64, 65, 127, 2800]) {
    const parts = checkpointParts(text, limit);
    assert.deepEqual(parts, legacyParts(text, limit));
    assert.equal(parts.join(''), text);
    assert.ok(parts.every(part => Buffer.byteLength(JSON.stringify({ part }), 'utf8') <= limit));
  }
});

test('des chaînes pseudo-aléatoires gardent les mêmes frontières et le même contenu', () => {
  let seed = 31;
  const next = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  for (let sample = 0; sample < 40; sample++) {
    const text = Array.from({ length: 200 }, () => String.fromCodePoint(next() % 0x110000)).join('');
    const limit = 64 + next() % 3000;
    assert.deepEqual(checkpointParts(text, limit), legacyParts(text, limit));
  }
});

test('le nombre maximal de fragments et les entrées refusées sont conservés', () => {
  // At 64 bytes, the 11-byte JSON envelope leaves 53 ASCII characters.
  assert.equal(checkpointParts('a'.repeat(53 * 10_000), 64).length, 10_000);
  assert.throws(() => checkpointParts('a'.repeat(53 * 10_000 + 1), 64), /CHECKPOINT_PART_LIMIT/);
  assert.throws(() => checkpointParts('', 64), /CHECKPOINT_PART_LIMIT/);
  for (const limit of [63, 64.5, NaN, Infinity]) {
    assert.throws(() => checkpointParts('x', limit), /INVALID_CHECKPOINT_LIMIT/);
  }
});
