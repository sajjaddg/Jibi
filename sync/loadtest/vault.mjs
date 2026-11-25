/**
 * A synthetic vault: the volume of five years of one person's ledger, as the opaque records the
 * server stores. Nothing here is real data and none of it is readable — the bodies are random
 * bytes standing in for AES-GCM ciphertext, because the server never looks inside one and the
 * sizes are what the load depends on. Seeded, so two runs push the same vault and a change in the
 * numbers is the server's, not the generator's.
 *
 * The shapes follow docs/backend-plan.md § 3.2 (`sms`, `decision`, `goal`, `day`), carried today by
 * kinds the server already accepts: B1.4's vault kinds do not exist yet, and an unknown kind would
 * 400 the batch. The ids and body sizes are what the real kinds will have, which is what a
 * storage and bandwidth measurement needs.
 */

const DAY = 24 * 60 * 60 * 1000;

/** mulberry32: small, seedable and good enough to make sizes and stamps look uneven. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function base64Of(bytes) {
  return Buffer.from(bytes).toString('base64');
}

export const DEFAULT_SHAPE = { sms: 30_000, decisions: 10_000, goals: 100, days: 1825 };

/** Ciphertext sizes in bytes before base64, per kind: [min, max]. */
const SIZES = { sms: [280, 620], decision: [90, 200], goal: [250, 500], day: [180, 260] };

/**
 * @param {{ seed?: number, scale?: number, scope?: string, now?: number }} options
 * `scale` shrinks every count together for a quick run.
 */
export function generateVault({ seed = 1, scale = 1, scope = 'vault:load', now = Date.now() } = {}) {
  const random = prng(seed);
  const between = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
  const count = (n) => Math.max(1, Math.round(n * scale));
  const body = ([lo, hi]) => {
    const bytes = new Uint8Array(between(lo, hi));
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256);
    return base64Of(bytes);
  };
  const nonce = () => base64Of(Uint8Array.from({ length: 12 }, () => Math.floor(random() * 256)));
  const hex = (length) => Array.from({ length }, () => Math.floor(random() * 16).toString(16)).join('');
  const span = DEFAULT_SHAPE.days * DAY;
  const stamp = () => now - Math.floor(random() * span);
  const record = (id, kind, sizes) => ({
    id, scope, kind, updatedAt: stamp(), device: 'loadtest-device', nonce: nonce(), body: body(sizes),
  });

  const records = [];
  for (let i = 0; i < count(DEFAULT_SHAPE.sms); i++) records.push(record(`sms:${hex(64)}`, 'legacy', SIZES.sms));
  for (let i = 0; i < count(DEFAULT_SHAPE.decisions); i++) {
    records.push(record(`decision:${hex(64)}:${i % 4}`, 'legacy', SIZES.decision));
  }
  for (let i = 0; i < count(DEFAULT_SHAPE.goals); i++) records.push(record(`goal:${i}`, 'goal', SIZES.goal));
  const days = count(DEFAULT_SHAPE.days);
  for (let i = 0; i < days; i++) {
    const date = new Date(now - (days - i) * DAY).toISOString().slice(0, 10);
    records.push(record(`day:${date}`, 'legacy', SIZES.day));
  }
  return records;
}

/** What a set of records weighs on the wire and in the object's table, counted the way the server counts. */
export function weigh(records) {
  let bodyBytes = 0;
  let wireBytes = 0;
  for (const r of records) {
    bodyBytes += Buffer.byteLength(r.body);
    wireBytes += Buffer.byteLength(JSON.stringify(r));
  }
  return { records: records.length, bodyBytes, wireBytes };
}
