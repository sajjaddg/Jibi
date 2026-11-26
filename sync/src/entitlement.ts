/**
 * Checking an entitlement billing signed (#45, docs/SYNC_PROTOCOL.md § Entitlement). This side
 * holds public keys only: it can tell a real one from a forged one and cannot make either.
 */

import { PLAN_GRACE_MS } from './plans';

const CONTEXT = 'mt1.entitlement.';

export interface Claims {
  v: 1;
  plan: 'pro';
  exp: number;
  iat: number;
  slot: string;
}

export type Verdict = { ok: true; claims: Claims } | { ok: false; reason: 'invalid' | 'expired' };

const INVALID: Verdict = { ok: false, reason: 'invalid' };

function bytes(base64Url: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(base64Url)) return null;
  try {
    return Uint8Array.from(atob(base64Url.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Raw 32-byte public keys in base64url, comma separated: a list, so that a signing key can be
 * rotated with both the old and the new one accepted for a while (docs/RUNBOOK.md). One that does
 * not parse is left out rather than taking the others with it.
 */
export async function importPublicKeys(list: string): Promise<CryptoKey[]> {
  const keys: CryptoKey[] = [];
  for (const text of list.split(',').map((k) => k.trim()).filter(Boolean)) {
    const raw = bytes(text);
    if (raw?.byteLength !== 32) continue;
    keys.push(await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']));
  }
  return keys;
}

/** The claims of a genuine, current entitlement. The signature is checked before anything is read. */
export async function verifyEntitlement(token: string, keys: readonly CryptoKey[], now: number): Promise<Verdict> {
  const [payload, signature, ...rest] = token.split('.');
  const signed = signature === undefined ? null : bytes(signature);
  const body = bytes(payload);
  if (rest.length > 0 || !body || signed?.byteLength !== 64) return INVALID;
  const message = new TextEncoder().encode(CONTEXT + payload);
  let genuine = false;
  for (const key of keys) {
    if (await crypto.subtle.verify({ name: 'Ed25519' }, key, signed, message)) {
      genuine = true;
      break;
    }
  }
  if (!genuine) return INVALID;
  let claims: Partial<Claims>;
  try {
    claims = JSON.parse(new TextDecoder().decode(body)) as Partial<Claims>;
  } catch {
    return INVALID;
  }
  const { v, plan, exp, iat, slot } = claims;
  if (
    v !== 1 || plan !== 'pro' || !Number.isSafeInteger(exp) || !Number.isSafeInteger(iat) ||
    typeof slot !== 'string' || !/^[a-f0-9]{32}$/.test(slot)
  ) return INVALID;
  if (now > exp! + PLAN_GRACE_MS) return { ok: false, reason: 'expired' };
  return { ok: true, claims: { v, plan, exp: exp!, iat: iat!, slot } };
}
