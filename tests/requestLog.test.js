import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import app from '../src/app.js';
import { safePath } from '../src/middlewares/requestLog.middleware.js';

test('safePath leaves ordinary query strings and redacts tokens', () => {
  assert.equal(safePath({ originalUrl: '/api/clients' }), '/api/clients');
  assert.equal(
    safePath({ originalUrl: '/api/staticmap?z=12&mt=map-token&token=abc' }),
    '/api/staticmap?z=12&mt=[redacted]&token=[redacted]',
  );
  assert.equal(safePath({ originalUrl: '/api/auth/login?password=hunter2' }), '/api/auth/login?password=[redacted]');
  assert.equal(safePath({}), '/');
});

test('each finished API response is one log line', async () => {
  const lines = [];
  const orig = console.warn;
  console.warn = (...args) => lines.push(args.join(' '));
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/does-not-exist`, (res) => {
        res.resume();
        res.on('end', () => setTimeout(resolve, 30));
      }).on('error', reject);
    });
    const hits = lines.filter((line) => line.includes('path=/api/does-not-exist'));
    assert.equal(hits.length, 1);
    assert.match(hits[0], /warn\s+http method=GET path=\/api\/does-not-exist status=404 ms=\d/);
    assert.match(hits[0], /rid=[0-9a-f-]{36}/);
  } finally {
    console.warn = orig;
    await new Promise((resolve) => server.close(resolve));
  }
});
