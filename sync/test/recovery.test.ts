import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

/**
 * Recovery of a vault with every phone gone: the secret from her kit enrols a new one, and nothing
 * else about it is ever said — not to a wrong guess, and not to the logs.
 */

const json = { 'content-type': 'application/json' };
const SCOPE = 'vault:r';
const MEMBER = 'a1'.repeat(16);
const KIT = 'c4'.repeat(32);
const NEW_KIT = 'e5'.repeat(32);

let next = 0;
function freshHid(): string {
  next += 1;
  return `9e${next.toString(16).padStart(2, '0')}`.repeat(8);
}

function claimAs(hid: string, over: Record<string, unknown>) {
  return SELF.fetch(`https://sync.test/v1/claim?hid=${hid}`, {
    method: 'POST', headers: json,
    body: JSON.stringify({ scopes: [SCOPE], memberId: MEMBER, deviceId: 'd0'.repeat(16), ...over }),
  });
}

async function vault(over: Record<string, unknown> = { type: 'personal', recovery: KIT }) {
  const hid = freshHid();
  const res = await claimAs(hid, over);
  expect(res.status).toBe(200);
  const { secret } = (await res.json()) as { secret: string };
  return { hid, token: `${hid}.${secret}` };
}

interface Answer {
  code?: string; secret?: string; scopes?: string[]; memberId?: string; deviceId?: string;
  devices?: { id: string; addedAt: number }[];
}

async function recover(body: unknown, headers: Record<string, string> = {}) {
  const res = await SELF.fetch('https://sync.test/v1/recover', {
    method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Answer };
}

function post(path: string, token: string, body: unknown) {
  return SELF.fetch(`https://sync.test${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, ...json }, body: JSON.stringify(body),
  });
}

const get = (path: string, token: string) => SELF.fetch(`https://sync.test${path}`, { headers: { authorization: `Bearer ${token}` } });

const inside = <T>(hid: string, read: (sql: SqlStorage) => T) =>
  runInDurableObject(env.HOUSEHOLD.getByName(hid), async (_i, state) => read(state.storage.sql));

describe('POST /v1/recover', () => {
  it('enrols a new device with the kit, which then reads the vault', async () => {
    const v = await vault();
    expect((await post('/v1/sync', v.token, { records: [{ id: 'sms:1', kind: 'sms', scope: SCOPE, updatedAt: 1, device: 'p', nonce: 'nn', body: 'YQ==' }] })).status).toBe(200);

    const got = await recover({ hid: v.hid, recovery: KIT, deviceId: 'd9'.repeat(16) });
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ scopes: [SCOPE], memberId: MEMBER, deviceId: 'd9'.repeat(16) });
    const pulled = (await (await get('/v1/sync?since=0', `${v.hid}.${got.body.secret}`)).json()) as { records: { id: string }[] };
    expect(pulled.records.map((r) => r.id)).toEqual(['sms:1']);
    // The old phone is not put out by it, and the kit still works.
    expect((await get('/v1/sync?since=0', v.token)).status).toBe(200);
    expect((await recover({ hid: v.hid, recovery: KIT })).status).toBe(200);
  });

  it('keeps a hash of the secret and not the secret', async () => {
    const v = await vault();
    const meta = await inside(v.hid, (sql) => [...sql.exec<{ k: string; v: string }>('SELECT k, v FROM meta')]);
    expect(meta.find((row) => row.k === 'recovery_hash')!.v).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(meta)).not.toContain(KIT);
  });

  it('answers every failure the same way, and enrols nobody', async () => {
    const v = await vault();
    const bare = await vault({ type: 'personal' });
    const family = await vault({});
    const failures = [
      { hid: v.hid, recovery: NEW_KIT },
      { hid: v.hid, recovery: '' },
      { hid: v.hid },
      { hid: v.hid, recovery: KIT.toUpperCase() },
      { hid: bare.hid, recovery: KIT },
      { hid: family.hid, recovery: KIT },
      { hid: 'ab'.repeat(16), recovery: KIT },
    ];
    for (const body of failures) {
      expect(await recover(body), JSON.stringify(body)).toEqual({ status: 404, body: { code: 'not_recoverable' } });
    }
    expect(await inside(v.hid, (sql) => [...sql.exec('SELECT id FROM device')].length)).toBe(1);
    // Asking about a household nobody claimed makes none.
    expect(await inside('ab'.repeat(16), (sql) => [...sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'")])).toEqual([]);
  });

  it('refuses a body that is not JSON, too large, or names no household', async () => {
    expect(await recover({ recovery: KIT })).toEqual({ status: 400, body: { code: 'invalid_hid' } });
    expect(await recover([KIT])).toEqual({ status: 400, body: { code: 'invalid_request' } });
    expect((await recover({ hid: 'a'.repeat(32), pad: 'x'.repeat(5000) })).status).toBe(413);
    const form = await SELF.fetch('https://sync.test/v1/recover', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(form.status).toBe(415);
  });

  it('holds the device limit, and swaps one out when asked', async () => {
    const v = await vault();
    await inside(v.hid, (sql) => {
      for (let i = 1; i < 16; i++) {
        sql.exec(
          'INSERT INTO device (id, member_id, identity_locked, token_hash, scopes, added_at, last_seen) VALUES (?, ?, 1, ?, ?, ?, ?)',
          `old-${i}`, MEMBER, `${i}`.padStart(64, '0'), JSON.stringify([SCOPE]), i, i,
        );
      }
    });
    const full = await recover({ hid: v.hid, recovery: KIT, deviceId: 'd9'.repeat(16) });
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('too_many_devices');
    expect(full.body.devices).toHaveLength(16);
    expect(full.body.devices![0]).toEqual({ id: 'old-1', addedAt: 1 });

    expect(await recover({ hid: v.hid, recovery: KIT, revoke: 'nobody' })).toEqual({ status: 404, body: { code: 'unknown_device' } });
    const swapped = await recover({ hid: v.hid, recovery: KIT, deviceId: 'd9'.repeat(16), revoke: 'old-1' });
    expect(swapped.status).toBe(200);
    const ids = await inside(v.hid, (sql) => [...sql.exec<{ id: string }>('SELECT id FROM device')].map((r) => r.id));
    expect(ids).toHaveLength(16);
    expect(ids).not.toContain('old-1');
    expect(ids).toContain('d9'.repeat(16));
  });

  it('drops the codes a revoked phone may have shown', async () => {
    const v = await vault();
    expect((await post('/v1/invite', v.token, {})).status).toBe(200);
    await recover({ hid: v.hid, recovery: KIT, revoke: 'd0'.repeat(16) });
    expect(await inside(v.hid, (sql) => [...sql.exec('SELECT 1 FROM pairing')])).toEqual([]);
    expect((await get('/v1/sync?since=0', v.token)).status).toBe(401);
  });

  it('is limited by address and by household', async () => {
    const into = Date.now() % 60_000;
    if (into > 50_000) await new Promise((resolve) => setTimeout(resolve, 60_000 - into + 100));
    const v = await vault();
    const from = (ip: string) => recover({ hid: v.hid, recovery: NEW_KIT }, { 'cf-connecting-ip': ip });
    for (let i = 0; i < 5; i++) expect((await from('203.0.113.20')).status).toBe(404);
    expect((await from('203.0.113.20')).status).toBe(429);
    // The same household from another address is out of turns too.
    expect((await from('203.0.113.21')).status).toBe(429);
  }, 30_000);
});

describe('POST /v1/recovery/rotate', () => {
  it('replaces the kit: the old secret recovers nothing from then on', async () => {
    const v = await vault();
    const rotated = await post('/v1/recovery/rotate', v.token, { recovery: NEW_KIT });
    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toEqual({ rotated: true });
    expect((await recover({ hid: v.hid, recovery: KIT })).status).toBe(404);
    expect((await recover({ hid: v.hid, recovery: NEW_KIT })).status).toBe(200);
  });

  it('gives a vault made without a kit its first one', async () => {
    const v = await vault({ type: 'personal' });
    expect((await post('/v1/recovery/rotate', v.token, { recovery: KIT })).status).toBe(200);
    expect((await recover({ hid: v.hid, recovery: KIT })).status).toBe(200);
  });

  it('needs a token, a vault, and 32 bytes', async () => {
    const v = await vault();
    const family = await vault({});
    expect((await post('/v1/recovery/rotate', `${v.hid}.${'0'.repeat(64)}`, { recovery: NEW_KIT })).status).toBe(401);
    expect(await (await post('/v1/recovery/rotate', family.token, { recovery: NEW_KIT })).json()).toEqual({ code: 'forbidden_type' });
    for (const recovery of ['short', 'g'.repeat(64), 7]) {
      expect(await (await post('/v1/recovery/rotate', v.token, { recovery })).json()).toEqual({ code: 'invalid_recovery' });
    }
    expect((await recover({ hid: v.hid, recovery: KIT })).status).toBe(200);
  });
});

describe('claim with a kit', () => {
  it('is for a vault, and must be 32 bytes; a refused claim leaves the id free', async () => {
    const hid = freshHid();
    expect(await (await claimAs(hid, { recovery: KIT })).json()).toEqual({ code: 'forbidden_type' });
    expect(await (await claimAs(hid, { type: 'personal', recovery: 'nope' })).json()).toEqual({ code: 'invalid_recovery' });
    expect((await claimAs(hid, { type: 'personal', recovery: KIT })).status).toBe(200);
  });
});

describe('a vault’s device list', () => {
  it('names each device so one can be revoked; a family’s is as it was', async () => {
    const v = await vault();
    const family = await vault({});
    const list = async (token: string) => ((await (await get('/v1/devices', token)).json()) as { devices: Record<string, unknown>[] }).devices;
    expect(Object.keys((await list(v.token))[0]).sort()).toEqual(['addedAt', 'id', 'memberId']);
    expect(Object.keys((await list(family.token))[0]).sort()).toEqual(['addedAt', 'memberId']);
  });
});

describe('the recovery secret', () => {
  it('is in no answer and no log line, whatever goes wrong', async () => {
    const said: unknown[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { said.push(...args); }));
    const v = await vault();
    const answers = [
      await recover({ hid: v.hid, recovery: KIT }),
      await recover({ hid: v.hid, recovery: NEW_KIT }),
      await (await post('/v1/recovery/rotate', v.token, { recovery: NEW_KIT })).json(),
      await recover({ hid: v.hid, recovery: NEW_KIT }),
    ];
    // A body that is not JSON, secret and all: V8's message would quote it, so it must not be logged.
    await SELF.fetch('https://sync.test/v1/recover', { method: 'POST', headers: json, body: `{"recovery":"${KIT}` });
    // And a household that fails inside: the log line is the error's, never the request's.
    await inside(v.hid, (sql) => sql.exec('ALTER TABLE device RENAME TO device_gone'));
    expect((await recover({ hid: v.hid, recovery: NEW_KIT })).status).toBe(500);
    spies.forEach((spy) => spy.mockRestore());

    // The spies did see the object's log, or the two lines below would prove nothing.
    expect(said.map(String).join('\n')).toContain('household failed');
    const everything = JSON.stringify([answers, said.map(String)]);
    expect(everything).not.toContain(KIT);
    expect(everything).not.toContain(NEW_KIT);
  });
});
