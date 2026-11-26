/**
 * Who may do what in a family (#39): `admin`, `member` or `readonly`. The server holds it, so a
 * tampered client changes nothing.
 *
 * A role belongs to a member, and is written on their device rows; empty means nobody has said.
 * Nothing here ever ranks or compares members (PRODUCT.md).
 */

export type Role = 'admin' | 'member' | 'readonly';

export function isRole(value: unknown): value is Role {
  return value === 'admin' || value === 'member' || value === 'readonly';
}

/**
 * Whether a plain `member` is held to a member's calls. While false they may still invite and
 * remove people, as every released client lets them; what somebody was explicitly made — admin or
 * read-only — holds regardless. Turn it on once the builds whose UI knows about roles are out.
 */
export const ROLES_RESTRICT_MEMBERS: boolean = false;

/** A device as roles need it, oldest first. */
export interface RoleRow {
  memberId: string;
  role: string;
}

/**
 * Every member's role. The founder is an admin for as long as they are here. A family is never
 * without one: if nobody is — the founder left and named nobody — the member who has been here
 * longest is, passing over anyone read-only while there is somebody else. Worked out each time,
 * so leaving writes nothing and cannot get it wrong.
 */
export function effectiveRoles(rows: readonly RoleRow[], founder: string): Map<string, Role> {
  const roles = new Map<string, Role>();
  for (const row of rows) {
    const stored = isRole(row.role) ? row.role : undefined;
    if (!roles.has(row.memberId) || stored) roles.set(row.memberId, stored ?? roles.get(row.memberId) ?? 'member');
  }
  if (roles.has(founder)) roles.set(founder, 'admin');
  if (![...roles.values()].includes('admin')) {
    const members = [...roles.keys()];
    const heir = members.find((id) => roles.get(id) !== 'readonly') ?? members[0];
    if (heir !== undefined) roles.set(heir, 'admin');
  }
  return roles;
}
