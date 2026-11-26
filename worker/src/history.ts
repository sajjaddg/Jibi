/**
 * One rate per asset per day, kept for charts that reach further back than `/usd-history`.
 *
 * A daily cron (wrangler.jsonc) builds the rates the same way a request does, plausibility
 * checks and all, and writes that day's point. An asset that had no rate that day, or whose rate
 * the checks dropped, is simply not in the day: a missing rate is never zero (PRODUCT.md), and a
 * day nothing answered is not written at all. Nothing here is about anybody — these are the
 * public prices `/rates` already serves.
 *
 * In R2, one object per month (`v1/2026-11.json`, `{days: {epochDay: {id: toman}}}`) and one
 * index (`v1/index.json`: the first day recorded, and every id ever recorded). Days are UTC epoch
 * days, which is how both clients key their own `rateHistory`.
 */

/** The two calls made on the bucket, so a test can stand in for it with a map. */
export interface HistoryBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string): Promise<unknown>;
}

export interface HistoryIndex {
  /** The earliest epoch day any point was written for. */
  first: number;
  /** Every asset id a point was ever written for: what the catalogue has been. */
  assets: string[];
}

type Day = Record<string, number>;
interface Month { days: Record<string, Day> }

/** Three years and a bit: past the longest chart asked for, and under forty months to read. */
export const HISTORY_MAX_DAYS = 1098;

const INDEX_KEY = 'v1/index.json';
const DAY_MS = 86_400_000;

/** Epoch day 2 (3 January 1970) was a Saturday, which is where a week starts in Iran. */
const FIRST_SATURDAY = 2;

export const monthKey = (day: number): string => `v1/${new Date(day * DAY_MS).toISOString().slice(0, 7)}.json`;

/** An object that is there but unreadable throws: writing over it would lose what it held. */
async function readObject<T>(bucket: HistoryBucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  return object == null ? null : JSON.parse(await object.text()) as T;
}

export const readIndex = (bucket: HistoryBucket) => readObject<HistoryIndex>(bucket, INDEX_KEY);

/**
 * Writes `day`'s point from a freshly built set of rates. Only catalogue ids are kept: the fixed
 * ones, the coins in this build's list, and whatever was recorded before — so a day the coin
 * catalogue is down still gets the coins it is known to hold. Run twice on one day, the first
 * figure stands and the second run only fills what was missing.
 *
 * Returns how many assets it added.
 */
export async function recordRates(
  bucket: HistoryBucket,
  day: number,
  toman: Record<string, number>,
  catalogue: Iterable<string>,
): Promise<number> {
  const index = await readIndex(bucket);
  const wanted = new Set([...catalogue, ...(index?.assets ?? [])]);
  wanted.delete('toman');
  const priced = [...wanted].filter((id) => Number.isFinite(toman[id]) && toman[id] > 0);
  if (priced.length === 0) return 0;

  const key = monthKey(day);
  const month = await readObject<Month>(bucket, key) ?? { days: {} };
  const point: Day = month.days[day] ?? {};
  let added = 0;
  for (const id of priced) {
    if (point[id] != null) continue;
    point[id] = toman[id];
    added++;
  }
  month.days[day] = point;
  await bucket.put(key, JSON.stringify(month));
  // The index last: a day it names always has a month object behind it.
  await bucket.put(INDEX_KEY, JSON.stringify({
    first: Math.min(index?.first ?? day, day),
    assets: [...new Set([...(index?.assets ?? []), ...Object.keys(point)])].sort(),
  } satisfies HistoryIndex));
  return added;
}

/** Every recorded day of one asset within the window ending `today`, keyed by epoch day. */
export async function readSeries(
  bucket: HistoryBucket,
  index: HistoryIndex | null,
  asset: string,
  today: number,
): Promise<Record<string, number>> {
  if (index == null) return {};
  const from = Math.max(index.first, today - HISTORY_MAX_DAYS + 1);
  const keys = new Set<string>();
  for (let day = from; day <= today; day++) keys.add(monthKey(day));
  const months = await Promise.all([...keys].map((key) => readObject<Month>(bucket, key)));
  const series: Record<string, number> = {};
  for (const month of months) {
    for (const [day, point] of Object.entries(month?.days ?? {})) {
      if (Number(day) >= from && Number(day) <= today && point[asset] != null) series[day] = point[asset];
    }
  }
  return series;
}

/**
 * The days between `from` and `to`. A week is the last day of it that has a rate, under that
 * day's own number — a real figure of a real day, never an average of the ones that happen to be
 * there.
 */
export function slice(
  series: Record<string, number>,
  from: number,
  to: number,
  step: 'day' | 'week',
): Record<string, number> {
  const days = Object.keys(series).map(Number).filter((day) => day >= from && day <= to).sort((a, b) => a - b);
  const kept = step === 'day' ? days : [
    ...new Map(days.map((day) => [Math.floor((day - FIRST_SATURDAY) / 7), day])).values(),
  ];
  return Object.fromEntries(kept.map((day) => [String(day), series[day]]));
}

export interface HistoryQuery {
  asset: string;
  from: number;
  to: number;
  step: 'day' | 'week';
}

/** The query as asked, with its defaults, or null for one that makes no sense. */
export function parseQuery(params: URLSearchParams, today: number): HistoryQuery | null {
  const asset = params.get('asset') ?? '';
  const step = params.get('step') ?? 'day';
  const day = (name: string, fallback: number): number | null => {
    const raw = params.get(name);
    if (raw == null) return fallback;
    return /^\d{1,6}$/.test(raw) ? Number(raw) : null;
  };
  const to = day('to', today);
  const from = day('from', today - HISTORY_MAX_DAYS + 1);
  if (!/^[a-z0-9_.-]{1,64}$/.test(asset) || (step !== 'day' && step !== 'week')) return null;
  if (from == null || to == null || from > to) return null;
  return { asset, from, to, step };
}
