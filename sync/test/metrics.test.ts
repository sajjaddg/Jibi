import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { clientOf, dataPoint, ERROR_CODES, endpointOf, errorCodeOf, measure } from '../src/metrics';
import source from '../src/index.ts?raw';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

/**
 * What the service counts about itself is endpoint, status and client version. The tests that
 * matter are the negative ones: whatever a request carries — a household id in the token, a
 * secret, an address, a scope, anything in the client header — none of it reaches a datapoint.
 */

function spy() {
  const points: AnalyticsEngineDataPoint[] = [];
  return { points, dataset: { writeDataPoint: (p?: AnalyticsEngineDataPoint) => { points.push(p!); } } as AnalyticsEngineDataset };
}

const HID = 'ab'.repeat(16);
const SECRET = 'cd'.repeat(32);

async function call(dataset: AnalyticsEngineDataset, path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`https://sync.test${path}`, init), { ...env, METRICS: dataset });
}

describe('endpoint names', () => {
  it('are the routes the object knows, and «unknown» for any other API path', () => {
    expect(endpointOf('GET', '/v1/sync')).toBe('pull');
    expect(endpointOf('POST', '/v1/sync')).toBe('push');
    expect(endpointOf('POST', '/v1/claim')).toBe('claim');
    expect(endpointOf('GET', '/v1/devices')).toBe('devices');
    // The route table is also what dispatches, so one missing from it is a 404, not just a miscount.
    expect(endpointOf('GET', '/v1/hello')).toBe('hello');
    expect(endpointOf('POST', '/v1/destroy')).toBe('destroy');
    expect(endpointOf('DELETE', '/v1/sync')).toBe('unknown');
    // A path a visitor made up is one label, not a row per guess.
    expect(endpointOf('GET', `/v1/${HID}`)).toBe('unknown');
  });

  it('are not given to the page or the rates proxy', () => {
    expect(endpointOf('GET', '/')).toBeNull();
    expect(endpointOf('GET', '/rates')).toBeNull();
    expect(endpointOf('POST', '/feedback')).toBeNull();
  });
});

describe('the client version', () => {
  it('is kept when it looks like a version and a platform', () => {
    expect(clientOf('1.4.2 android')).toBe('1.4.2 android');
    expect(clientOf('1.4.2 pwa')).toBe('1.4.2 pwa');
    expect(clientOf('2.0.0-rc.1+3 android')).toBe('2.0.0-rc.1+3 android');
  });

  it('is «unknown» for anything else, so a header cannot smuggle an identifier in', () => {
    expect(clientOf(null)).toBe('unknown');
    expect(clientOf('')).toBe('unknown');
    expect(clientOf(SECRET)).toBe('unknown');
    expect(clientOf(`${HID}.${SECRET}`)).toBe('unknown');
    expect(clientOf('x'.repeat(33))).toBe('unknown');
    expect(clientOf('1.0 <script>')).toBe('unknown');
    expect(clientOf('1.0\nnext: line')).toBe('unknown');
    expect(clientOf('🙂')).toBe('unknown');
  });
});

describe('what is written', () => {
  it('is four strings and a count, in that shape and no other', () => {
    expect(dataPoint('push', 409, '1.4.2 android', 'household_full')).toEqual({
      indexes: ['push'], blobs: ['push', '409', '1.4.2 android', 'household_full'], doubles: [1],
    });
    expect(dataPoint('push', 200, '1.4.2 android').blobs).toEqual(['push', '200', '1.4.2 android', '']);
  });

  it('takes a code from the fixed list only: anything else is «other», never the text itself', () => {
    for (const leak of [HID, SECRET, 'family:private-scope', 'no such table: record', 'household_full ']) {
      expect(dataPoint('push', 500, null, leak).blobs![3]).toBe('other');
    }
  });

  it('lists every code the Worker can answer with', () => {
    const said = [...source.matchAll(/new SyncError\('([a-z_]+)'|code: '([a-z_]+)'/g)].map((m) => m[1] ?? m[2]);
    expect(said.length).toBeGreaterThan(30);
    for (const code of said) expect(ERROR_CODES as readonly string[], code).toContain(code);
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('reads a refusal’s code from a copy, and leaves the answer whole', async () => {
    const refusal = Response.json({ code: 'household_full' }, { status: 409 });
    expect(await errorCodeOf(refusal)).toBe('household_full');
    expect(await refusal.json()).toEqual({ code: 'household_full' });
    expect(await errorCodeOf(Response.json({ code: 'x' }))).toBe('');
    expect(await errorCodeOf(new Response('not found\n', { status: 404 }))).toBe('');
    expect(await errorCodeOf(new Response('{', { status: 500, headers: { 'content-type': 'application/json' } }))).toBe('');
  });

  it('is one datapoint per API answer, with the status the client was given', async () => {
    const { points, dataset } = spy();
    const missing = await call(dataset, '/v1/sync?since=0', { headers: { authorization: `Bearer ${HID}.${SECRET}`, 'x-muchtoman-client': '1.4.2 android' } });
    expect(missing.status).toBe(401);
    const nowhere = await call(dataset, '/v1/nothing', { headers: { authorization: `Bearer ${HID}.${SECRET}` } });
    expect(nowhere.status).toBe(404);
    const claimed = await call(dataset, `/v1/claim?hid=${HID}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-muchtoman-client': '1.4.2 pwa' }, body: JSON.stringify({ scopes: ['family:x'] }),
    });
    expect(claimed.status).toBe(200);
    const page = await call(dataset, '/anything-the-page-owns');
    expect(page.status).toBeLessThan(500);

    expect(points).toEqual([
      { indexes: ['pull'], blobs: ['pull', '401', '1.4.2 android', 'unauthorised'], doubles: [1] },
      { indexes: ['unknown'], blobs: ['unknown', '404', 'unknown', ''], doubles: [1] },
      { indexes: ['claim'], blobs: ['claim', '200', '1.4.2 pwa', ''], doubles: [1] },
    ]);
  });

  it('never holds a household id, a secret, an address, a scope or anything else the request carried', async () => {
    const { points, dataset } = spy();
    const claim = await call(dataset, `/v1/claim?hid=${HID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', 'x-muchtoman-client': `${HID}.${SECRET}` },
      body: JSON.stringify({ scopes: ['family:private-scope'], memberId: 'ee'.repeat(16), deviceId: 'ff'.repeat(16) }),
    });
    const { secret } = (await claim.json()) as { secret: string };
    await call(dataset, '/v1/sync', {
      method: 'POST',
      headers: { authorization: `Bearer ${HID}.${secret}`, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
      body: JSON.stringify({ records: [{ id: 'txn:secret-id', scope: 'family:private-scope', updatedAt: 1, device: 'p', nonce: 'nn', body: 'c2VjcmV0LWJvZHk=' }] }),
    });
    await call(dataset, `/v1/sync?since=0&hid=${HID}`, { headers: { 'x-muchtoman-token': `${HID}.${secret}`, 'cf-connecting-ip': '203.0.113.7' } });

    expect(points.length).toBe(3);
    const everything = JSON.stringify(points);
    for (const leak of [HID, SECRET, secret, '203.0.113.7', 'private-scope', 'secret-id', 'ee'.repeat(16), 'ff'.repeat(16), 'c2VjcmV0', 'Bearer']) {
      expect(everything, leak).not.toContain(leak);
    }
    for (const point of points) {
      expect(Object.keys(point).sort()).toEqual(['blobs', 'doubles', 'indexes']);
      expect(point.blobs).toHaveLength(4);
      expect(['', ...ERROR_CODES]).toContain(point.blobs![3]);
      expect(point.blobs![0]).toMatch(/^[a-z]+$/);
      expect(point.blobs![1]).toMatch(/^\d{3}$/);
      expect(point.doubles).toEqual([1]);
    }
  });
});

describe('counting', () => {
  it('is never why a request fails: a dataset that throws, or none at all, changes nothing', async () => {
    const throwing = { writeDataPoint: () => { throw new Error('analytics is down'); } } as unknown as AnalyticsEngineDataset;
    const headers = { authorization: `Bearer ${HID}.${SECRET}` };
    expect((await call(throwing, '/v1/nothing', { headers })).status).toBe(404);
    const bare = await worker.fetch(new Request('https://sync.test/v1/nothing', { headers }), { ...env, METRICS: undefined as unknown as AnalyticsEngineDataset });
    expect(bare.status).toBe(404);
    expect(() => measure(undefined, new Request('https://sync.test/v1/sync'), 200)).not.toThrow();
  });
});
