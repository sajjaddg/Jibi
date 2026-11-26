import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { recordHistory } from '../src/index';
import {
  HISTORY_MAX_DAYS,
  monthKey,
  readIndex,
  readSeries,
  recordRates,
  slice,
  type HistoryBucket,
} from '../src/history';
import config from '../wrangler.jsonc?raw';

/**
 * The daily point and GET /history, over a bucket that is a map. What must hold: a day without a
 * rate is not in the answer at all, never a zero, and nothing already written is written over.
 */

/** 2026-11-26, a Thursday. */
const DAY = Math.floor(Date.UTC(2026, 10, 26) / 86_400_000);
const NOON = DAY * 86_400_000 + 45_000_000;

function bucket(objects: Record<string, string> = {}) {
  const stored = new Map(Object.entries(objects));
  const reads: string[] = [];
  const r2: HistoryBucket = {
    get: async (key) => {
      reads.push(key);
      const value = stored.get(key);
      return value == null ? null : { text: async () => value };
    },
    put: async (key, value) => { stored.set(key, value); },
  };
  return { r2, stored, reads, month: (day: number) => JSON.parse(stored.get(monthKey(day))!).days };
}

/** The edge cache and the request context, as usdHistory.test.ts stands them in. */
function edge() {
  const cache = new Map<string, string>();
  vi.stubGlobal('caches', { default: {
    match: async (request: Request) => {
      const hit = cache.get(request.url);
      return hit == null ? undefined : new Response(hit);
    },
    put: async (request: Request, response: Response) => { cache.set(request.url, await response.text()); },
  } });
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;
  return { cache, pending, ctx };
}

function client(r2: HistoryBucket | undefined) {
  const { cache, pending, ctx } = edge();
  const env = { ASSETS: {} as Fetcher, HISTORY: r2 as unknown as R2Bucket | undefined };
  return {
    cache,
    get: async (query: string) => {
      const res = await worker.fetch(new Request(`https://rates.muchtoman.com/history?${query}`), env, ctx);
      await Promise.all(pending);
      return { res, body: (await res.json()) as { days: Record<string, number>; code?: string; step?: string; asset?: string } };
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the daily point', () => {
  it('keeps catalogue assets that had a rate, and leaves the others out rather than at zero', async () => {
    const b = bucket();
    const added = await recordRates(b.r2, DAY, { usd: 187_000, btc: 1.2e10, eur: 0, shib: 1.5, random: 9 }, ['usd', 'eur', 'gold18', 'btc', 'shib', 'toman']);
    expect(added).toBe(3);
    expect(b.month(DAY)).toEqual({ [DAY]: { usd: 187_000, btc: 1.2e10, shib: 1.5 } });
    expect(await readIndex(b.r2)).toEqual({ first: DAY, assets: ['btc', 'shib', 'usd'] });
  });

  it('writes nothing for a day nothing in the catalogue was priced', async () => {
    const b = bucket();
    expect(await recordRates(b.r2, DAY, {}, ['usd'])).toBe(0);
    expect(b.stored.size).toBe(0);
  });

  it('does not rewrite a figure on a second run, only fills what was missing', async () => {
    const b = bucket();
    await recordRates(b.r2, DAY, { usd: 187_000 }, ['usd', 'eur']);
    expect(await recordRates(b.r2, DAY, { usd: 999, eur: 218_000 }, ['usd', 'eur'])).toBe(1);
    expect(b.month(DAY)[DAY]).toEqual({ usd: 187_000, eur: 218_000 });
  });

  it('still records a known coin on a day the coin catalogue is down', async () => {
    const b = bucket();
    await recordRates(b.r2, DAY, { usd: 187_000, btc: 1.2e10 }, ['usd', 'btc']);
    await recordRates(b.r2, DAY + 1, { usd: 188_000, btc: 1.3e10 }, ['usd']);
    expect(b.month(DAY)[DAY + 1]).toEqual({ usd: 188_000, btc: 1.3e10 });
  });

  it('starts a new object each month and keeps the first day', async () => {
    const b = bucket();
    await recordRates(b.r2, DAY, { usd: 1 }, ['usd']);
    await recordRates(b.r2, DAY + 7, { usd: 2 }, ['usd']);
    expect([...b.stored.keys()].sort()).toEqual(['v1/2026-11.json', 'v1/2026-12.json', 'v1/index.json']);
    expect((await readIndex(b.r2))!.first).toBe(DAY);
  });

  it('never writes over a month it cannot read', async () => {
    const b = bucket({ [monthKey(DAY)]: '{"days":' });
    await expect(recordRates(b.r2, DAY, { usd: 1 }, ['usd'])).rejects.toThrow();
    expect(b.stored.get(monthKey(DAY))).toBe('{"days":');
  });

  it('writes nothing at all when every source is down', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('down'); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const b = bucket();
    await expect(recordHistory(b.r2, NOON)).rejects.toThrow('no rates to record');
    expect(b.stored.size).toBe(0);
    const scheduled = worker.scheduled({ scheduledTime: NOON } as ScheduledController, { ASSETS: {} as Fetcher, HISTORY: b.r2 as unknown as R2Bucket });
    await expect(scheduled).rejects.toThrow();
    vi.restoreAllMocks();
  });

  it('is asked for once a day, from a bucket the config names', () => {
    expect(config).toContain('"crons": ["30 12 * * *"]');
    expect(config).toContain('"bucket_name": "muchtoman-history"');
  });
});

describe('reading a series', () => {
  it('reads only the months from the first record, and never further back than the window', async () => {
    const b = bucket();
    await recordRates(b.r2, DAY - 40, { usd: 1 }, ['usd']);
    await recordRates(b.r2, DAY, { usd: 2 }, ['usd']);
    b.reads.length = 0;
    expect(await readSeries(b.r2, await readIndex(b.r2), 'usd', DAY)).toEqual({ [DAY - 40]: 1, [DAY]: 2 });
    expect(b.reads).toEqual(['v1/index.json', 'v1/2026-10.json', 'v1/2026-11.json']);

    b.reads.length = 0;
    await readSeries(b.r2, { first: 0, assets: ['usd'] }, 'usd', DAY);
    expect(b.reads.length).toBeLessThanOrEqual(38);
    expect(await readSeries(b.r2, await readIndex(b.r2), 'usd', DAY + HISTORY_MAX_DAYS)).toEqual({});
  });

  it('gives a week as its last day that has a rate, a week starting on Saturday', () => {
    // DAY is a Thursday; DAY+1 Friday ends that week and DAY+2 Saturday opens the next.
    const series = { [DAY - 1]: 1, [DAY]: 2, [DAY + 2]: 3, [DAY + 3]: 4, [DAY + 16]: 5 };
    expect(slice(series, 0, DAY + 100, 'week')).toEqual({ [DAY]: 2, [DAY + 3]: 4, [DAY + 16]: 5 });
    expect(slice(series, DAY, DAY + 2, 'day')).toEqual({ [DAY]: 2, [DAY + 2]: 3 });
  });
});

describe('GET /history', () => {
  async function recorded() {
    const b = bucket();
    await recordRates(b.r2, DAY - 3, { usd: 185_000, btc: 1.1e10 }, ['usd', 'btc']);
    await recordRates(b.r2, DAY - 1, { usd: 186_000 }, ['usd']);
    await recordRates(b.r2, DAY, { usd: 187_000 }, ['usd']);
    vi.useFakeTimers();
    vi.setSystemTime(NOON);
    return b;
  }

  it('answers the days it has; a day without a rate is absent, not zero', async () => {
    const b = await recorded();
    const { get } = client(b.r2);
    const { res, body } = await get('asset=usd');
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ asset: 'usd', step: 'day', oldest: DAY - HISTORY_MAX_DAYS + 1 });
    expect(body.days).toEqual({ [DAY - 3]: 185_000, [DAY - 1]: 186_000, [DAY]: 187_000 });
    expect(res.headers.get('cache-control')).toBe('public, max-age=21600');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await get('asset=btc')).body.days).toEqual({ [DAY - 3]: 1.1e10 });
  });

  it('cuts to from and to without reading the bucket again', async () => {
    const b = await recorded();
    const { get, cache } = client(b.r2);
    await get('asset=usd');
    b.reads.length = 0;
    expect((await get(`asset=usd&from=${DAY - 1}&to=${DAY - 1}`)).body.days).toEqual({ [DAY - 1]: 186_000 });
    expect((await get(`asset=usd&from=${DAY - 2}&step=week`)).body.days).toEqual({ [DAY]: 187_000 });
    expect(b.reads).toEqual([]);
    expect(cache.size).toBe(1);
  });

  it('knows a catalogue asset it has no days for, and refuses an id that is none', async () => {
    const b = await recorded();
    const { get, cache } = client(b.r2);
    const silver = await get('asset=silver_999');
    expect(silver.res.status).toBe(200);
    expect(silver.body.days).toEqual({});
    b.reads.length = 0;
    const made = await get('asset=notacoin');
    expect(made.res.status).toBe(404);
    expect(made.body).toEqual({ code: 'unknown_asset' });
    // The index and nothing else: no month read, nothing cached under a made-up name.
    expect(b.reads).toEqual(['v1/index.json']);
    expect(cache.size).toBe(1);
  });

  it('refuses a query that makes no sense', async () => {
    const { get } = client((await recorded()).r2);
    for (const query of ['', 'asset=', 'asset=USD', `asset=${'a'.repeat(65)}`, 'asset=usd&step=month', 'asset=usd&from=yesterday', 'asset=usd&from=2&to=1', 'asset=usd&to=-1']) {
      const { res, body } = await get(query);
      expect(res.status, query).toBe(400);
      expect(body).toEqual({ code: 'invalid_request' });
    }
  });

  it('answers 503 with no bucket, 502 when the bucket fails, and 405 to a POST', async () => {
    expect((await client(undefined).get('asset=usd')).res.status).toBe(503);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = client({ get: async () => { throw new Error('r2 down'); }, put: async () => undefined });
    expect((await broken.get('asset=usd')).res.status).toBe(502);
    spy.mockRestore();
    const { ctx } = edge();
    const post = await worker.fetch(new Request('https://rates.muchtoman.com/history', { method: 'POST' }), { ASSETS: {} as Fetcher }, ctx);
    expect(post.status).toBe(405);
  });
});
