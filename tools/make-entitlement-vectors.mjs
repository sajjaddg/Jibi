#!/usr/bin/env node
/**
 * Writes the golden vectors of the entitlement (docs/SYNC_PROTOCOL.md § Entitlement) into
 * billing/test/vectors/. Never edit one by hand.
 *
 *   node tools/make-entitlement-vectors.mjs
 *
 * The signing keys here are made from fixed seeds, so they are public: they are for tests and
 * must never sign anything real.
 */

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'billing', 'test', 'vectors');
const DAY = 24 * 60 * 60 * 1000;
const GRACE = 7 * DAY;
/** A whole UTC day, in November 2026. */
const IAT = Math.floor(1795000000000 / DAY) * DAY;
const EXP = IAT + 31 * DAY;
const SLOT = '00112233445566778899aabbccddeeff';

function keyPair(name) {
  const seed = createHash('sha256').update(`muchtoman entitlement test key ${name}`).digest();
  // PKCS#8 for Ed25519 is this fixed header and the 32-byte seed.
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  return { privateKey, publicKey, secret: der.toString('base64') };
}

const first = keyPair(1);
const second = keyPair(2);
const stranger = keyPair(3);

const claims = (over = {}) => ({ exp: EXP, iat: IAT, plan: 'pro', slot: SLOT, v: 1, ...over });
const segment = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

function token(value, key = first) {
  const payload = segment(value);
  const signature = sign(null, Buffer.from(`mt1.entitlement.${payload}`), key.privateKey).toString('base64url');
  return `${payload}.${signature}`;
}

const good = token(claims());
const [goodPayload, goodSignature] = good.split('.');

const CASES = [
  { name: 'valid', token: good, now: IAT, result: 'ok', claims: claims() },
  { name: 'last-moment-of-grace', token: good, now: EXP + GRACE, result: 'ok', claims: claims() },
  { name: 'expired', token: good, now: EXP + GRACE + 1, result: 'expired' },
  { name: 'rotated-key', keys: [first, second], token: token(claims(), second), now: IAT, result: 'ok', claims: claims() },
  { name: 'retired-key', keys: [second], token: good, now: IAT, result: 'invalid' },
  { name: 'unknown-key', token: token(claims(), stranger), now: IAT, result: 'invalid' },
  // A later expiry written into a genuine token, its old signature kept.
  { name: 'tampered-payload', token: `${segment(claims({ exp: EXP + 365 * DAY }))}.${goodSignature}`, now: IAT, result: 'invalid' },
  { name: 'tampered-signature', token: `${goodPayload}.${goodSignature.startsWith('A') ? 'B' : 'A'}${goodSignature.slice(1)}`, now: IAT, result: 'invalid' },
  { name: 'version-2', token: token(claims({ v: 2 })), now: IAT, result: 'invalid' },
  { name: 'unknown-plan', token: token(claims({ plan: 'gold' })), now: IAT, result: 'invalid' },
  { name: 'short-slot', token: token(claims({ slot: 'abc' })), now: IAT, result: 'invalid' },
  { name: 'unsigned', token: goodPayload, now: IAT, result: 'invalid' },
  { name: 'not-a-token', token: 'not a token', now: IAT, result: 'invalid' },
];

mkdirSync(out, { recursive: true });
for (const file of readdirSync(out)) if (file.endsWith('.json')) rmSync(join(out, file));
for (const c of CASES) {
  const vector = {
    name: c.name,
    keys: (c.keys ?? [first]).map((k) => k.publicKey),
    token: c.token,
    now: c.now,
    result: c.result,
    claims: c.claims ?? null,
  };
  writeFileSync(join(out, `${c.name}.json`), JSON.stringify(vector, null, 2) + '\n');
}
// What billing's test signs with, to check it makes the very same token.
writeFileSync(join(out, '..', 'test-signing-key.ts'),
  '// Written by tools/make-entitlement-vectors.mjs. A TEST key from a public seed: never real.\n' +
  `export const TEST_SIGNING_KEY = '${first.secret}';\n`);
console.log(`wrote ${CASES.length} vectors to ${out}`);
