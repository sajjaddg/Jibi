/**
 * B0.4 (#18), a throwaway: can a Cloudflare Worker reach the stores' and gateways' APIs at all?
 *
 * It sends each service one request that carries no credential — made-up merchant ids and tokens —
 * and reports what came back and how long it took. Any HTTP answer, a refusal included, means
 * «reachable»; a timeout or a connection error means «not from here». Nothing is stored or logged.
 *
 * Deploy, read, delete: README.md beside this file. It is not part of any service.
 */

interface Probe {
  service: string;
  call: string;
  method: 'GET' | 'POST';
  url: string;
  /** Only ever placeholders: nothing here authenticates anybody. */
  body?: unknown;
  /** Whether the vendor's own documentation was read for this URL (README.md). */
  documented: boolean;
}

const NOBODY = '00000000-0000-0000-0000-000000000000';

export const PROBES: Probe[] = [
  {
    service: 'bazaar', call: 'validate in-app', method: 'GET', documented: false,
    url: 'https://pardakht.cafebazaar.ir/devapi/v2/api/validate/com.example.app/inapp/example/purchases/example/',
  },
  {
    service: 'bazaar', call: 'subscription', method: 'GET', documented: false,
    url: 'https://pardakht.cafebazaar.ir/devapi/v2/api/applications/com.example.app/subscriptions/example/purchases/example/',
  },
  {
    service: 'myket', call: 'verify purchase', method: 'GET', documented: true,
    url: 'https://developer.myket.ir/api/applications/com.example.app/purchases/products/example/tokens/example',
  },
  {
    service: 'zarinpal', call: 'request', method: 'POST', documented: true,
    url: 'https://payment.zarinpal.com/pg/v4/payment/request.json',
    body: { merchant_id: NOBODY, amount: 10_000, description: 'reach test', callback_url: 'https://example.com/' },
  },
  {
    service: 'zarinpal', call: 'verify', method: 'POST', documented: true,
    url: 'https://payment.zarinpal.com/pg/v4/payment/verify.json',
    body: { merchant_id: NOBODY, amount: 10_000, authority: 'A00000000000000000000000000000000000' },
  },
  {
    service: 'zibal', call: 'request', method: 'POST', documented: false,
    url: 'https://gateway.zibal.ir/v1/request',
    body: { merchant: 'reach-test', amount: 10_000, callbackUrl: 'https://example.com/' },
  },
  {
    service: 'zibal', call: 'verify', method: 'POST', documented: false,
    url: 'https://gateway.zibal.ir/v1/verify',
    body: { merchant: 'reach-test', trackId: 1 },
  },
  {
    service: 'payping', call: 'pay', method: 'POST', documented: false,
    url: 'https://api.payping.ir/v3/pay',
    body: { amount: 1_000, returnUrl: 'https://example.com/' },
  },
  {
    service: 'idpay', call: 'payment', method: 'POST', documented: false,
    url: 'https://api.idpay.ir/v1.1/payment',
    body: { order_id: 'reach-test', amount: 10_000, callback: 'https://example.com/' },
  },
];

const TIMEOUT_MS = 10_000;

export interface Result {
  service: string;
  call: string;
  documented: boolean;
  status: number | null;
  ms: number;
  /** The start of the answer, which is what tells a block page from an API refusing a bad token. */
  answer: string;
  error: string | null;
}

export async function run(probe: Probe, fetcher: typeof fetch = fetch): Promise<Result> {
  const base = { service: probe.service, call: probe.call, documented: probe.documented };
  const started = Date.now();
  try {
    const response = await fetcher(probe.url, {
      method: probe.method,
      headers: { accept: 'application/json', ...(probe.body ? { 'content-type': 'application/json' } : {}) },
      body: probe.body ? JSON.stringify(probe.body) : undefined,
      // A redirect is itself an answer, and following one would hide it.
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const answer = (await response.text()).slice(0, 200);
    return { ...base, status: response.status, ms: Date.now() - started, answer, error: null };
  } catch (error) {
    const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 200);
    return { ...base, status: null, ms: Date.now() - started, answer: '', error: message };
  }
}

export default {
  async fetch(request: Request, env: { SPIKE_KEY?: string }): Promise<Response> {
    // Closed unless the secret is set and sent, so a stranger cannot make it call anyone.
    if (!env.SPIKE_KEY || request.headers.get('x-spike-key') !== env.SPIKE_KEY) {
      return new Response('not found\n', { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    const results = await Promise.all(PROBES.map((probe) => run(probe)));
    const colo = (request as Request & { cf?: { colo?: string } }).cf?.colo ?? 'unknown';
    return new Response(JSON.stringify({ colo, at: new Date().toISOString(), results }, null, 2), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  },
};
