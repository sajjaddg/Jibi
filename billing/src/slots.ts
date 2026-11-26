/**
 * Which households a license has been signed for (#48). A license is good for two (#16: one vault
 * and one family), each named only by the nonce the client made for it; asking again for a nonce
 * already counted is a renewal and costs nothing.
 *
 * `sync/` accepts any genuine entitlement and cannot know what else it was shown to, so this
 * count, kept by the one side that signs, is what holds a license to its two.
 */

import { signEntitlement, type Claims } from './entitlement';

export const SLOTS_PER_LICENSE = 2;

const DAY = 24 * 60 * 60 * 1000;

/**
 * Hashed under billing's own label. `sync/` hashes the same nonce under a different one, so the
 * two databases laid side by side have no value in common.
 */
export async function slotHash(slot: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`mt1.billing-slot|${slot}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type Issued =
  | { ok: true; entitlement: string }
  | { ok: false; reason: 'unknown_license' | 'expired' | 'no_slots' | 'slot_taken' };

/** An entitlement for `slot` under this license, counting the slot if it is a new one. */
export async function issueEntitlement(
  db: D1Database,
  key: CryptoKey,
  licenseIdHash: string,
  slot: string,
  now: number,
): Promise<Issued> {
  const license = await db.prepare('SELECT plan, expires_at FROM license WHERE id_hash = ?')
    .bind(licenseIdHash).first<{ plan: string; expires_at: number }>();
  if (!license || license.plan !== 'pro') return { ok: false, reason: 'unknown_license' };
  if (now > license.expires_at) return { ok: false, reason: 'expired' };

  const hashed = await slotHash(slot);
  const today = Math.floor(now / DAY) * DAY;
  // One transaction, so two requests at once cannot both take the last place: the count moves only
  // if there is room and the slot is new, and the row is written only if the count moved.
  await db.batch([
    db.prepare(
      'UPDATE license SET slots_used = slots_used + 1 WHERE id_hash = ?1 AND slots_used < ?3 ' +
        'AND NOT EXISTS (SELECT 1 FROM redemption WHERE slot_nonce_hash = ?2)',
    ).bind(licenseIdHash, hashed, SLOTS_PER_LICENSE),
    db.prepare(
      'INSERT INTO redemption (slot_nonce_hash, license_id_hash, created_at) SELECT ?2, ?1, ?3 WHERE changes() = 1',
    ).bind(licenseIdHash, hashed, today),
  ]);
  const owner = await db.prepare('SELECT license_id_hash FROM redemption WHERE slot_nonce_hash = ?')
    .bind(hashed).first<{ license_id_hash: string }>();
  if (!owner) return { ok: false, reason: 'no_slots' };
  if (owner.license_id_hash !== licenseIdHash) return { ok: false, reason: 'slot_taken' };

  const claims: Claims = {
    v: 1,
    plan: 'pro',
    // To the end of the day it runs out on, and from the start of today: no finer, so that a
    // stored expiry cannot be matched to one purchase by its exact time.
    exp: Math.ceil(license.expires_at / DAY) * DAY,
    iat: today,
    slot,
  };
  return { ok: true, entitlement: await signEntitlement(claims, key) };
}
