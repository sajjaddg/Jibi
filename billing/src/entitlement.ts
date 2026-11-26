/**
 * The entitlement: what a purchase becomes (#45, docs/SYNC_PROTOCOL.md § Entitlement).
 *
 *   base64url(payload) "." base64url(Ed25519 signature)
 *
 * The payload is JSON with its keys in this order: `exp, iat, plan, slot, v`. It names no license
 * and no household: `slot` is a random nonce the client made. The signature is over the text
 * `mt1.entitlement.` followed by the first part, so the key signs nothing that could be mistaken
 * for anything else.
 *
 * Signed here and nowhere else. Verified offline by the app and the PWA, and by `sync/`
 * (../../sync/src/entitlement.ts), all against `test/vectors/`.
 */

export const ENTITLEMENT_CONTEXT = 'mt1.entitlement.';

export interface Claims {
  v: 1;
  plan: 'pro';
  /** Epoch ms, a whole day. Pro counts for seven days past it. */
  exp: number;
  /** Epoch ms, a whole day. */
  iat: number;
  /** 32 hex characters. */
  slot: string;
}

const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The private key as `wrangler secret put` holds it: PKCS#8, base64, with or without PEM lines. */
export async function importSigningKey(secret: string): Promise<CryptoKey> {
  const base64 = secret.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
}

export async function signEntitlement(claims: Claims, key: CryptoKey): Promise<string> {
  // Written out by hand so the order is this one whatever object came in.
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    exp: claims.exp, iat: claims.iat, plan: claims.plan, slot: claims.slot, v: claims.v,
  })));
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(ENTITLEMENT_CONTEXT + payload));
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}
