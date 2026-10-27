// Range reads of a stored file (local disk here; S3 is handed the same header): a PDF viewer asks for parts of a
// large file so it can show the first pages before the rest has arrived.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'range-'));
process.env.UPLOAD_DIR = uploadDir;
process.env.S3_BUCKET = '';
const { env } = await import('../src/config/env.js');
const { openFile } = await import('../src/services/storage.service.js');
env.s3.bucket = ''; // env.js loads backend/.env (which may name a live bucket) over the setting above: local disk only
env.uploadDir = uploadDir;

fs.writeFileSync(path.join(uploadDir, 'doc.pdf'), '0123456789');
after(() => fs.rmSync(uploadDir, { recursive: true, force: true }));

async function read(range) {
  const file = await openFile('doc.pdf', { range });
  if (!file.stream) return { ...file, body: null };
  let body = '';
  for await (const chunk of file.stream) body += chunk;
  return { ...file, body };
}

describe('stored file ranges', () => {
  test('without a range the whole file is read', async () => {
    const f = await read();
    assert.equal(f.body, '0123456789');
    assert.equal(f.partial, undefined);
    assert.equal(f.contentLength, 10);
  });

  test('a start-end, an open-ended and a suffix range read just that part', async () => {
    assert.deepEqual(await read('bytes=2-4').then((f) => [f.body, f.contentRange, f.contentLength]), ['234', 'bytes 2-4/10', 3]);
    assert.deepEqual(await read('bytes=7-').then((f) => [f.body, f.contentRange]), ['789', 'bytes 7-9/10']);
    assert.deepEqual(await read('bytes=-3').then((f) => [f.body, f.contentRange]), ['789', 'bytes 7-9/10']);
    assert.deepEqual(await read('bytes=8-99').then((f) => [f.body, f.contentRange]), ['89', 'bytes 8-9/10']);
  });

  test('a range past the end is unsatisfiable; several ranges or nonsense read the whole file', async () => {
    const past = await read('bytes=10-');
    assert.equal(past.unsatisfiable, true);
    assert.equal(past.contentRange, 'bytes */10');
    assert.equal((await read('bytes=0-1,4-5')).body, '0123456789');
    assert.equal((await read('items=0-1')).body, '0123456789');
  });
});
