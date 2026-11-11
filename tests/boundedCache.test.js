// The in-memory caches must not grow without end (they once did: the API's memory climbed all day).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedCache } from '../src/utils/boundedCache.js';

test('keeps only the entries used most recently', () => {
  const c = boundedCache(3);
  for (const k of ['a', 'b', 'c']) c.set(k, k.toUpperCase());
  assert.equal(c.get('a'), 'A'); // used again: now the newest
  c.set('d', 'D'); // over the limit: the oldest ('b') goes
  assert.deepEqual([c.size, c.get('a'), c.get('b'), c.get('c'), c.get('d')], [3, 'A', undefined, 'C', 'D']);
  for (let i = 0; i < 1000; i++) c.set(`k${i}`, i);
  assert.equal(c.size, 3);
});
