import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import source from '../src/index.ts?raw';
import { dataPoint, ERROR_CODES } from '../src/metrics';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

/** What billing counts. The tests that matter are the negative ones: nothing of the request gets in. */

function spy() {
  const points: AnalyticsEngineDataPoint[] = [];
  return { points, dataset: { writeDataPoint: (p?: AnalyticsEngineDataPoint) => { points.push(p!); } } as AnalyticsEngineDataset };
}

const LICENSE = 'deadbeef'.repeat(4);

async function call(dataset: AnalyticsEngineDataset, path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`https://pay.test${path}`, init), { ...env, METRICS: dataset });
}

describe('what billing counts', () => {
  it('is one row of four strings an answer, with the code of a refusal', async () => {
    const { points, dataset } = spy();
    await call(dataset, '/v1/health', { headers: { 'x-muchtoman-client': '1.4.2 pwa' } });
    await call(dataset, `/v1/license/${LICENSE}`);
    expect(points).toEqual([
      { indexes: ['health'], blobs: ['health', '200', '1.4.2 pwa', ''], doubles: [1] },
      { indexes: ['unknown'], blobs: ['unknown', '404', 'unknown', 'not_found'], doubles: [1] },
    ]);
  });

  it('never holds anything the request carried', async () => {
    const { points, dataset } = spy();
    await call(dataset, `/v1/nothing?license=${LICENSE}`, {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.9', 'x-muchtoman-client': LICENSE.repeat(2), authorization: `Bearer ${LICENSE}` },
      body: JSON.stringify({ license: LICENSE, amount: 1250000 }),
    });
    const everything = JSON.stringify(points);
    for (const leak of [LICENSE, '203.0.113.9', '1250000', 'Bearer', 'license']) expect(everything).not.toContain(leak);
  });

  it('takes a code from the fixed list only, which holds every one the Worker says', () => {
    expect(dataPoint('health', 500, null, 'no such table: license').blobs![3]).toBe('other');
    const said = [...source.matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1]);
    expect(said.length).toBeGreaterThan(2);
    for (const code of said) expect(ERROR_CODES as readonly string[], code).toContain(code);
  });

  it('is never why a request fails', async () => {
    const throwing = { writeDataPoint: () => { throw new Error('analytics is down'); } } as unknown as AnalyticsEngineDataset;
    expect((await call(throwing, '/v1/health')).status).toBe(200);
  });
});
