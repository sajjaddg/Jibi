/**
 * muchtoman-billing — turns a payment into a signed entitlement, and knows nothing about the
 * household it will be used in.
 *
 * Kept apart from `sync/` so that the payment providers' keys and the signing key are never in a
 * Worker that holds a household's data, and a household id never reaches one that holds payments.
 * There are no accounts here: no e-mail, no phone number, no name (PRODUCT.md).
 *
 * Today it answers a health check. Buying and redeeming arrive with #46 and #47, after the reach
 * spike (#18) says which providers a Worker can talk to.
 *
 * Conventions follow ../sync/src/index.ts: uniform response builders with an explicit
 * cache-control and nosniff, and single-line structured console.error.
 */

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

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** Cloudflare's counter, per address and location. Requests that never crossed the edge have no address. */
async function throttled(limiter: RateLimit, request: Request): Promise<boolean> {
  const ip = request.headers.get('cf-connecting-ip');
  return ip != null && !(await limiter.limit({ key: ip })).success;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (await throttled(env.API_LIMIT, request)) {
        const response = jsonResponse({ code: 'rate_limited' }, 429);
        response.headers.set('retry-after', '60');
        return response;
      }
      if (path === '/v1/health' && request.method === 'GET') {
        // The database too: a Worker that answers while its D1 does not is not healthy.
        await env.DB.prepare('SELECT 1 FROM license LIMIT 1').first();
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ code: 'not_found' }, 404);
    } catch (error) {
      // The error's own message, never anything the request carried.
      console.error(JSON.stringify({ message: 'billing failed', error: errorMessage(error) }));
      return jsonResponse({ code: 'internal' }, 500);
    }
  },
};
