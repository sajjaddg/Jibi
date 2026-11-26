/**
 * What billing counts about itself, and all of it: the endpoint, the status it answered, the
 * client's version and, when it refused, the error code. The same four strings as `sync/`
 * (../../sync/src/metrics.ts), in a dataset of its own that this Worker can write and never read.
 *
 * No license, payment reference, slot, address or amount: a row cannot say whose purchase it was
 * (PRODUCT.md). A fifth field is a decision for there.
 */

/** Method and path to the name a route is counted under. */
const ROUTES: Record<string, string> = {
  'GET /v1/health': 'health',
};

/** Every code the API answers with; a test fails when index.ts says one that is not here. */
export const ERROR_CODES = ['internal', 'not_found', 'rate_limited'] as const;

const KNOWN: ReadonlySet<string> = new Set(ERROR_CODES);

export function routeOf(method: string, path: string): string | null {
  return ROUTES[`${method} ${path}`] ?? null;
}

/** Free text from outside, so only a short run of the characters a version is made of is kept. */
const CLIENT = /^[0-9A-Za-z][0-9A-Za-z._+ -]{0,31}$/;

export function dataPoint(endpoint: string, status: number, client: string | null, code = ''): AnalyticsEngineDataPoint {
  const who = client !== null && CLIENT.test(client) ? client : 'unknown';
  const listed = code === '' || KNOWN.has(code) ? code : 'other';
  return { indexes: [endpoint], blobs: [endpoint, String(status), who, listed], doubles: [1] };
}

/** The `code` of a refusal, read from a copy so the answer itself is untouched. */
export async function errorCodeOf(response: Response): Promise<string> {
  if (response.status < 400 || !response.headers.get('content-type')?.startsWith('application/json')) return '';
  try {
    const { code } = await response.clone().json() as { code?: unknown };
    return typeof code === 'string' ? code : '';
  } catch {
    return '';
  }
}

/** Counting is never allowed to be why a request failed. */
export function measure(dataset: AnalyticsEngineDataset | undefined, request: Request, status: number, code = ''): void {
  if (!dataset) return;
  const path = new URL(request.url).pathname;
  // A path a visitor made up is one label, not a row per guess.
  const endpoint = routeOf(request.method, path) ?? 'unknown';
  try {
    dataset.writeDataPoint(dataPoint(endpoint, status, request.headers.get('x-muchtoman-client'), code));
  } catch {
    // Nothing to say that a log line could say without becoming the next thing to leak.
  }
}
