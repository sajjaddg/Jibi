/**
 * The record kinds this Worker accepts, in one place.
 *
 * `asRecords` rejects an unknown kind with a 400 for the whole batch, so a phone that pushes a
 * kind the server has not learned stops syncing altogether (DEVELOPMENT.md: «A new record kind
 * means the Worker ships first»). `/v1/hello` publishes this list so a client can see what is
 * accepted and hold back the rest instead — which is why there must be exactly one list: the
 * validator and the advertisement cannot be allowed to disagree.
 *
 * A new kind is one line here, shipped (and deployed) before any client sends it.
 */
export const KINDS = [
  'legacy', 'member', 'transaction', 'category', 'asset', 'note', 'goal', 'exclusion',
] as const;

export type Kind = (typeof KINDS)[number];

export function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}

/**
 * Ids that belong to one kind. A record whose id starts with one of these must carry that kind,
 * or a client could file a transaction under the member namespace and borrow its fences.
 */
export const RESERVED_ID_PREFIXES: ReadonlyArray<readonly [prefix: string, kind: Kind]> = [
  ['member:', 'member'],
  ['txn:', 'transaction'],
  ['category:', 'category'],
  ['asset:', 'asset'],
  ['note:', 'note'],
  ['goal:', 'goal'],
  ['exclusion:', 'exclusion'],
];

/** The kind an id's prefix reserves it to, or null for an id nobody has claimed a namespace on. */
export function reservedKind(id: string): Kind | null {
  for (const [prefix, kind] of RESERVED_ID_PREFIXES) if (id.startsWith(prefix)) return kind;
  return null;
}
