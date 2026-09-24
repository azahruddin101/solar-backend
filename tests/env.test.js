import assert from 'node:assert/strict';
import test from 'node:test';
import { redactMongoUri } from '../src/config/env.js';

test('redactMongoUri never prints credentials or options', () => {
  const out = redactMongoUri('mongodb+srv://appuser:S3cr3t!pw@cluster0.abcde.mongodb.net/solar?retryWrites=true&w=majority');
  assert.equal(out, 'mongodb+srv://cluster0.abcde.mongodb.net/solar');
  assert.ok(!/appuser|S3cr3t|retryWrites/.test(out));
  assert.equal(redactMongoUri('mongodb://127.0.0.1:27017/solar_saas'), 'mongodb://127.0.0.1:27017/solar_saas');
  assert.ok(!redactMongoUri('not a uri').includes('not a uri'));
});
