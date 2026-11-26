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
/** Accepted in any household. `category` and `goal` are whole in a vault, projections in a family. */
export const SHARED_KINDS = [
  'legacy', 'member', 'transaction', 'category', 'asset', 'note', 'goal', 'exclusion',
  // The household's common pot (#40): the pot, and each thing paid into or out of it.
  'fund', 'fund_entry',
  // Who paid for whom (#41): one transaction divided between members, and money handed back.
  'share_split', 'settlement',
] as const;

/**
 * Accepted in a vault only (`meta.type = personal`): her own whole state, raw bank messages among
 * it. A family refuses them one record at a time, so no bug in a client can put a message where
 * another member could be sent it (PRODUCT.md: the vault and the family never mix). Their ids are
 * `<kind>:<key>`, because the id alone is the table's key and two kinds must not land on one row.
 */
export const VAULT_KINDS = [
  'sms', 'manual_txn', 'anchor', 'rule', 'decision', 'link', 'holding', 'bank', 'loan_person',
  'override', 'day', 'pref', 'entitlement',
] as const;

export const KINDS = [...SHARED_KINDS, ...VAULT_KINDS] as const;

export type Kind = (typeof KINDS)[number];

export function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}

export function isVaultOnly(kind: Kind): boolean {
  return (VAULT_KINDS as readonly string[]).includes(kind);
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
  ['fund:', 'fund'],
  ['fund_entry:', 'fund_entry'],
  ['share_split:', 'share_split'],
  ['settlement:', 'settlement'],
];

/** The kind an id's prefix reserves it to, or null for an id nobody has claimed a namespace on. */
export function reservedKind(id: string): Kind | null {
  for (const [prefix, kind] of RESERVED_ID_PREFIXES) if (id.startsWith(prefix)) return kind;
  return null;
}
