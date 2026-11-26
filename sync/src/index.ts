/**
 * muchtoman-sync — a household's ledger, moved between her devices and never read on the way.
 *
 * The server stores ciphertext. Every report, every narrative and every classification runs on
 * the device that owns the data, so this side has no use for plaintext and is not given any:
 * a record is an opaque AES-GCM blob plus the routing it takes to reach the right devices.
 *
 * That is not only a privacy position, it is less code. There is no transaction schema here, no
 * field validation, no rounding, and no way for an amount to reach a log line — the Phase 3
 * exit criterion "private transaction data never appears in application logs" is true by
 * construction rather than by review.
 *
 * It also makes the family sharing model real rather than decorative. "Share the amount and the
 * category but not the merchant" is not a policy this Worker promises to enforce; it is the
 * sending device encrypting a projection under the family key and the full record under its
 * own. The owner cannot read a private record because the owner does not have the key.
 *
 * Conventions follow ../worker/src/index.ts: uniform response builders that always set an
 * explicit cache-control and nosniff, size-capped body reads, a typed error carrying a stable
 * string code, and single-line structured console.error.
 */

import { DurableObject } from 'cloudflare:workers';
import { isKind, isVaultOnly, KINDS, reservedKind, type Kind } from './kinds';
import { runMigrations } from './migrations';
import { errorCodeOf, measure, routeOf } from './metrics';
import {
  effectivePlan, PLAN_LIMITS_ENFORCED, QUOTAS, type HouseholdType, type Plan, type Quota, type StoredPlan,
} from './plans';
import { effectiveRoles, isRole, ROLES_RESTRICT_MEMBERS, type Role } from './roles';
import { importPublicKeys, verifyEntitlement } from './entitlement';

const MAX_SYNC_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS_PER_PUSH = 500;
const MAX_PULL_RECORD_BYTES = 768 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SCOPE_CHARS = 128;
// A household is a family, not a tenant: sixteen devices and a hundred and twenty thousand
// records are an order of magnitude past any real household, and a bound that exists is what
// keeps one hijacked token from growing a Durable Object without limit.
const MAX_RECORD_ROWS = 120_000;
// The cap counts live rows: a tombstone is history, not growth, and a household that deletes as
// it goes must not fill up on its own deletions. Every row ever stored still meets this wider
// backstop, so burying is not a way around the bound.
// Tombstones are compacted (see `compact`), so this backstop is for a household that buries faster
// than its devices read, not for one that lives long.
const MAX_STORED_ROWS = 4 * MAX_RECORD_ROWS;
// And by size, counted in ciphertext bytes. A real household's rows are a few hundred bytes each,
// tens of megabytes at the row cap; at 64 KiB a body, the row caps alone would allow some 30 GB,
// three times what the object can store. This is room to spare for the first and a wall for the second.
const MAX_STORED_BYTES = 256 * 1024 * 1024;
const MAX_DEVICES = 16;
/**
 * What `/v1/hello` says about the wire, bumped only when an old client could no longer talk to
 * this server at all — a new kind or a new field is not that, `kinds` carries it.
 */
const PROTOCOL = 2;
/**
 * The oldest client build that should sync with this server, as the `versionCode` the release tag
 * works out to (`v1.2.3` → 1020300; AGENTS.md § Deploy). 0 is no floor. A client below it tells
 * her to update rather than failing in a way she cannot read.
 */
const MIN_CLIENT = { android: 0, pwa: 0 };
/** How long a tombstone is kept at the least, counted from its own stamp: a day-old deletion is news. */
const TOMBSTONE_KEEP_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * A device that has been behind for this long — the first thing it has not read was written this
 * long ago — no longer holds the horizon back. A phone in a drawer must not keep every tombstone
 * for ever; when it comes back it is told to start over (410 resync_required) and loses nothing.
 */
const STALE_DEVICE_MS = 180 * 24 * 60 * 60 * 1000;
const COMPACT_EVERY_MS = 24 * 60 * 60 * 1000;
/** A run that hit its row cap has more to do, and says so by waking again soon. */
const COMPACT_RESUME_MS = 60 * 1000;
/** Rows one compaction removes at most, so one alarm is never an unbounded write. */
const MAX_PURGE_PER_RUN = 10_000;
// LWW griefing/skew bound: a stamp from the far future would win every merge for ever, so
// nothing may claim to be written more than a day ahead of this server's clock. The clamped
// value is returned to the pusher so both sides converge on the same stamp.
const MAX_STAMP_SKEW_MS = 24 * 60 * 60 * 1000;
// A record id is the client's own transaction reference: "s:" + a 64-character SHA-256 + ":"
// + a sequence number, or "m:" + a UUID. 128 clears both with room to spare; 64 did not clear
// the first one, which is every SMS-derived transaction there is.
const MAX_ID_CHARS = 256;
const MAX_DEVICE_CHARS = 64;
const MAX_MEMBER_CHARS = 64;
const DEFAULT_RATES_ORIGIN = 'https://rates.muchtoman.com';
/** The rates Worker's own caps on a wallet lookup's body and on a feedback message's. */
const MAX_WALLET_REQUEST_BYTES = 4 * 1024;
const MAX_FEEDBACK_BYTES = 8 * 1024;

/** How long a pairing token is good for. Long enough to walk to the other phone, no longer. */
const PAIRING_TTL_MS = 10 * 60 * 1000;
/** Or a day, when she asks: for someone who is not in the room (#42). */
const PAIRING_TTLS: ReadonlySet<unknown> = new Set([PAIRING_TTL_MS, 24 * 60 * 60 * 1000]);
// A code is somebody about to join, and no household has room for more of them than it has for
// devices. Past that the oldest gives way, so a token stuck in an invite loop cannot grow the
// table without bound inside one TTL.
const MAX_PAIRING_CODES = MAX_DEVICES;

class SyncError extends Error {
  constructor(readonly code: string, readonly status: number, readonly details?: Record<string, unknown>) {
    super(code);
  }
}

/** Which of a plan's limits was met, what it is and how much is used. */
interface OverQuota { what: 'devices' | 'members' | 'bytes'; limit: number; used: number }

const quotaExceeded = (over: OverQuota) => new SyncError('quota_exceeded', 409, { ...over });

class BodyTooLargeError extends Error {}

function jsonResponse(payload: unknown, status = 200, cacheControl = 'no-store'): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff',
    },
  });
}

function textResponse(body: string, status = 200, allow?: string): Response {
  const headers: Record<string, string> = {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (allow) headers.allow = allow;
  return new Response(body, { status, headers });
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function readTextLimited(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) throw new BodyTooLargeError();
  const body = request.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new BodyTooLargeError();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * A request body that must be a JSON object. Anything else is the caller's mistake and a 400 —
 * never a 500 whose log line would quote the start of the body back out of V8's SyntaxError.
 */
async function readJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse((await readTextLimited(request, maxBytes)) || '{}');
  } catch (error) {
    if (error instanceof SyntaxError) throw new SyncError('invalid_request', 400);
    throw error;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SyncError('invalid_request', 400);
  return value as Record<string, unknown>;
}

/**
 * Every POST here carries JSON, and both clients say so. Requiring the header is what keeps other
 * sites out: a browser sends a cross-site POST without asking first only when its type is a form
 * or plain text, and a JSON one needs a preflight nothing here answers.
 */
function isJson(request: Request): boolean {
  return request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json';
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
}

/** Constant-time compare, so a token cannot be recovered a byte at a time from response timing. */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(encoder.encode(a.padEnd(64, '0')), encoder.encode(b.padEnd(64, '0')));
}

function randomToken(bytes = 32): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)).buffer);
}

/**
 * `<householdId>.<secret>`.
 *
 * The household is in the token so the Worker can route to the right object without a lookup
 * table anywhere — and therefore without a KV namespace whose eventual consistency would make
 * "a revoked device loses access immediately" false. The object itself is the only authority on
 * whether the secret is good, so revocation takes effect on the very next request.
 */
function splitToken(raw: string | null): { hid: string; secret: string } | null {
  if (!raw) return null;
  const value = raw.startsWith('Bearer ') ? raw.slice(7) : raw;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const hid = value.slice(0, dot);
  const secret = value.slice(dot + 1);
  if (!/^[a-f0-9]{16,64}$/.test(hid) || !/^[a-f0-9]{32,128}$/.test(secret)) return null;
  return { hid, secret };
}

interface PushRecord {
  id: string;
  scope: string;
  updatedAt: number;
  device: string;
  kind: Kind;
  ownerMemberId: string;
  authorMemberId?: string;
  deleted?: boolean;
  nonce: string;
  body: string;
}

function asRecords(value: unknown): PushRecord[] {
  if (!Array.isArray(value)) throw new SyncError('invalid_request', 400);
  if (value.length > MAX_RECORDS_PER_PUSH) throw new SyncError('too_many_records', 413);
  return value.map((raw) => {
    if (raw == null || typeof raw !== 'object') throw new SyncError('invalid_record', 400);
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    const scope = typeof r.scope === 'string' ? r.scope : '';
    const device = typeof r.device === 'string' ? r.device : '';
    const nonce = typeof r.nonce === 'string' ? r.nonce : '';
    const body = typeof r.body === 'string' ? r.body : '';
    const kind = typeof r.kind === 'string' ? r.kind : 'legacy';
    const ownerMemberId = typeof r.ownerMemberId === 'string' ? r.ownerMemberId : '';
    const updatedAt = typeof r.updatedAt === 'number' ? r.updatedAt : NaN;
    // Shape only. Nothing here inspects what the blob means, because nothing here can.
    if (!id || id.length > MAX_ID_CHARS) throw new SyncError('invalid_id', 400);
    if (!scope || scope.length > MAX_SCOPE_CHARS) throw new SyncError('invalid_scope', 400);
    if (!device || device.length > MAX_DEVICE_CHARS) throw new SyncError('invalid_device', 400);
    if (!isKind(kind)) throw new SyncError('invalid_kind', 400);
    if (ownerMemberId.length > MAX_MEMBER_CHARS) throw new SyncError('invalid_member', 400);
    // A whole millisecond or nothing: both clients read the stamp as a Long, so one fractional
    // value stored here would fail every pull page it lands on, for every device, for ever.
    if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) throw new SyncError('invalid_updated_at', 400);
    if (!nonce || nonce.length > 64) throw new SyncError('invalid_nonce', 400);
    if (body.length > MAX_BODY_BYTES) throw new SyncError('body_too_large', 413);
    return {
      id, scope, updatedAt, device,
      kind, ownerMemberId,
      deleted: r.deleted === true, nonce, body,
    };
  });
}

const IDENTITY = /^[a-f0-9]{16,64}$/;
/** Kinds nobody owns, whose id must start with the kind (#40, #41). */
const HOUSEHOLD_KINDS: ReadonlySet<Kind> = new Set<Kind>(['fund', 'fund_entry', 'share_split', 'settlement']);
/** 32 random bytes in hex, made on the client: the recovery secret, and a rotation's new one. */
const SECRET = /^[a-f0-9]{64}$/;

function identity(value: unknown, fallback: () => string): string {
  return typeof value === 'string' && IDENTITY.test(value) ? value : fallback();
}

/** What a household holds: rows not buried, rows ever stored, and the bytes of their bodies. */
type Counts = {
  live: number;
  stored: number;
  bytes: number;
};

/**
 * The counts after one more row is written, or household_full if it would grow past a bound. A
 * replaced row is not a new one and a tombstone is not a live one, so editing and deleting never
 * fill a household; only a body that grows is held to the byte cap, and a shrinking one gives back.
 */
function grown(
  counts: Counts,
  existing: { deleted: number; size: number } | undefined,
  deleted: boolean,
  body: string,
): Counts {
  const wasLive = existing?.deleted === 0;
  const added = new TextEncoder().encode(body).byteLength - (existing?.size ?? 0);
  if (!deleted && !wasLive && counts.live >= MAX_RECORD_ROWS) throw new SyncError('household_full', 409);
  if (!existing && counts.stored >= MAX_STORED_ROWS) throw new SyncError('household_full', 409);
  if (added > 0 && counts.bytes + added > MAX_STORED_BYTES) throw new SyncError('household_full', 409);
  return {
    live: counts.live + Number(!deleted) - Number(wasLive),
    stored: counts.stored + Number(!existing),
    bytes: counts.bytes + added,
  };
}

/** The part of `/v1/hello` that needs no token: the protocol and what this server accepts. */
function helloAnonymous(): { protocol: number; kinds: readonly Kind[] } {
  return { protocol: PROTOCOL, kinds: KINDS };
}

/** A device's member: its own id, or for a token older than identity, one derived from the token. */
function memberOf(row: { member_id: string; token_hash: string }): string {
  return IDENTITY.test(row.member_id) ? row.member_id : row.token_hash.slice(0, 32);
}

interface AuthorisedDevice {
  id: string;
  memberId: string;
  scopes: string[];
  tokenHash: string;
  identityLocked: boolean;
}

/**
 * One household. Everything it owns lives in this object's own SQLite database, which is the
 * whole security argument: there is no query in this file that could reach another household's
 * rows even if someone wrote one.
 */
export class Household extends DurableObject<Env> {
  private sql: SqlStorage;
  /** Whether a claim has made this household's tables; nothing else may make them. */
  private claimed: boolean;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Any well-formed token routes here, made-up household id and all, and the object comes into
    // being by being addressed. One that writes nothing is not kept, so until a claim makes the
    // tables every request is answered without writing — otherwise each random id would leave a
    // permanent, empty household behind.
    this.claimed = [...this.sql.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'device'",
    )].length > 0;
    if (this.claimed) {
      ctx.blockConcurrencyWhile(async () => {
        this.migrate();
        // A household made before compaction has no alarm; it gets one the first time it wakes.
        if (this.compacting() && (await ctx.storage.getAlarm()) === null) {
          await ctx.storage.setAlarm(Date.now() + COMPACT_EVERY_MS);
        }
      });
    }
  }

  /**
   * The `COMPACTION` switch (wrangler.jsonc), off unless it says exactly «on». It holds back the
   * purge and the alarm that runs it, and nothing else: a household already compacted keeps its
   * horizon and keeps saying 410, because the deletions it would otherwise hide are gone.
   */
  private compacting(): boolean {
    return String(this.env.COMPACTION) === 'on';
  }

  /** `ROLES_RESTRICT_MEMBERS` (roles.ts), as a method so that a test can run the object with it on. */
  private restrictsMembers(): boolean {
    return ROLES_RESTRICT_MEMBERS;
  }

  private roles(): Map<string, Role> {
    const rows = [...this.sql.exec<{ member_id: string; token_hash: string; role: string }>(
      'SELECT member_id, token_hash, role FROM device ORDER BY added_at, id',
    )].map((row) => ({ memberId: memberOf(row), role: row.role }));
    return effectiveRoles(rows, this.primaryMember());
  }

  /**
   * Whether the caller may change who is here: invite, or put somebody else out. An admin may. A
   * read-only member may not. A plain member may until `ROLES_RESTRICT_MEMBERS`, and may never
   * put out an admin.
   */
  private mayManage(auth: AuthorisedDevice, targetMember?: string): void {
    const roles = this.roles();
    const mine = roles.get(auth.memberId) ?? 'member';
    if (mine === 'admin') return;
    if (mine === 'readonly' || this.restrictsMembers() || (targetMember && roles.get(targetMember) === 'admin')) {
      throw new SyncError('forbidden_role', 403);
    }
  }

  /** `PLAN_LIMITS_ENFORCED` (plans.ts), as a method so that a test can run the object with it on. */
  private metered(): boolean {
    return PLAN_LIMITS_ENFORCED;
  }

  private plan(now: number): Plan {
    const row = [...this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', 'plan')][0];
    return effectivePlan(row ? JSON.parse(row.v) as StoredPlan : null, now);
  }

  /** What this household may hold now: its plan's table, or only the hard ceilings. */
  private quota(now: number): Quota {
    if (!this.metered()) return { devices: MAX_DEVICES, members: MAX_DEVICES, bytes: MAX_STORED_BYTES };
    return QUOTAS[this.type()][this.plan(now)];
  }

  private used(): { devices: number; members: number } {
    const rows = [...this.sql.exec<{ member_id: string; token_hash: string }>('SELECT member_id, token_hash FROM device')];
    return { devices: rows.length, members: new Set(rows.map(memberOf)).size };
  }

  /**
   * Room for one more device, or the limit that has none. A newcomer to a family is always a new
   * member as well (`pair` refuses an id that has been anyone), so a family is full on either
   * count; a vault only has devices to run out of.
   */
  private noRoomToJoin(now: number): OverQuota | null {
    const quota = this.quota(now);
    const used = this.used();
    if (used.devices >= quota.devices) return { what: 'devices', limit: quota.devices, used: used.devices };
    if (this.type() === 'family' && used.members >= quota.members) {
      return { what: 'members', limit: quota.members, used: used.members };
    }
    return null;
  }

  /**
   * Numbered schema steps (./migrations.ts), then the two pieces of upkeep that are not schema and
   * are safe to repeat: they run on every wake, and a test that seeds rows behind the object's back
   * runs them again.
   */
  private migrate(): void {
    runMigrations(this.ctx.storage);
    // last_seen is no longer kept: nothing read it, and it said when each phone was last online.
    // The column stays NOT NULL, so it holds the day the device joined, and what it held goes.
    this.sql.exec('UPDATE device SET last_seen = added_at WHERE last_seen != added_at');
    // How full the household is, counted once here and kept by every write after, so a push never
    // scans the table to find out. An empty table is not written down: a household with anything
    // in meta reads to claim() as one that once lived here.
    if (![...this.sql.exec('SELECT 1 FROM meta WHERE k = ?', 'counts')].length) {
      const counted = [...this.sql.exec<Counts>(
        'SELECT COUNT(*) AS stored, COUNT(*) FILTER (WHERE deleted = 0) AS live, ' +
          'COALESCE(SUM(LENGTH(CAST(body AS BLOB))), 0) AS bytes FROM record',
      )][0];
      if (counted.stored > 0) this.saveCounts(counted);
    }
  }

  private counts(): Counts {
    const row = [...this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', 'counts')][0];
    return row ? JSON.parse(row.v) as Counts : { live: 0, stored: 0, bytes: 0 };
  }

  private saveCounts(counts: Counts): void {
    this.sql.exec(
      'INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)',
      'counts',
      JSON.stringify({ live: counts.live, stored: counts.stored, bytes: counts.bytes }),
    );
  }

  /** Set at claim and never changed (see `claim`). */
  private type(): HouseholdType {
    const row = [...this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', 'type')][0];
    return row?.v === 'personal' ? 'personal' : 'family';
  }

  /** Calls that are about one person among several have nothing to say to a vault. */
  private onlyForFamily(): void {
    if (this.type() === 'personal') throw new SyncError('forbidden_type', 403);
  }

  /** Only the hash is ever kept: the secret itself is in her recovery kit and nowhere here. */
  private saveRecovery(hash: string): void {
    this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', 'recovery_hash', hash);
  }

  /**
   * Every phone lost: the recovery kit enrols a new one (`POST /v1/recover`). Every way of failing
   * is the same 404 — no household, a family, a vault with no kit, a wrong or a replaced secret —
   * so nobody learns which. The device cap holds; a full vault answers with its devices, and the
   * same call naming one in `revoke` swaps it for the new one, since a person with no phone left
   * has no token to revoke with.
   */
  private async recover(request: Request): Promise<Response> {
    const body = await readJson(request, 4096);
    const offered = typeof body.recovery === 'string' ? body.recovery : '';
    const offeredHash = await sha256Hex(offered);
    const secret = randomToken();
    const secretHash = await sha256Hex(secret);
    // Nothing below awaits, as in `pair`.
    if (!this.claimed || this.type() !== 'personal') throw new SyncError('not_recoverable', 404);
    const stored = [...this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', 'recovery_hash')][0];
    if (!stored || !SECRET.test(offered) || !timingSafeEqual(stored.v, offeredHash)) {
      throw new SyncError('not_recoverable', 404);
    }
    const devices = [...this.sql.exec<{ id: string; scopes: string; added_at: number }>(
      'SELECT id, scopes, added_at FROM device ORDER BY added_at, id',
    )];
    const deviceId = identity(body.deviceId, () => randomToken(16));
    const revoke = typeof body.revoke === 'string' ? body.revoke : '';
    if (revoke && !devices.some((d) => d.id === revoke)) throw new SyncError('unknown_device', 404);
    if (devices.some((d) => d.id === deviceId && d.id !== revoke)) throw new SyncError('identity_exists', 409);
    // A swap adds nobody, so it is allowed at any limit — even over it, after a plan has lapsed.
    if (!revoke) {
      const listed = devices.map((d) => ({ id: d.id, addedAt: d.added_at }));
      if (devices.length >= MAX_DEVICES) return jsonResponse({ code: 'too_many_devices', devices: listed }, 409);
      const limit = this.quota(Date.now()).devices;
      if (devices.length >= limit) {
        return jsonResponse({ code: 'quota_exceeded', what: 'devices', limit, used: devices.length, devices: listed }, 409);
      }
    }
    const scopes = [...new Set(devices.flatMap((d) => JSON.parse(d.scopes) as string[]))];
    const memberId = this.primaryMember();
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      if (revoke) {
        this.sql.exec('DELETE FROM device WHERE id = ?', revoke);
        // As on any revocation: a code the lost phone showed must not outlive it.
        this.sql.exec('DELETE FROM pairing');
      }
      this.sql.exec(
        'INSERT INTO device (id, member_id, identity_locked, token_hash, scopes, added_at, last_seen) ' +
          'VALUES (?, ?, 1, ?, ?, ?, ?)',
        deviceId,
        memberId,
        secretHash,
        JSON.stringify(scopes),
        now,
        now,
      );
    });
    return jsonResponse({ secret, scopes, memberId, deviceId });
  }

  /** A new kit replaces the old one: from this turn the old secret recovers nothing. */
  private async rotateRecovery(request: Request): Promise<Response> {
    const secretHash = await this.credential(request);
    const body = await readJson(request, 4096);
    const next = typeof body.recovery === 'string' && SECRET.test(body.recovery) ? body.recovery : null;
    const nextHash = next ? await sha256Hex(next) : null;
    this.authorise(secretHash);
    if (this.type() !== 'personal') throw new SyncError('forbidden_type', 403);
    if (!nextHash) throw new SyncError('invalid_recovery', 400);
    this.saveRecovery(nextHash);
    return jsonResponse({ rotated: true });
  }

  /**
   * The founder: the member who claimed the household. Recorded at claim; a household created
   * before this existed backfills lazily from its oldest device row, which is the claimer's.
   */
  private primaryMember(): string {
    const stored = [...this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', 'primary_member')][0];
    if (stored) return stored.v;
    const oldest = [...this.sql.exec<{ member_id: string }>(
      'SELECT member_id FROM device ORDER BY added_at ASC, id ASC LIMIT 1',
    )][0];
    const member = oldest && IDENTITY.test(oldest.member_id) ? oldest.member_id : '';
    if (member) this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', 'primary_member', member);
    return member;
  }

  /**
   * Whether this member id has ever been someone here: the founder, a profile live or buried, or
   * the author of any row. Handed to a newcomer it would let them rewrite that person's rows —
   * and, as the founder's, never be removed.
   */
  private memberTaken(memberId: string): boolean {
    if (memberId === this.primaryMember()) return true;
    return [...this.sql.exec(
      'SELECT 1 FROM record WHERE id = ? OR author_member = ? LIMIT 1',
      `member:${memberId}`,
      memberId,
    )].length > 0;
  }

  private device(secretHash: string): AuthorisedDevice | null {
    for (const row of this.sql.exec<{
      id: string; member_id: string; identity_locked: number; token_hash: string; scopes: string;
    }>(
      'SELECT id, member_id, identity_locked, token_hash, scopes FROM device',
    )) {
      if (timingSafeEqual(row.token_hash, secretHash)) {
        return {
          id: row.id,
          memberId: memberOf(row),
          scopes: JSON.parse(row.scopes) as string[],
          tokenHash: row.token_hash,
          identityLocked: row.identity_locked === 1,
        };
      }
    }
    return null;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/claim' && request.method === 'POST') return await this.claim(request);
      // Before the check below: a caller with no token must not learn from the answer whether
      // there is a household here at all.
      if (path === '/recover' && request.method === 'POST') return await this.recover(request);
      if (!this.claimed) return jsonResponse({ code: 'unauthorised' }, 401);
      if (path === '/invite' && request.method === 'POST') return await this.invite(request);
      if (path === '/pair' && request.method === 'POST') return await this.pair(request);
      if (path === '/identity' && request.method === 'POST') return await this.setIdentity(request);
      if (path === '/hello' && request.method === 'GET') return await this.hello(request);
      if (path === '/pull' && request.method === 'GET') return await this.pull(request, url);
      if (path === '/push' && request.method === 'POST') return await this.push(request);
      if (path === '/remove' && request.method === 'POST') return await this.remove(request);
      if (path === '/leave' && request.method === 'POST') return await this.leave(request);
      if (path === '/destroy' && request.method === 'POST') return await this.destroy(request);
      if (path === '/revoke' && request.method === 'POST') return await this.revoke(request);
      if (path === '/rotate' && request.method === 'POST') return await this.rotate(request);
      if (path === '/recovery_rotate' && request.method === 'POST') return await this.rotateRecovery(request);
      if (path === '/devices' && request.method === 'GET') return await this.devices(request);
      if (path === '/role' && request.method === 'POST') return await this.setRole(request);
      if (path === '/roles' && request.method === 'GET') return await this.listRoles(request);
      if (path === '/invites' && request.method === 'GET') return await this.invites(request);
      if (path === '/invites_cancel' && request.method === 'POST') return await this.cancelInvite(request);
      if (path === '/entitlement' && request.method === 'POST') return await this.entitlement(request);
      return textResponse('not found\n', 404);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return jsonResponse({ code: 'body_too_large' }, 413);
      if (error instanceof SyncError) return jsonResponse({ code: error.code, ...error.details }, error.status);
      // The record body never appears here: it is ciphertext and nothing in this file decodes it.
      console.error(JSON.stringify({ message: 'household failed', error: errorMessage(error) }));
      return jsonResponse({ code: 'internal' }, 500);
    }
  }

  /** First device. Creates the household and takes the first token; refused ever after. */
  private async claim(request: Request): Promise<Response> {
    const body = await readJson(request, 4096);
    const scopes = Array.isArray(body.scopes) ? (body.scopes as string[]).slice(0, 16) : [];
    if (scopes.length === 0) throw new SyncError('invalid_scope', 400);
    // Absent is `family`, which is what every released client claims without saying.
    const type = body.type ?? 'family';
    if (type !== 'family' && type !== 'personal') throw new SyncError('invalid_type', 400);
    // Refused rather than ignored: a caller that sends one believes it can be recovered.
    if (body.recovery !== undefined) {
      if (type !== 'personal') throw new SyncError('forbidden_type', 403);
      if (typeof body.recovery !== 'string' || !SECRET.test(body.recovery)) throw new SyncError('invalid_recovery', 400);
    }
    const recoveryHash = typeof body.recovery === 'string' ? await sha256Hex(body.recovery) : null;
    const memberId = identity(body.memberId, () => randomToken(16));
    const deviceId = identity(body.deviceId, () => randomToken(16));
    const secret = randomToken();
    const secretHash = await sha256Hex(secret);
    if (!this.claimed) this.migrate();
    this.claimed = true;
    // After the last await, so two claims racing for one household cannot both find it empty.
    // Anything in meta means a household lived here — one whose last device left before leaving
    // cleared the records away — and its records are nobody's to claim.
    const existing = [...this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM device')][0];
    const lived = [...this.sql.exec('SELECT 1 FROM meta LIMIT 1')].length > 0;
    if ((existing && existing.n > 0) || lived) throw new SyncError('already_claimed', 409);
    const now = Date.now();
    this.sql.exec(
      // Locked by name: in a household older than the column its default is 0, the one free
      // rebinding meant for tokens that predate identity — never for a device made today.
      'INSERT INTO device (id, member_id, identity_locked, token_hash, scopes, added_at, last_seen) ' +
        'VALUES (?, ?, 1, ?, ?, ?, ?)',
      deviceId,
      memberId,
      secretHash,
      JSON.stringify(scopes),
      now,
      now,
    );
    this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', 'primary_member', memberId);
    // Written once, here, and only for a vault: a household without the row is a family, which
    // covers every one made before there were two kinds without touching any of them.
    if (type === 'personal') this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', 'type', type);
    if (recoveryHash) this.saveRecovery(recoveryHash);
    if (this.compacting()) await this.ctx.storage.setAlarm(now + COMPACT_EVERY_MS);
    return jsonResponse({ secret, memberId, deviceId });
  }

  /** A one-time code an existing device shows, which the new one redeems for a token of its own. */
  private async invite(request: Request): Promise<Response> {
    const secretHash = await this.credential(request);
    const body = await readJson(request, 4096);
    const code = randomToken(16);
    const codeHash = await sha256Hex(code);
    const auth = this.authorise(secretHash);
    this.mayManage(auth);
    const scopes = Array.isArray(body.scopes)
      ? (body.scopes as string[]).filter((s) => auth.scopes.includes(s))
      : auth.scopes;
    if (scopes.length === 0) throw new SyncError('invalid_scope', 400);
    const ttl = body.expiresIn ?? PAIRING_TTL_MS;
    if (!PAIRING_TTLS.has(ttl)) throw new SyncError('invalid_expiry', 400);
    // A code that could not be redeemed is better refused while she is the one holding the phone.
    // Only for a plan's limit: at the hard cap `pair` says so, as it always has.
    const full = this.metered() ? this.noRoomToJoin(Date.now()) : null;
    if (full) throw quotaExceeded(full);
    this.sql.exec('DELETE FROM pairing WHERE expires_at < ?', Date.now());
    this.sql.exec(
      'DELETE FROM pairing WHERE rowid NOT IN (SELECT rowid FROM pairing ORDER BY rowid DESC LIMIT ?)',
      MAX_PAIRING_CODES - 1,
    );
    this.sql.exec(
      'INSERT OR REPLACE INTO pairing (code_hash, scopes, expires_at) VALUES (?, ?, ?)',
      codeHash,
      JSON.stringify(scopes),
      Date.now() + (ttl as number),
    );
    // The scope KEY is not here and never passes through this Worker. It rides in the fragment
    // of the QR's URL, which is never sent in an HTTP request at all.
    // `places` is how many more may join, so the screen can say it before the last one is gone.
    return jsonResponse({ code, expiresIn: ttl, places: this.places(Date.now()) });
  }

  /** How many more devices (in a family, people) may join now. */
  private places(now: number): number {
    const quota = this.quota(now);
    const used = this.used();
    const devices = quota.devices - used.devices;
    return Math.max(0, this.type() === 'family' ? Math.min(devices, quota.members - used.members) : devices);
  }

  /** The caller must be an admin: who is invited is the household's door. */
  private async admin(request: Request): Promise<void> {
    const secretHash = await this.credential(request);
    if (this.roles().get(this.authorise(secretHash).memberId) !== 'admin') throw new SyncError('forbidden_role', 403);
  }

  /** Codes still open. Each is named by its hash, which cancels it and cannot redeem it. */
  private async invites(request: Request): Promise<Response> {
    await this.admin(request);
    const open = [...this.sql.exec<{ code_hash: string; expires_at: number }>(
      'SELECT code_hash, expires_at FROM pairing WHERE expires_at >= ? ORDER BY expires_at, code_hash',
      Date.now(),
    )].map((row) => ({ id: row.code_hash, expiresAt: row.expires_at }));
    return jsonResponse({ invites: open });
  }

  private async cancelInvite(request: Request): Promise<Response> {
    const secretHash = await this.credential(request);
    const body = await readJson(request, 4096);
    // Checked after the body, in the same turn as the delete (see `authorise`).
    if (this.roles().get(this.authorise(secretHash).memberId) !== 'admin') throw new SyncError('forbidden_role', 403);
    const id = typeof body.id === 'string' ? body.id : '';
    const gone = [...this.sql.exec('DELETE FROM pairing WHERE code_hash = ? RETURNING code_hash', id)];
    if (gone.length === 0) throw new SyncError('unknown_invite', 404);
    return jsonResponse({ cancelled: true });
  }

  private async pair(request: Request): Promise<Response> {
    const body = await readJson(request, 4096);
    const code = typeof body.code === 'string' ? body.code : '';
    if (!code) throw new SyncError('invalid_request', 400);
    const codeHash = await sha256Hex(code);
    const secret = randomToken();
    const secretHash = await sha256Hex(secret);
    // Nothing below awaits: the code, the collision checks and the device cap are all read in
    // the same turn that inserts the device, so no concurrent pair or revoke can slip between.
    const now = Date.now();
    this.sql.exec('DELETE FROM pairing WHERE expires_at < ?', now);
    const row = [...this.sql.exec<{ scopes: string }>(
      'SELECT scopes FROM pairing WHERE code_hash = ?',
      codeHash,
    )][0];
    if (!row) throw new SyncError('invalid_code', 403);
    // One time means one time: redeeming consumes it whether or not anything later fails.
    this.sql.exec('DELETE FROM pairing WHERE code_hash = ?', codeHash);
    // A vault has one member, so a new device is hers whatever it calls itself; only its own
    // device id has to be new. In a family a newcomer must be somebody nobody has been.
    const vault = this.type() === 'personal';
    const memberId = vault ? this.primaryMember() : identity(body.memberId, () => randomToken(16));
    const deviceId = identity(body.deviceId, () => randomToken(16));
    const identityCollision = [...this.sql.exec<{ n: number }>(
      'SELECT COUNT(*) AS n FROM device WHERE id = ? OR member_id = ?',
      deviceId,
      vault ? '' : memberId,
    )][0];
    if ((identityCollision && identityCollision.n > 0) || (!vault && this.memberTaken(memberId))) {
      throw new SyncError('identity_exists', 409);
    }
    const devices = [...this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM device')][0];
    if (devices && devices.n >= MAX_DEVICES) throw new SyncError('too_many_devices', 409);
    // Checked again here: the plan may have lapsed, or others joined, since the code was shown.
    const full = this.noRoomToJoin(now);
    if (full) throw quotaExceeded(full);
    this.sql.exec(
      'INSERT INTO device (id, member_id, identity_locked, token_hash, scopes, added_at, last_seen) ' +
        'VALUES (?, ?, 1, ?, ?, ?, ?)',
      deviceId,
      memberId,
      secretHash,
      row.scopes,
      now,
      now,
    );
    return jsonResponse({ secret, scopes: JSON.parse(row.scopes), memberId, deviceId });
  }

  /** The caller's secret, hashed before anything else is awaited — see `authorise`. */
  private async credential(request: Request): Promise<string> {
    const secret = request.headers.get('x-device-secret');
    if (!secret) throw new SyncError('unauthorised', 401);
    return sha256Hex(secret);
  }

  /**
   * Synchronous, and called only once a handler has nothing left to await. The object takes
   * other requests while one waits on its body, so a check made before that wait goes stale: a
   * member removed meanwhile would still mint an invite and walk back in, and a held push of
   * their profile would land on top of its tombstone. Checked here, the check and every write
   * after it run in one turn that no other request can enter.
   */
  private authorise(secretHash: string): AuthorisedDevice {
    const found = this.device(secretHash);
    if (!found) throw new SyncError('unauthorised', 401);
    return found;
  }

  private async setIdentity(request: Request): Promise<Response> {
    const secretHash = await this.credential(request);
    const body = await readJson(request, 4096);
    const auth = this.authorise(secretHash);
    const memberId = identity(body.memberId, () => '');
    const deviceId = identity(body.deviceId, () => '');
    if (!memberId || !deviceId) throw new SyncError('invalid_identity', 400);
    if (auth.identityLocked) {
      if (memberId !== auth.memberId || deviceId !== auth.id) {
        throw new SyncError('identity_locked', 409);
      }
      return jsonResponse({ memberId: auth.memberId, deviceId: auth.id });
    }
    const collision = [...this.sql.exec<{ n: number }>(
      'SELECT COUNT(*) AS n FROM device WHERE id = ? AND token_hash != ?',
      deviceId,
      auth.tokenHash,
    )][0];
    if (collision && collision.n > 0) throw new SyncError('device_exists', 409);
    const memberCollision = [...this.sql.exec<{ n: number }>(
      'SELECT COUNT(*) AS n FROM device WHERE member_id = ? AND token_hash != ?',
      memberId,
      auth.tokenHash,
    )][0];
    if ((memberCollision && memberCollision.n > 0) || (memberId !== auth.memberId && this.memberTaken(memberId))) {
      throw new SyncError('member_exists', 409);
    }
    this.sql.exec(
      'UPDATE device SET id = ?, member_id = ?, identity_locked = 1 WHERE token_hash = ?',
      deviceId,
      memberId,
      auth.tokenHash,
    );
    return jsonResponse({ memberId, deviceId });
  }

  /**
   * What this household is and how full it is, for the device that asks. Answered from the rows
   * already counted — nothing is written, and a household nobody claimed never gets this far
   * (`fetch` answers 401 before any table could be made).
   */
  private async hello(request: Request): Promise<Response> {
    this.authorise(await this.credential(request));
    const now = Date.now();
    return jsonResponse({
      ...helloAnonymous(),
      type: this.type(),
      plan: this.plan(now),
      // What is in force: the hard ceilings until plan limits are switched on.
      quota: this.quota(now),
      used: { ...this.used(), bytes: this.counts().bytes },
      minClient: MIN_CLIENT,
    });
  }

  /** The highest seq a tombstone has been removed at: a device that last read below it must start over. */
  private horizon(): number {
    const row = [...this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', 'horizon')][0];
    return row ? Number(row.v) : 0;
  }

  private head(): number {
    const row = [...this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', 'seq')][0];
    return row ? Number(row.v) : 0;
  }

  /**
   * Asking for everything after N says the device holds everything up to N, so that is what is
   * written down: a number, never a time. It only moves forward, which also means an idle poll
   * writes nothing, and it cannot pass the head, so one device cannot claim to have read what does
   * not exist yet and let the horizon run ahead on its word.
   *
   * A `since` no cursor can reach is not a read at all: both released clients ask `since=<largest
   * number they have>` to learn whether their token still works (Sync.kt, sync.ts
   * `sessionRejected`), and taken as an acknowledgement that would mark everything as read by a
   * phone that was only checking the door.
   */
  private acknowledge(deviceId: string, since: number): void {
    if (since >= Number.MAX_SAFE_INTEGER) return;
    const acked = Math.floor(Math.min(since, this.head()));
    if (acked > 0) this.sql.exec('UPDATE device SET acked_seq = ? WHERE id = ? AND acked_seq < ?', acked, deviceId, acked);
  }

  /**
   * How far every device has read. A device that has caught up holds nothing back, and neither
   * does one that has been behind for half a year (STALE_DEVICE_MS) — judged by the record stamp
   * of the first thing it has not read, which is already here, not by a time kept per device.
   */
  private readHorizon(now: number): number {
    const head = this.head();
    let slowest = head;
    for (const device of [...this.sql.exec<{ acked_seq: number }>('SELECT acked_seq FROM device')]) {
      const acked = Math.min(device.acked_seq, head);
      const unread = [...this.sql.exec<{ updated_at: number }>(
        'SELECT updated_at FROM record WHERE seq > ? ORDER BY seq LIMIT 1',
        acked,
      )][0];
      if (!unread || unread.updated_at < now - STALE_DEVICE_MS) continue;
      slowest = Math.min(slowest, acked);
    }
    return slowest;
  }

  /**
   * Removes tombstones every device has read and that are old enough to be history: below the
   * read horizon, and stamped more than TOMBSTONE_KEEP_MS ago. Live rows are never touched — what
   * compaction frees is the room a household that deletes as it goes would otherwise run out of
   * (`MAX_STORED_ROWS`). One batch, one transaction, so the counters and the rows cannot disagree.
   */
  private compact(now: number): { purged: number; capped: boolean } {
    const below = this.readHorizon(now);
    const cutoff = now - TOMBSTONE_KEEP_MS;
    const batch = 'SELECT seq, LENGTH(CAST(body AS BLOB)) AS size FROM record ' +
      'WHERE deleted = 1 AND seq <= ? AND updated_at < ? ORDER BY seq LIMIT ?';
    let purged = 0;
    this.ctx.storage.transactionSync(() => {
      const found = [...this.sql.exec<{ n: number; last: number | null; bytes: number | null }>(
        `SELECT COUNT(*) AS n, MAX(seq) AS last, SUM(size) AS bytes FROM (${batch})`,
        below, cutoff, MAX_PURGE_PER_RUN,
      )][0];
      if (!found || found.n === 0 || found.last === null) return;
      this.sql.exec(
        `DELETE FROM record WHERE id IN (SELECT id FROM record WHERE deleted = 1 AND seq <= ? ` +
          'AND updated_at < ? ORDER BY seq LIMIT ?)',
        below, cutoff, MAX_PURGE_PER_RUN,
      );
      const counts = this.counts();
      this.saveCounts({ live: counts.live, stored: counts.stored - found.n, bytes: counts.bytes - (found.bytes ?? 0) });
      this.sql.exec(
        'INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)',
        'horizon',
        String(Math.max(this.horizon(), found.last)),
      );
      purged = found.n;
    });
    return { purged, capped: purged >= MAX_PURGE_PER_RUN };
  }

  /**
   * The daily compaction. A household that has been closed since the alarm was set — or one woken
   * after the switch went off again — does nothing and is not woken again.
   */
  async alarm(): Promise<void> {
    if (!this.claimed || !this.compacting()) return;
    let wait = COMPACT_EVERY_MS;
    try {
      if (this.compact(Date.now()).capped) wait = COMPACT_RESUME_MS;
    } catch (error) {
      console.error(JSON.stringify({ message: 'household compaction failed', error: errorMessage(error) }));
    }
    await this.ctx.storage.setAlarm(Date.now() + wait);
  }

  private async pull(request: Request, url: URL): Promise<Response> {
    const auth = this.authorise(await this.credential(request));
    const since = Number(url.searchParams.get('since') ?? '0');
    if (!Number.isFinite(since) || since < 0) throw new SyncError('invalid_since', 400);
    const requestedLimit = Number(url.searchParams.get('limit') ?? '500');
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
      throw new SyncError('invalid_limit', 400);
    }
    const limit = Math.min(requestedLimit, 1000);
    // `live=1` is a pull from the start that does not need the tombstones compaction has been
    // removing: how a phone that fell behind the horizon starts over.
    const live = url.searchParams.get('live') === '1';
    const horizon = this.horizon();
    // A device that last read before the horizon may have missed a deletion that no longer exists
    // to be read, and would keep that row for ever. Better told so than left to find out.
    if (!live && since < horizon) return jsonResponse({ code: 'resync_required', horizon }, 410);
    this.acknowledge(auth.id, since);

    // The second lock. The key is the first: a scope she has no key for is unreadable even if
    // this filter were wrong. Both, because one of them being enough is not a thing to rely on.
    const rows: PushRecord[] = [];
    let highest = since;
    let scanned = 0;
    let bytes = 0;
    let hasMore = false;
    for (const row of this.sql.exec<{
      id: string; scope: string; seq: number; updated_at: number; kind: PushRecord['kind'];
      device: string; owner_member: string; author_member: string;
      deleted: number; nonce: string; body: string;
    }>(
      'SELECT * FROM record WHERE seq > ? ORDER BY seq ASC LIMIT ?',
      since,
      limit + 1,
    )) {
      if (scanned >= limit) {
        hasMore = true;
        break;
      }
      // A tombstone at or below the horizon is one compaction may already have removed from other
      // pulls, so a start-over does without all of them alike. Above it a deletion may be the
      // very one for a row this walk handed over a page ago, and is sent.
      if (!auth.scopes.includes(row.scope) || (live && row.deleted === 1 && row.seq <= horizon)) {
        highest = row.seq;
        scanned++;
        continue;
      }
      const record: PushRecord = {
        id: row.id,
        scope: row.scope,
        updatedAt: row.updated_at,
        device: row.device,
        kind: row.kind,
        ownerMemberId: row.owner_member,
        authorMemberId: row.author_member,
        deleted: row.deleted === 1,
        nonce: row.nonce,
        body: row.body,
      };
      const recordBytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;
      if (rows.length > 0 && bytes + recordBytes > MAX_PULL_RECORD_BYTES) {
        hasMore = true;
        break;
      }
      rows.push(record);
      bytes += recordBytes;
      highest = row.seq;
      scanned++;
    }
    return jsonResponse({
      seq: highest,
      records: rows,
      hasMore,
      horizon,
      rotationClientSecret: true,
      memberId: auth.memberId,
      deviceId: auth.id,
      primaryMemberId: this.primaryMember(),
    });
  }

  private async push(request: Request): Promise<Response> {
    const secretHash = await this.credential(request);
    const parsed = await readJson(request, MAX_SYNC_REQUEST_BYTES);
    const auth = this.authorise(secretHash);
    const records = asRecords(parsed.records);

    const head = [...this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', 'seq')][0];
    const start = head ? Number(head.v) : 0;
    let seq = start;
    let counts = this.counts();
    const maxStamp = Date.now() + MAX_STAMP_SKEW_MS;
    const clamped: { id: string; updatedAt: number }[] = [];
    // Refused one at a time, unlike everything else here: the rest of the batch is her ledger and
    // must not wait on a record that will never be taken. So is one the plan has no room for.
    const rejected: ({ id: string; code: string } & Partial<OverQuota>)[] = [];
    const vault = this.type() === 'personal';
    const quota = this.quota(Date.now());
    const readOnly = !vault && this.roles().get(auth.memberId) === 'readonly';
    try {
      for (const record of records) {
        if (!auth.scopes.includes(record.scope)) throw new SyncError('forbidden_scope', 403);
        // Read-only writes nothing — except taking back what is their own. Turning sharing off
        // has to keep working: it is how their rows leave everybody else's ledger.
        const takingBack = record.deleted === true && record.ownerMemberId === auth.memberId &&
          (record.kind === 'transaction' || record.kind === 'asset');
        if (readOnly && !takingBack) {
          rejected.push({ id: record.id, code: 'read_only' });
          continue;
        }
        if (isVaultOnly(record.kind)) {
          if (!vault) {
            rejected.push({ id: record.id, code: 'kind_not_allowed' });
            continue;
          }
          if (!record.id.startsWith(`${record.kind}:`)) throw new SyncError('invalid_id', 400);
        }
        const reserved = reservedKind(record.id);
        if (reserved && record.kind !== reserved) throw new SyncError('invalid_kind', 400);
        if (record.kind === 'member') {
          // Member deletion changes household membership, so it never rides the general-purpose
          // push path. Dedicated remove/leave operations validate and commit the profile
          // tombstone together with token revocation.
          const ownWrite = !record.deleted &&
            record.ownerMemberId === auth.memberId &&
            record.id === `member:${auth.memberId}`;
          if (!ownWrite) throw new SyncError('forbidden_owner', 403);
        }
        if (record.kind === 'transaction') {
          if (record.ownerMemberId !== auth.memberId || !record.id.startsWith(`txn:${auth.memberId}:`)) {
            throw new SyncError('forbidden_owner', 403);
          }
        }
        if (record.kind === 'asset') {
          // One assets record per person, written only by that person — tombstone included.
          // Unlike a member row there is no removal ceremony to speak for: a removed member's
          // assets simply stop being shown once their profile is buried.
          if (record.ownerMemberId !== auth.memberId || record.id !== `asset:${auth.memberId}`) {
            throw new SyncError('forbidden_owner', 403);
          }
        }
        if (record.kind === 'category' && !record.id.startsWith('category:')) {
          throw new SyncError('invalid_id', 400);
        }
        // A note is written by whoever is reading the row, not by whose row it is, so — exactly
        // like a category — it carries no owner check. The id namespace is all that is fenced.
        if (record.kind === 'note' && !record.id.startsWith('note:')) {
          throw new SyncError('invalid_id', 400);
        }
        // A shared budget or goal belongs to the household rather than to whoever typed it in:
        // a cap only one of them may adjust is a cap they cannot keep together. So, like a
        // category and a note, it carries no owner check — the record names its owner for the
        // sentence on the card, and the stamp settles who moved the figure last. The id
        // namespace is all that is fenced, and the tombstone rides the same path for the same
        // reason: either of them may put the figure away.
        if (record.kind === 'goal' && !record.id.startsWith('goal:')) {
          throw new SyncError('invalid_id', 400);
        }
        // Which categories the household's reports leave out is one setting the household keeps
        // together, exactly as a shared budget is one figure: any member may move it and the
        // stamp settles whose edit stands, so — like a goal — only the id namespace is fenced.
        if (record.kind === 'exclusion') {
          if (!record.id.startsWith('exclusion:')) throw new SyncError('invalid_id', 400);
          // «Count everything» is an empty list, never a tombstone: no client honours a deleted
          // exclusion record, so storing one could only pin the row — stamped at the clamp
          // horizon by a hostile push — against a day of honest edits nobody would see refused.
          if (record.deleted) throw new SyncError('invalid_kind', 400);
        }
        // The common pot, who paid for whom and what was handed back belong to the household, as a
        // shared budget does: any member who may write at all may add to them or correct them.
        // Only the id namespace is fenced.
        if (HOUSEHOLD_KINDS.has(record.kind) && !record.id.startsWith(`${record.kind}:`)) {
          throw new SyncError('invalid_id', 400);
        }
        const existing = [...this.sql.exec<{
          updated_at: number; author_member: string; kind: PushRecord['kind']; owner_member: string;
          deleted: number; size: number;
        }>(
          'SELECT updated_at, author_member, kind, owner_member, deleted, LENGTH(CAST(body AS BLOB)) AS size ' +
            'FROM record WHERE id = ?',
          record.id,
        )][0];
        if (
          existing &&
          existing.owner_member !== auth.memberId &&
          (existing.kind === 'transaction' || existing.kind === 'asset' || existing.kind === 'member')
        ) throw new SyncError('forbidden_owner', 403);
        // A legacy row names no owner — old APKs never sent one — so whoever wrote it is its owner,
        // and nobody else replaces or buries it. A row with no author predates authorship and stays
        // open, or the phones that wrote those could no longer touch their own.
        if (
          existing?.kind === 'legacy' &&
          existing.author_member !== '' &&
          existing.author_member !== auth.memberId
        ) throw new SyncError('forbidden_owner', 403);
        const storedAt = Math.min(record.updatedAt, maxStamp);
        if (storedAt !== record.updatedAt) clamped.push({ id: record.id, updatedAt: storedAt });
        // Last write wins, with the member id breaking a tie so two phones that disagree at the
        // same millisecond still converge on the same answer rather than flapping.
        //
        // Ceiling, named: two people editing one transaction's category in the same second — one
        // of them wins. A CRDT would fix that and cost more than the problem is worth.
        if (
          existing &&
          (existing.updated_at > storedAt ||
            (existing.updated_at === storedAt && existing.author_member >= auth.memberId))
        ) {
          continue;
        }
        // The plan's size: only something that grows the household can be refused, and a delete
        // never is. The hard ceilings are `grown`'s, below, for every household alike.
        if (!record.deleted && this.metered()) {
          const added = new TextEncoder().encode(record.body).byteLength - (existing?.size ?? 0);
          if (added > 0 && counts.bytes + added > quota.bytes) {
            rejected.push({ id: record.id, code: 'quota_exceeded', what: 'bytes', limit: quota.bytes, used: counts.bytes });
            continue;
          }
        }
        const next = grown(counts, existing, record.deleted === true, record.body);
        seq += 1;
        this.sql.exec(
          'INSERT OR REPLACE INTO record ' +
            '(id, scope, seq, updated_at, device, kind, owner_member, author_member, deleted, nonce, body) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          record.id,
          record.scope,
          seq,
          storedAt,
          auth.id,
          record.kind,
          record.ownerMemberId,
          auth.memberId,
          record.deleted ? 1 : 0,
          record.nonce,
          record.body,
        );
        counts = next;
      }
    } finally {
      // The same turn as the rows, so the counts can never disagree with what was written.
      if (seq !== start) {
        this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', 'seq', String(seq));
        this.saveCounts(counts);
      }
    }
    return jsonResponse({
      seq,
      accepted: records.length - rejected.length,
      clamped,
      // Only when there is something to say, so the answer to every released client is as it was.
      ...(rejected.length ? { rejected } : {}),
    });
  }

  private memberTombstone(value: unknown, auth: AuthorisedDevice, targetMember: string): PushRecord {
    const [record] = asRecords([value]);
    if (
      !IDENTITY.test(targetMember) ||
      record.kind !== 'member' ||
      !record.deleted ||
      record.id !== `member:${targetMember}` ||
      record.ownerMemberId !== targetMember ||
      !auth.scopes.includes(record.scope)
    ) {
      throw new SyncError('invalid_member_tombstone', 400);
    }
    return record;
  }

  /**
   * Every device of a member. By `memberOf`, not by the column: a token older than identity has no
   * member id on its row, and matching the column would answer «done» and leave it working.
   */
  private dropMember(memberId: string): void {
    for (const row of [...this.sql.exec<{ id: string; member_id: string; token_hash: string }>(
      'SELECT id, member_id, token_hash FROM device',
    )]) {
      if (memberOf(row) === memberId) this.sql.exec('DELETE FROM device WHERE id = ?', row.id);
    }
  }

  /** Writes the profile tombstone and cuts off the member as one SQLite transaction. */
  private removeMember(auth: AuthorisedDevice, targetMember: string, record: PushRecord): Response {
    const head = [...this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', 'seq')][0];
    const seq = (head ? Number(head.v) : 0) + 1;
    const existing = [...this.sql.exec<{ updated_at: number; deleted: number; size: number }>(
      'SELECT updated_at, deleted, LENGTH(CAST(body AS BLOB)) AS size FROM record WHERE id = ?',
      record.id,
    )][0];
    const counts = grown(this.counts(), existing, true, record.body);
    // Leaving is authoritative. It must beat a previously clamped future profile stamp because
    // the member will have no token left with which to retry a later tombstone.
    const requestedAt = Math.min(record.updatedAt, Date.now() + MAX_STAMP_SKEW_MS);
    const storedAt = Math.max(requestedAt, (existing?.updated_at ?? -1) + 1);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT OR REPLACE INTO record ' +
          '(id, scope, seq, updated_at, device, kind, owner_member, author_member, deleted, nonce, body) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        record.id,
        record.scope,
        seq,
        storedAt,
        auth.id,
        'member',
        targetMember,
        auth.memberId,
        1,
        record.nonce,
        record.body,
      );
      this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', 'seq', String(seq));
      this.saveCounts(counts);
      this.dropMember(targetMember);
      this.sql.exec('DELETE FROM pairing');
    });
    const clamped = storedAt === record.updatedAt ? [] : [{ id: record.id, updatedAt: storedAt }];
    return jsonResponse({ revoked: targetMember, seq, clamped });
  }

  /** Removes another member, including their profile, or changes nothing. */
  private async remove(request: Request): Promise<Response> {
    const secretHash = await this.credential(request);
    const body = await readJson(request, MAX_SYNC_REQUEST_BYTES);
    const auth = this.authorise(secretHash);
    this.onlyForFamily();
    const member = typeof body.member === 'string' ? body.member : '';
    if (!member || member === auth.memberId) throw new SyncError('invalid_request', 400);
    const primary = this.primaryMember();
    if (primary && member === primary) throw new SyncError('forbidden_primary', 403);
    this.mayManage(auth, member);
    // Only someone who was here: a device of theirs, or their profile. A made-up id would leave a
    // tombstone behind for nobody, take that id out of reach for ever and sweep every invite. A
    // buried profile still counts, so a removal whose answer was lost can be sent again — the
    // phone buries the member only once the server says yes, and never pulls its own tombstone.
    const known = [...this.sql.exec<{ member_id: string; token_hash: string }>('SELECT member_id, token_hash FROM device')]
      .some((row) => memberOf(row) === member) ||
      [...this.sql.exec('SELECT 1 FROM record WHERE id = ? LIMIT 1', `member:${member}`)].length > 0;
    if (!known) throw new SyncError('unknown_member', 404);
    const record = this.memberTombstone(body.record, auth, member);
    return this.removeMember(auth, member, record);
  }

  /** Lets the caller leave and publishes that fact in the same transaction. */
  private async leave(request: Request): Promise<Response> {
    const secretHash = await this.credential(request);
    const body = await readJson(request, MAX_SYNC_REQUEST_BYTES);
    const auth = this.authorise(secretHash);
    // A vault is not left: a device is revoked, and the vault itself is destroyed.
    this.onlyForFamily();
    const record = this.memberTombstone(body.record, auth, auth.memberId);
    const response = this.removeMember(auth, auth.memberId, record);
    await this.closeIfEmpty();
    return response;
  }

  /**
   * A household nobody holds a token for any more ends with its last device. Kept, it would wait
   * for ever with every record in it for anyone who knows its id — which every token and every
   * invite carries — to claim it again and pull the lot.
   */
  private async closeIfEmpty(): Promise<void> {
    const devices = [...this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM device')][0];
    if (devices && devices.n > 0) return;
    await this.wipe();
  }

  /** Everything this object holds, gone, and the object back to one that was never claimed. */
  private async wipe(): Promise<void> {
    // deleteAll leaves the alarm standing, and a closed household has nothing to compact.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.claimed = false;
  }

  /**
   * Wipes the whole household from the server: every record, every device, every code. What is on
   * the phones is not touched — this is the server forgetting, not the family's data going.
   *
   * A vault is one person's, so any of her devices may. A family belongs to several: only an
   * admin (the founder, while they are here), and only once they are the one member left (anyone
   * else leaves, and the household closes itself when the last device does). Nothing is kept, the recovery hash included: the id
   * can be claimed again, from nothing, and no old token opens it.
   */
  private async destroy(request: Request): Promise<Response> {
    const secretHash = await this.credential(request);
    const auth = this.authorise(secretHash);
    if (this.type() === 'family') {
      if (this.roles().get(auth.memberId) !== 'admin') throw new SyncError('forbidden_primary', 403);
      const members = new Set(
        [...this.sql.exec<{ member_id: string; token_hash: string }>('SELECT member_id, token_hash FROM device')].map(memberOf),
      );
      if (members.size > 1) throw new SyncError('members_remain', 409);
    }
    await this.wipe();
    return jsonResponse({ destroyed: true });
  }

  /**
   * Immediate, because this object is the only thing that decides whether a token is good. There
   * is no cache anywhere to expire and no eventually-consistent store to catch up.
   *
   * Takes a device id or a member id: the phones list people, not devices, so removing a person
   * is the request they can actually make. Revoking by member cuts every device that person has.
   */
  private async revoke(request: Request): Promise<Response> {
    const secretHash = await this.credential(request);
    const body = await readJson(request, 4096);
    const auth = this.authorise(secretHash);
    const device = typeof body.device === 'string' ? body.device : '';
    const member = typeof body.member === 'string' ? body.member : '';
    if ((!device && !member) || (device && member)) throw new SyncError('invalid_request', 400);
    // The founder is not removable by anyone else — a family survives its members falling out.
    // Removing themselves stays their own right, which is also how anyone leaves: revoke your
    // own member and walk.
    const named = member ? undefined : [...this.sql.exec<{ member_id: string; token_hash: string }>(
      'SELECT member_id, token_hash FROM device WHERE id = ?', device,
    )][0];
    const targetMember = member || (named ? memberOf(named) : '');
    const primary = this.primaryMember();
    if (primary && targetMember === primary && auth.memberId !== primary) {
      throw new SyncError('forbidden_primary', 403);
    }
    // Revoking oneself is leaving, which is always allowed.
    if (targetMember !== auth.memberId) this.mayManage(auth, targetMember);
    if (this.type() === 'personal') {
      // By device only: revoking the one member would be every device at once.
      if (member) throw new SyncError('forbidden_type', 403);
      // And never the last one. A family whose last device goes is wiped; a vault is deleted by
      // `destroy` and nothing else (PRODUCT.md), and left with no token it could not be reached.
      const others = [...this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM device WHERE id != ?', device)][0];
      if (!others || others.n === 0) throw new SyncError('last_device', 409);
    }
    if (device) this.sql.exec('DELETE FROM device WHERE id = ?', device);
    if (member) this.dropMember(member);
    // Outstanding invite codes die with the revocation. A pairing row is not attributed to the
    // device that minted it, and an ex-member who photographed a QR before being evicted must
    // not be able to walk back in with it — the remaining members can mint a fresh code in one
    // tap, so sweeping them all costs nothing.
    this.sql.exec('DELETE FROM pairing');
    await this.closeIfEmpty();
    return jsonResponse({ revoked: device || member });
  }

  /**
   * An admin makes a member an admin, a member or read-only. The founder stays an admin, and the
   * family is never left with none. Codes shown before the change die with it, as on a revocation.
   */
  private async setRole(request: Request): Promise<Response> {
    const secretHash = await this.credential(request);
    const body = await readJson(request, 4096);
    const auth = this.authorise(secretHash);
    this.onlyForFamily();
    const roles = this.roles();
    if (roles.get(auth.memberId) !== 'admin') throw new SyncError('forbidden_role', 403);
    const member = typeof body.member === 'string' ? body.member : '';
    const role = body.role;
    if (!isRole(role)) throw new SyncError('invalid_role', 400);
    const rows = [...this.sql.exec<{ id: string; member_id: string; token_hash: string; role: string }>(
      'SELECT id, member_id, token_hash, role FROM device',
    )];
    const theirs = rows.filter((row) => memberOf(row) === member);
    if (!member || theirs.length === 0) throw new SyncError('unknown_member', 404);
    const primary = this.primaryMember();
    if (member === primary && role !== 'admin') throw new SyncError('forbidden_primary', 403);
    if (role !== 'admin' && roles.get(member) === 'admin') {
      const others = rows.some((row) => memberOf(row) !== member && (row.role === 'admin' || memberOf(row) === primary));
      if (!others) throw new SyncError('last_admin', 409);
    }
    this.ctx.storage.transactionSync(() => {
      for (const row of theirs) this.sql.exec('UPDATE device SET role = ? WHERE id = ?', role, row.id);
      this.sql.exec('DELETE FROM pairing');
    });
    return jsonResponse({ member, role });
  }

  /** Everybody's role, and the caller's own. In no order that means anything. */
  private async listRoles(request: Request): Promise<Response> {
    const auth = this.authorise(await this.credential(request));
    this.onlyForFamily();
    const roles = this.roles();
    return jsonResponse({
      role: roles.get(auth.memberId) ?? 'member',
      members: [...roles].map(([memberId, role]) => ({ memberId, role })),
    });
  }

  /**
   * A member shows the household a signed entitlement and it takes the plan (#48). Any member
   * may, read-only included: it is their money. The one that runs longest stands, so showing an
   * older one changes nothing.
   *
   * Nothing of the license is known here, and the slot is kept only hashed under a label of this
   * side's own, so this database and billing's have no value in common.
   */
  private async entitlement(request: Request): Promise<Response> {
    const secretHash = await this.credential(request);
    const body = await readJson(request, 4096);
    const keys = await importPublicKeys(this.env.ENTITLEMENT_PUBLIC_KEYS ?? '');
    const token = typeof body.entitlement === 'string' ? body.entitlement : '';
    const verdict = await verifyEntitlement(token, keys, Date.now());
    const slot = verdict.ok ? await sha256Hex(`mt1.do-slot|${verdict.claims.slot}`) : '';
    this.authorise(secretHash);
    // No key configured is the server's fault, and must not read to her as a bad purchase.
    if (keys.length === 0) throw new SyncError('unavailable', 503);
    if (!verdict.ok) {
      if (verdict.reason === 'expired') throw new SyncError('expired_entitlement', 409);
      throw new SyncError('invalid_entitlement', 400);
    }
    const row = [...this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', 'plan')][0];
    const stored = row ? JSON.parse(row.v) as StoredPlan : null;
    const best: StoredPlan = stored && stored.exp >= verdict.claims.exp
      ? stored
      : { plan: 'pro', exp: verdict.claims.exp, slot };
    if (best !== stored) this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', 'plan', JSON.stringify(best));
    return jsonResponse({ plan: this.plan(Date.now()), exp: best.exp });
  }

  /**
   * Who holds a token here: each device, by member and the moment it joined. The phones draw
   * people from their profiles, so one that paired and never published a profile reads the
   * household like anyone else and shows up in nobody's list — this is how the others see it.
   * Nothing is returned that the members could not already learn from each other.
   */
  private async devices(request: Request): Promise<Response> {
    this.authorise(await this.credential(request));
    // A vault's devices are all one member, so it is the device id that tells them apart, and
    // what `revoke` needs. A family's are told apart by member, as before.
    const vault = this.type() === 'personal';
    const devices = [...this.sql.exec<{ id: string; member_id: string; token_hash: string; added_at: number }>(
      'SELECT id, member_id, token_hash, added_at FROM device ORDER BY added_at, id',
    )].map((row) => ({ ...(vault ? { id: row.id } : {}), memberId: memberOf(row), addedAt: row.added_at }));
    return jsonResponse({ devices });
  }

  /**
   * A new secret for the calling device; the old one is gone the moment the row updates — the
   * same immediacy argument as revoke. Clients rotate opportunistically after a month, so a
   * token lifted from a backup or a bus-shoulder photo has a bounded useful life.
   */
  private async rotate(request: Request): Promise<Response> {
    const secretHash = await this.credential(request);
    const body = await readJson(request, 4096);
    if (body.secret !== undefined && (typeof body.secret !== 'string' || !/^[a-f0-9]{64}$/.test(body.secret))) {
      throw new SyncError('invalid_secret', 400);
    }
    const secret = typeof body.secret === 'string' ? body.secret : randomToken();
    const nextHash = await sha256Hex(secret);
    const auth = this.authorise(secretHash);
    const changed = [...this.sql.exec<{ id: string }>(
      'UPDATE device SET token_hash = ? WHERE id = ? AND token_hash = ? RETURNING id',
      nextHash,
      auth.id,
      auth.tokenHash,
    )];
    if (changed.length === 0) throw new SyncError('unauthorised', 401);
    return jsonResponse({ secret });
  }
}

/**
 * Cloudflare's own counters (wrangler.jsonc `ratelimits`): how many calls one key may make a
 * minute, counted per location. Friction, not a wall — permissive and eventually consistent by
 * design, so a flood spread across locations gets further; the caps inside the Durable Object
 * are what bounds a household's cost. Requests that never crossed the edge carry no
 * CF-Connecting-IP — tests and local workerd — and are exactly the callers not to throttle.
 */
async function throttled(limiter: RateLimit, request: Request, key: (ip: string) => string): Promise<boolean> {
  const ip = request.headers.get('cf-connecting-ip');
  return ip != null && !(await limiter.limit({ key: key(ip) })).success;
}

/** The calls that change who is in a household, rather than what it holds. */
const MEMBERSHIP_ROUTES = new Set([
  'invite', 'pair', 'identity', 'remove', 'leave', 'destroy', 'revoke', 'rotate', 'recovery_rotate', 'role',
  'invites_cancel', 'entitlement',
]);

/**
 * The page's policy, for the one asset response this Worker hands out: index.html at a path that
 * is no file, from a browser too old to mark the request as a navigation. Every file that exists
 * is served before this Worker runs, and gets the same headers from pwa/public/_headers; the
 * `<meta>` in index.html keeps the policy in a saved page. All three say the same thing, which
 * the tests check. `unsafe-inline` styles are real: the page ships its stylesheet as an inline
 * `<style>` and sizes figures with inline `style="--fit:…"` attributes. Scripts stay 'self' only.
 */
const ASSET_HEADERS = {
  'content-security-policy':
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

const handler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Without this, a page anywhere could create households from its visitors' addresses, and
      // a typeless POST would reach the rates Worker's JSON-only /feedback and /wallet-balance.
      const json = path.startsWith('/v1/') || path === '/wallet-balance' || path === '/feedback';
      if (json && request.method === 'POST' && !isJson(request)) {
        return jsonResponse({ code: 'unsupported_media_type' }, 415);
      }

      // Served from here so the PWA is same-origin with its prices. The rates Worker sets no
      // CORS headers at all today, and proxying is both cheaper and safer than teaching a
      // public endpoint to answer cross-origin — its own edge cache still does the work.
      // The dollar's daily history rides the same way: a GET the rates Worker caches for hours.
      // So does /history, whose whole question is in its query, which is public and goes along.
      if (path === '/rates' || path === '/usd-history' || path === '/history') {
        if (request.method !== 'GET') return textResponse('GET only\n', 405, 'GET');
        const origin = env.RATES_ORIGIN ?? DEFAULT_RATES_ORIGIN;
        // Two request headers are passed on: the day's count (see "usage" in the rates Worker),
        // and the browser's If-None-Match, so the PWA's no-cache revalidation can come back as a
        // 304 with headers instead of the whole coin catalogue over metered data.
        const headers: Record<string, string> = {};
        for (const name of ['x-muchtoman-daily', 'if-none-match']) {
          const value = request.headers.get(name);
          if (value != null) headers[name] = value;
        }
        const query = path === '/history' ? url.search : '';
        const upstream = await fetch(`${origin}${path}${query}`, { headers, signal: AbortSignal.timeout(8_000) });
        const etag = upstream.headers.get('etag');
        return new Response(upstream.body, {
          status: upstream.status,
          headers: {
            'content-type': upstream.headers.get('content-type') ?? 'application/json',
            'cache-control': upstream.headers.get('cache-control') ?? 'no-store',
            'x-content-type-options': 'nosniff',
            ...(etag == null ? {} : { etag }),
          },
        });
      }

      // The same reason for a wallet's balance, a coin's icon and the feedback form: the page may
      // only talk to its own origin. The body is capped here at the rates Worker's own cap, so an
      // oversized one never costs a subrequest.
      //
      // Ceiling, named: the rates Worker throttles /wallet-balance and /feedback per
      // CF-Connecting-IP, and from there every proxied request comes from this Worker — the
      // browsers share one bucket.
      if (path === '/wallet-balance' || path === '/feedback') {
        if (request.method !== 'POST') return textResponse('POST only\n', 405, 'POST');
        let body: string;
        try {
          body = await readTextLimited(request, path === '/feedback' ? MAX_FEEDBACK_BYTES : MAX_WALLET_REQUEST_BYTES);
        } catch (error) {
          if (error instanceof BodyTooLargeError) return jsonResponse({ code: 'invalid_request' }, 413);
          throw error;
        }
        const origin = env.RATES_ORIGIN ?? DEFAULT_RATES_ORIGIN;
        let upstream: Response;
        try {
          upstream = await fetch(`${origin}${path}`, {
            method: 'POST',
            // Passed on as sent, which isJson has already checked; a default here is how a typeless
            // cross-site POST used to arrive upstream looking like JSON.
            headers: { 'content-type': request.headers.get('content-type')! },
            body,
            signal: AbortSignal.timeout(15_000),
          });
        } catch (error) {
          console.error(JSON.stringify({ message: `${path} proxy failed`, error: errorMessage(error) }));
          return jsonResponse({ code: 'unavailable' }, 502);
        }
        const headers: Record<string, string> = {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        };
        const retryAfter = upstream.headers.get('retry-after');
        if (retryAfter) headers['retry-after'] = retryAfter;
        return new Response(upstream.body, { status: upstream.status, headers });
      }

      if (path === '/coin-icon') {
        if (request.method !== 'GET') return textResponse('GET only\n', 405, 'GET');
        const origin = env.RATES_ORIGIN ?? DEFAULT_RATES_ORIGIN;
        const upstream = await fetch(`${origin}/coin-icon${url.search}`, {
          signal: AbortSignal.timeout(8_000),
        });
        return new Response(upstream.body, {
          status: upstream.status,
          headers: {
            'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
            'cache-control': upstream.headers.get('cache-control') ?? 'no-store',
            'x-content-type-options': 'nosniff',
            // Bytes from a third party, on the page's own origin: opened directly, an SVG with a
            // script in it must run nothing and reach nothing.
            'content-security-policy': "default-src 'none'; sandbox",
          },
        });
      }

      if (path === '/v1/claim') {
        if (request.method !== 'POST') return textResponse('POST only\n', 405, 'POST');
        // The one write anybody may make unauthenticated: five new households a minute an address.
        if (await throttled(env.CLAIM_LIMIT, request, (ip) => ip)) return rateLimited();
        // A new household names itself; there is no registry to collide with because the id is
        // 32 random bytes and the object is created by being addressed.
        const hid = url.searchParams.get('hid') ?? '';
        if (!/^[a-f0-9]{16,64}$/.test(hid)) return jsonResponse({ code: 'invalid_hid' }, 400);
        return await env.HOUSEHOLD.getByName(hid).fetch(
          new Request('https://household/claim', {
            method: 'POST',
            headers: request.headers,
            body: request.body,
          }),
        );
      }

      // No token, no household to speak of: the protocol and the kinds, which are the same for
      // everyone and so may be cached. The call a client makes before it has any reason to hold a
      // token — or after a revoked one has been thrown away.
      if (
        path === '/v1/hello' && request.method === 'GET' &&
        request.headers.get('authorization') == null && request.headers.get('x-muchtoman-token') == null
      ) {
        if (await throttled(env.API_LIMIT, request, (ip) => ip)) return rateLimited();
        return jsonResponse(helloAnonymous(), 200, 'public, max-age=60');
      }

      // The one call with no token at all: the household is named in the body, and what proves the
      // caller is the recovery secret, which only the object can check. Throttled harder than
      // anything else, by address and by household, being the one place a long-lived secret is
      // offered.
      if (path === '/v1/recover' && request.method === 'POST') {
        if (await throttled(env.API_LIMIT, request, (ip) => ip)) return rateLimited();
        if (await throttled(env.RECOVER_LIMIT, request, (ip) => `ip:${ip}`)) return rateLimited();
        const body = await readJson(request, 4096);
        const hid = typeof body.hid === 'string' ? body.hid : '';
        if (!/^[a-f0-9]{16,64}$/.test(hid)) return jsonResponse({ code: 'invalid_hid' }, 400);
        if (await throttled(env.RECOVER_LIMIT, request, () => `hid:${hid}`)) return rateLimited();
        return await env.HOUSEHOLD.getByName(hid).fetch(
          new Request('https://household/recover', { method: 'POST', body: JSON.stringify(body) }),
        );
      }

      if (path.startsWith('/v1/')) {
        const token = splitToken(
          request.headers.get('authorization') ?? request.headers.get('x-muchtoman-token'),
        );
        if (!token) return jsonResponse({ code: 'unauthorised' }, 401);

        const route = routeOf(request.method, path);
        if (!route) return textResponse('not found\n', 404);

        // Every call, by address, generously: carriers here put many phones behind one address.
        // Then membership, which a real household changes a few times a year, by household and
        // address together — tight enough that a member cycling pair and remove gets nowhere,
        // and keyed so neither a stranger nor an ex-member elsewhere can spend a household's turn.
        if (await throttled(env.API_LIMIT, request, (ip) => ip)) return rateLimited();
        if (MEMBERSHIP_ROUTES.has(route) && await throttled(env.MEMBERSHIP_LIMIT, request, (ip) => `${token.hid}:${ip}`)) {
          return rateLimited();
        }

        const inner = new Request(`https://household/${route}${url.search}`, {
          method: request.method,
          headers: withSecret(request.headers, token.secret),
          body: request.body,
        });
        return await env.HOUSEHOLD.getByName(token.hid).fetch(inner);
      }

      // Anything else is the PWA's shell, at a path that is no file.
      const asset = await env.ASSETS.fetch(request);
      // Except a build file that is not there: a page from another deploy asking for its own
      // bundle. The shell fallback would answer index.html with a 200, which a service worker
      // installing across a deploy caches as the script, and every launch then dies on a MIME
      // error until the next release. A 404 fails that install instead, and the next one retries.
      if (path.startsWith('/assets/') && asset.headers.get('content-type')?.startsWith('text/html')) {
        return textResponse('not found\n', 404);
      }
      const headers = new Headers(asset.headers);
      for (const [name, value] of Object.entries(ASSET_HEADERS)) headers.set(name, value);
      return new Response(asset.body, { status: asset.status, headers });
    } catch (error) {
      if (error instanceof BodyTooLargeError) return jsonResponse({ code: 'body_too_large' }, 413);
      if (error instanceof SyncError) return jsonResponse({ code: error.code, ...error.details }, error.status);
      console.error(JSON.stringify({ message: 'sync failed', error: errorMessage(error) }));
      return jsonResponse({ code: 'internal' }, 500);
    }
  },
};

/** Every answer is counted, by endpoint, status, client version and error code, and nothing else (./metrics.ts). */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await handler.fetch(request, env);
    measure(env.METRICS, request, response.status, await errorCodeOf(response));
    return response;
  },
};

/** Both clients read a 429 as «too many requests, try again shortly», whatever the body says. */
function rateLimited(): Response {
  const response = jsonResponse({ code: 'rate_limited' }, 429);
  response.headers.set('retry-after', '60');
  return response;
}

/** The household half of the token never reaches the object; only the secret it must check. */
function withSecret(headers: Headers, secret: string): Headers {
  const copy = new Headers(headers);
  copy.delete('authorization');
  copy.delete('x-muchtoman-token');
  copy.set('x-device-secret', secret);
  return copy;
}
