#!/usr/bin/env node
/**
 * Pushes a synthetic five-year vault at a local `wrangler dev` of this Worker, pulls it back from
 * zero, and reports what that took and weighed, plus what it would cost to run at 1k, 10k and
 * 100k vaults.
 *
 *   cd sync && pnpm run dev          # in one terminal
 *   cd sync && pnpm run loadtest     # in another; --scale 0.1 for a quick run
 *
 * LOCAL ONLY. It refuses any address that is not loopback, with no flag to override: a load
 * test against production is an outage, and one against staging is a decision for B5.4's run,
 * made on purpose, not a default. Nothing it sends is real — see vault.mjs.
 *
 * What it can and cannot tell you. Bytes, request counts and row counts are exact and carry over.
 * Wall times here are wrangler's on this machine, so they say nothing about Cloudflare's; the
 * «3G» figure is a model (sequential requests, a round trip each, the bytes at the link speed),
 * which is what a phone on a bad carrier does and is the number the acceptance bar is about.
 *
 * The object's own CPU time cannot be read under `wrangler dev`. What can is the CPU time of the
 * whole of workerd, with `--cpu-pid=<pid>[,<pid>]` (`pgrep -lf workerd` names them): the Worker, the
 * object, SQLite and the runtime around them, on this machine. An upper bound for a request here, not Cloudflare's figure.
 */

import { execFileSync } from 'node:child_process';
import { generateVault, weigh } from './vault.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? 'true']),
);
const base = new URL(args.url ?? 'http://127.0.0.1:8787');
const scale = Number(args.scale ?? 1);
const seed = Number(args.seed ?? 1);

if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.protocol !== 'http:') {
  console.error(`refusing ${base.origin}: this runs against a local wrangler dev, over http, and nothing else`);
  process.exit(2);
}
if (!(scale > 0 && scale <= 1)) {
  console.error('--scale is a fraction above 0 and at most 1');
  process.exit(2);
}

// The link a phone on a poor carrier has: Chrome DevTools' «Fast 3G» profile.
const LINK = { downBps: 1.6e6, upBps: 0.75e6, rttMs: 562 };
// Cloudflare's published rates, read 2026-11-26, per million and per GB-month. Check them before
// trusting a dollar figure; the allowances a paid plan includes are ignored, so the estimate leans
// high. docs/backend-plan.md § ۶ has the table with them counted.
const PRICE = { workerRequestsPerM: 0.30, doRequestsPerM: 0.15, rowsWrittenPerM: 1.0, rowsReadPerM: 0.001, gbMonth: 0.20 };
// Rows billed per record, as measured (test/churn.test.ts): the row, its primary-key index and the
// seq index to write; one to read back.
const ROW = { written: 3, read: 1 };
// One person's month, once the vault exists: how often a phone asks, and how much changes.
const MONTH = { requestsPerDay: 25, rowsReadPerRequest: 7, recordsChangedPerDay: 10 };

/** CPU seconds the named processes have used, from `ps` («m:ss.cc» or «h:mm:ss»); null with none. */
function cpuSeconds() {
  const pids = args['cpu-pid'];
  if (!pids) return null;
  const times = execFileSync('ps', ['-o', 'time=', '-p', pids.split(',').map(Number).join(',')]).toString();
  return times.trim().split('\n')
    .reduce((sum, time) => sum + time.trim().split(':').reduce((total, part) => total * 60 + Number(part), 0), 0);
}
const cpuSince = (from) => (from === null ? null : Number((cpuSeconds() - from).toFixed(2)));

const json = { 'content-type': 'application/json' };
const hid = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

const timings = { push: [], pull: [] };
async function timed(kind, run) {
  const started = performance.now();
  const response = await run();
  const text = await response.text();
  timings[kind].push(performance.now() - started);
  return { status: response.status, text };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
}

const records = generateVault({ seed, scale });
const weight = weigh(records);

const claim = await fetch(`${base}v1/claim?hid=${hid}`, { method: 'POST', headers: json, body: JSON.stringify({ scopes: ['vault:load'] }) });
if (claim.status !== 200) {
  console.error(`claim failed: ${claim.status} — is wrangler dev running at ${base.origin}?`);
  process.exit(1);
}
const { secret } = await claim.json();
const auth = { authorization: `Bearer ${hid}.${secret}` };

// Push: batches of at most 500 records and about 1.9 MB, the server's own two limits.
let pushRequests = 0;
let pushBytes = 0;
const pushStart = performance.now();
const pushCpuFrom = cpuSeconds();
for (let at = 0; at < records.length;) {
  const batch = [];
  let size = 0;
  while (at < records.length && batch.length < 500) {
    const next = Buffer.byteLength(JSON.stringify(records[at]));
    if (batch.length > 0 && size + next > 1.9 * 1024 * 1024) break;
    batch.push(records[at++]);
    size += next;
  }
  const payload = JSON.stringify({ records: batch });
  const { status, text } = await timed('push', () => fetch(`${base}v1/sync`, { method: 'POST', headers: { ...auth, ...json }, body: payload }));
  if (status !== 200) {
    console.error(`push refused: ${status} ${text}`);
    process.exit(1);
  }
  pushRequests += 1;
  pushBytes += Buffer.byteLength(payload);
}
const pushMs = performance.now() - pushStart;
const pushCpu = cpuSince(pushCpuFrom);

// Pull from zero, as a new device does: pages until the server says there are no more.
let pullRequests = 0;
let pullBytes = 0;
let pulled = 0;
let since = 0;
const pullStart = performance.now();
const pullCpuFrom = cpuSeconds();
for (;;) {
  const { status, text } = await timed('pull', () => fetch(`${base}v1/sync?since=${since}&limit=1000`, { headers: auth }));
  if (status !== 200) {
    console.error(`pull refused: ${status} ${text}`);
    process.exit(1);
  }
  const page = JSON.parse(text);
  pullRequests += 1;
  pullBytes += Buffer.byteLength(text);
  pulled += page.records.length;
  since = page.seq;
  if (!page.hasMore) break;
}
const pullMs = performance.now() - pullStart;
const pullCpu = cpuSince(pullCpuFrom);

// An idle poll, which is nearly every request a household makes: ask after the head, get nothing.
const IDLE_POLLS = 500;
const idleCpuFrom = cpuSeconds();
for (let i = 0; i < IDLE_POLLS; i++) await (await fetch(`${base}v1/sync?since=${since}`, { headers: auth })).text();
const idleCpu = cpuSince(idleCpuFrom);

const model = (requests, bytes, bps) => (requests * LINK.rttMs) / 1000 + (bytes * 8) / bps;
const firstPull3g = model(pullRequests, pullBytes, LINK.downBps);
const firstPush3g = model(pushRequests, pushBytes, LINK.upBps);

const rowsStored = records.length;
const costFor = (vaults) => {
  const requestsPerMonth = vaults * MONTH.requestsPerDay * 30;
  const onboarding = vaults * (rowsStored * ROW.written * PRICE.rowsWrittenPerM + rowsStored * ROW.read * PRICE.rowsReadPerM) / 1e6;
  const steady =
    (requestsPerMonth * (PRICE.workerRequestsPerM + PRICE.doRequestsPerM)) / 1e6 +
    (vaults * MONTH.recordsChangedPerDay * 30 * ROW.written * PRICE.rowsWrittenPerM) / 1e6 +
    (requestsPerMonth * MONTH.rowsReadPerRequest * PRICE.rowsReadPerM) / 1e6 +
    (vaults * (weight.bodyBytes / 1e9) * PRICE.gbMonth);
  return { onboardingOnce: onboarding, perMonth: steady };
};

const mb = (n) => (n / 1048576).toFixed(1);
const result = {
  vault: { ...weight, scale, seed },
  push: { requests: pushRequests, uploadBytes: pushBytes, localMs: Math.round(pushMs), requestMs: { p50: Math.round(percentile(timings.push, 0.5)), p95: Math.round(percentile(timings.push, 0.95)) }, model3gSeconds: Math.round(firstPush3g) },
  pull: { requests: pullRequests, downloadBytes: pullBytes, records: pulled, localMs: Math.round(pullMs), requestMs: { p50: Math.round(percentile(timings.pull, 0.5)), p95: Math.round(percentile(timings.pull, 0.95)) }, model3gSeconds: Math.round(firstPull3g) },
  link: LINK,
  workerdCpu: pushCpu === null ? 'not measured (--cpu-pid)' : {
    pushSeconds: pushCpu, pushMsPerRequest: Math.round((pushCpu * 1000) / pushRequests),
    pullSeconds: pullCpu, pullMsPerRequest: Math.round((pullCpu * 1000) / pullRequests),
    idlePolls: IDLE_POLLS, idleMsPerRequest: Number(((idleCpu * 1000) / IDLE_POLLS).toFixed(2)),
  },
  cost: Object.fromEntries([1_000, 10_000, 100_000].map((v) => [`${v}_vaults`, Object.fromEntries(Object.entries(costFor(v)).map(([k, d]) => [k, Number(d.toFixed(2))]))])),
  assumptions: { PRICE, ROW, MONTH, ignored: ['plan allowances', 'DO duration (docs/backend-plan.md estimates it)', 'egress (Cloudflare charges none)'] },
};

console.log(JSON.stringify(result, null, 2));
console.log(`\n${weight.records} records, ${mb(weight.bodyBytes)} MB of ciphertext (${mb(weight.wireBytes)} MB as JSON)`);
console.log(`first pull: ${pullRequests} requests, ${mb(pullBytes)} MB down, ~${Math.round(firstPull3g)} s on «Fast 3G» (bar: 120 s) — ${firstPull3g < 120 ? 'under' : 'OVER'}`);
console.log(`first push: ${pushRequests} requests, ${mb(pushBytes)} MB up, ~${Math.round(firstPush3g)} s on «Fast 3G»`);
if (pulled !== records.length) {
  console.error(`pulled ${pulled} of ${records.length} records`);
  process.exit(1);
}
