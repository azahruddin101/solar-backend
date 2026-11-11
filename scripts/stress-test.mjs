#!/usr/bin/env node
// A short stress test of the dashboard and proposals routes: many requests at once for a few seconds, then a
// report per route (requests a second, response times, how many failed or were rate-limited).
// Read-only: it only calls GET routes, so nothing is created or changed. No packages to install (Node 18+).
//
// Run it from backend/ against YOUR OWN server:
//
//   node scripts/stress-test.mjs                                           (uses scripts/stress-test.env)
//   TOKEN=<a company sign-in token> node scripts/stress-test.mjs
//   EMAIL=owner@company.com PASSWORD=... node scripts/stress-test.mjs      (signs in, and out again at the end)
//
// The sign-in is read from scripts/stress-test.env (EMAIL=…, PASSWORD=…, and any setting below), a file that is
// never committed (.gitignore). What is given on the command line wins over the file.
//
// The token is the easier way: sign in to the app as a company owner, open the browser's developer tools →
// Network, click any /api request and copy what follows "Bearer " in its Authorization header. Signing in with
// EMAIL / PASSWORD takes one of the company's sign-in places while the test runs.
// (A super admin's token does not work here: the dashboard and proposals belong to a company workspace.)
//
// Settings (all optional):
//   BASE=http://13.126.166.25:4000   the server
//   CONNECTIONS=20                   requests in flight at once
//   DURATION=5                       seconds each route is hit
//   MAX_REQUESTS=1400                most requests in the whole run, shared between the routes (0 = no limit)
//   ROUTES=/api/dashboard,/api/designs    other GET routes, comma-separated
//
// The API allows 1,500 requests per 5 minutes from one address. Past that it answers 429 ("rate-limited" in the
// report), which measures the limiter, not the server. So the run stops at MAX_REQUESTS (1,400) by default: wait
// 5 minutes between runs. For a heavier test, raise `max: 1500` in src/app.js on a test server and set
// MAX_REQUESTS=0.

import { readFileSync } from 'node:fs';

// scripts/stress-test.env: one NAME=value on each line (# starts a comment); the command line wins
try {
  for (const line of readFileSync(new URL('./stress-test.env', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch { /* no such file: the command line gives everything */ }

const BASE = (process.env.BASE || 'http://13.126.166.25:4000').replace(/\/+$/, '');
const CONNECTIONS = Math.max(1, Number(process.env.CONNECTIONS) || 120);
const SECONDS = Math.max(1, Number(process.env.DURATION) || 5);
const MAX_REQUESTS = process.env.MAX_REQUESTS === undefined ? 1400 : Math.max(0, Number(process.env.MAX_REQUESTS) || 0);
const ROUTES = (process.env.ROUTES || '/api/dashboard/counts,/api/dashboard/today,/api/dashboard,/api/designs').split(',').map((r) => r.trim()).filter(Boolean);
const TIMEOUT_MS = 15000;
// each route's share of the run's requests (the calm check before the test takes one each)
const PER_ROUTE = MAX_REQUESTS ? Math.max(1, Math.floor(MAX_REQUESTS / ROUTES.length) - 1) : Infinity;

const ms = (n) => `${n.toFixed(0)} ms`;
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

async function signIn() {
  if (process.env.TOKEN) return { token: process.env.TOKEN.replace(/^Bearer\s+/i, ''), signedIn: false };
  const { EMAIL: email, PASSWORD: password } = process.env;
  if (!email || !password) {
    console.error('Give a TOKEN, or an EMAIL and PASSWORD (on the command line or in scripts/stress-test.env). See the top of this file.');
    process.exit(1);
  }
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    console.error(`Could not sign in (${res.status}): ${data.error || 'no token returned'}`);
    process.exit(1);
  }
  return { token: data.token, signedIn: true };
}

/** Hit one route with CONNECTIONS requests in flight for SECONDS; returns the figures. */
async function hammer(path, headers) {
  const until = Date.now() + SECONDS * 1000;
  const times = [];
  const statuses = {};
  let failed = 0;
  let bytes = 0;
  let sent = 0;
  const worker = async () => {
    while (Date.now() < until && sent < PER_ROUTE) {
      sent += 1;
      const start = performance.now();
      try {
        const res = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
        bytes += (await res.arrayBuffer()).byteLength;
        statuses[res.status] = (statuses[res.status] || 0) + 1;
        times.push(performance.now() - start);
      } catch {
        failed += 1; // no answer: refused, reset or slower than the timeout
      }
    }
  };
  const began = Date.now();
  await Promise.all(Array.from({ length: CONNECTIONS }, worker));
  const took = (Date.now() - began) / 1000;
  times.sort((a, b) => a - b);
  return { path, took, total: times.length + failed, statuses, failed, bytes, times };
}

function report(r) {
  const ok = Object.entries(r.statuses).filter(([s]) => s >= 200 && s < 300).reduce((a, [, n]) => a + n, 0);
  const limited = r.statuses[429] || 0;
  const errors = Object.entries(r.statuses).filter(([s]) => s >= 500).reduce((a, [, n]) => a + n, 0);
  const other = r.total - ok - limited - errors - r.failed;
  const avg = r.times.length ? r.times.reduce((a, b) => a + b, 0) / r.times.length : 0;
  console.log(`\n${r.path}`);
  console.log(`  ${r.total} requests in ${r.took.toFixed(1)} s  →  ${(r.total / r.took).toFixed(0)} a second, ${(r.bytes / 1048576).toFixed(1)} MB received`);
  console.log(`  answered OK: ${ok}   rate-limited (429): ${limited}   server errors (5xx): ${errors}   no answer: ${r.failed}${other > 0 ? `   other: ${other}` : ''}`);
  console.log(`  response time  average ${ms(avg)}   half under ${ms(pct(r.times, 50))}   95% under ${ms(pct(r.times, 95))}   slowest ${ms(r.times.at(-1) || 0)}`);
  if (other > 0) console.log(`  statuses: ${JSON.stringify(r.statuses)}${r.statuses[401] || r.statuses[403] ? '  (401/403: the token is not a company sign-in, or it has expired)' : ''}`);
  return { ok, limited, errors };
}

const { token, signedIn } = await signIn();
const headers = { Authorization: `Bearer ${token}` };
console.log(`Stress test of ${BASE}\n${CONNECTIONS} requests at once, up to ${SECONDS} s${MAX_REQUESTS ? ` or ${PER_ROUTE} requests` : ''} on each of ${ROUTES.length} routes (read-only)`);

// one calm request first: a wrong token or route is found before the flood, not after it
for (const path of ROUTES) {
  const res = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((e) => ({ status: 0, statusText: e.message }));
  if (res.status !== 200) {
    console.error(`\n${path} answered ${res.status || 'nothing'} ${res.statusText || ''} before the test started. Nothing was sent.`);
    if (res.status === 401 || res.status === 403) console.error('The token must be a company owner’s sign-in (not the super admin’s), and not expired.');
    process.exit(1);
  }
  await res.arrayBuffer();
}

let limited = 0;
let errors = 0;
try {
  for (const path of ROUTES) {
    const r = report(await hammer(path, headers));
    limited += r.limited;
    errors += r.errors;
  }
} finally {
  if (signedIn) await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers }).catch(() => {}); // give the sign-in place back
}

console.log('');
if (limited) console.log(`${limited} requests were refused by the rate limit (1,500 per 5 minutes per address): wait 5 minutes before the next run.`);
if (errors) console.log(`${errors} requests ended in a server error: look at logs/error.log on the server for the same minute.`);
if (!limited && !errors) console.log('No rate-limiting and no server errors.');
