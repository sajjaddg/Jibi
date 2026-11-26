/**
 * What this Worker counts about itself: the endpoint, the status it answered and the client's
 * version, three short strings, one row per request, in an Analytics Engine dataset it can write
 * and never read back (the rates Worker's `USAGE` does the same).
 *
 * That is all it counts, on purpose. No household id, no device or member id, no token, no
 * address and no scope: a row cannot say whose request it was, so the dataset can answer «is
 * the service healthy, and is some client version failing» and nothing about anyone. Widening the
 * row — a stable error code would tell `household_full` from `quota_exceeded`, which both read
 * as 409 — is a decision for PRODUCT.md, not a drive-by.
 */

/** Method and path to the name a route is known by, which is also the object's own route. */
const V1_ROUTES: Record<string, string> = {
  'GET /v1/sync': 'pull',
  'POST /v1/sync': 'push',
  'POST /v1/claim': 'claim',
  'POST /v1/invite': 'invite',
  'POST /v1/pair': 'pair',
  'POST /v1/identity': 'identity',
  'POST /v1/remove': 'remove',
  'POST /v1/leave': 'leave',
  'POST /v1/destroy': 'destroy',
  'POST /v1/revoke': 'revoke',
  'POST /v1/rotate': 'rotate',
  'GET /v1/devices': 'devices',
  'GET /v1/hello': 'hello',
};

export function routeOf(method: string, path: string): string | null {
  return V1_ROUTES[`${method} ${path}`] ?? null;
}

/** The label a request is counted under; null for what is not the API (the page, the rates proxy). */
export function endpointOf(method: string, path: string): string | null {
  if (!path.startsWith('/v1/')) return null;
  return routeOf(method, path) ?? 'unknown';
}

/**
 * The client's own name for its build, sent as `X-MuchToman-Client: <version> <platform>` — the
 * shape of the daily count's header. Free text from outside, so only a short run of the
 * characters a version is made of is kept: anything else could carry an identifier, and is
 * counted as «unknown».
 */
const CLIENT = /^[0-9A-Za-z][0-9A-Za-z._+ -]{0,31}$/;

export function clientOf(header: string | null): string {
  return header !== null && CLIENT.test(header) ? header : 'unknown';
}

export function dataPoint(endpoint: string, status: number, client: string | null): AnalyticsEngineDataPoint {
  return { indexes: [endpoint], blobs: [endpoint, String(status), clientOf(client)], doubles: [1] };
}

/** Counting is never allowed to be why a request failed. */
export function measure(
  dataset: AnalyticsEngineDataset | undefined,
  request: Request,
  status: number,
): void {
  if (!dataset) return;
  const endpoint = endpointOf(request.method, new URL(request.url).pathname);
  if (endpoint === null) return;
  try {
    dataset.writeDataPoint(dataPoint(endpoint, status, request.headers.get('x-muchtoman-client')));
  } catch {
    // Nothing to say that a log line could say without becoming the next thing to leak.
  }
}
