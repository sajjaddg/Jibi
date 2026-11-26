/**
 * What this Worker counts about itself: the endpoint, the status it answered, the client's version
 * and, when it refused, the error code, four short strings, one row per request, in an Analytics
 * Engine dataset it can write and never read back (the rates Worker's `USAGE` does the same).
 *
 * That is all it counts, on purpose. No household id, no device or member id, no token, no
 * address and no scope: a row cannot say whose request it was, so the dataset can answer «is
 * the service healthy, and is some client version failing» and nothing about anyone. The code is
 * one of the fixed list below or «other», never text from a request or an exception — it is there
 * because `household_full` and `quota_exceeded` are both a 409 (PRODUCT.md). Widening the row
 * further is a decision for PRODUCT.md, not a drive-by.
 */

/** Every code the API answers with. test/metrics.test.ts fails when index.ts says one not here. */
export const ERROR_CODES = [
  'already_claimed', 'body_too_large', 'device_exists', 'forbidden_owner', 'forbidden_primary',
  'forbidden_scope', 'household_full', 'identity_exists', 'identity_locked', 'internal',
  'invalid_code', 'invalid_device', 'invalid_hid', 'invalid_id', 'invalid_identity', 'invalid_kind',
  'invalid_limit', 'invalid_member', 'invalid_member_tombstone', 'invalid_nonce', 'invalid_record',
  'invalid_request', 'invalid_scope', 'invalid_secret', 'invalid_since', 'invalid_updated_at',
  'member_exists', 'members_remain', 'rate_limited', 'resync_required', 'too_many_devices',
  'too_many_records', 'unauthorised', 'unavailable', 'unknown_member', 'unsupported_media_type',
] as const;

const KNOWN_CODES: ReadonlySet<string> = new Set(ERROR_CODES);

/**
 * The `code` of a refusal, for counting. Read from a copy, so the answer itself is untouched, and
 * only from the JSON bodies this API writes; anything else is no code.
 */
export async function errorCodeOf(response: Response): Promise<string> {
  if (response.status < 400 || !response.headers.get('content-type')?.startsWith('application/json')) return '';
  try {
    const { code } = await response.clone().json() as { code?: unknown };
    return typeof code === 'string' ? code : '';
  } catch {
    return '';
  }
}

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

export function dataPoint(
  endpoint: string,
  status: number,
  client: string | null,
  code = '',
): AnalyticsEngineDataPoint {
  const listed = code === '' || KNOWN_CODES.has(code) ? code : 'other';
  return { indexes: [endpoint], blobs: [endpoint, String(status), clientOf(client), listed], doubles: [1] };
}

/** Counting is never allowed to be why a request failed. */
export function measure(
  dataset: AnalyticsEngineDataset | undefined,
  request: Request,
  status: number,
  code = '',
): void {
  if (!dataset) return;
  const endpoint = endpointOf(request.method, new URL(request.url).pathname);
  if (endpoint === null) return;
  try {
    dataset.writeDataPoint(dataPoint(endpoint, status, request.headers.get('x-muchtoman-client'), code));
  } catch {
    // Nothing to say that a log line could say without becoming the next thing to leak.
  }
}
