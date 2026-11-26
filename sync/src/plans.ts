/**
 * What a household's plan lets it hold (#16, #24). Quotas only ever refuse something new: a
 * larger record, one more device, one more member. Nothing is deleted, nobody is signed out, and
 * editing and deleting always work, whatever the plan becomes (PRODUCT.md).
 */

/**
 * The one switch. While it is false no plan limits anything and every household has only the hard
 * ceilings in index.ts, which is how they all were before plans. Turn it on once there is
 * something to buy and the clients can say what was refused; nothing else has to change.
 */
export const PLAN_LIMITS_ENFORCED: boolean = false;

/** How long past `exp` Pro still counts: a phone, or a payment, may be offline for a week. */
export const PLAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export type Plan = 'free' | 'pro';
export type HouseholdType = 'personal' | 'family';

export interface Quota {
  devices: number;
  members: number;
  /** Ciphertext bytes, counted as `grown` counts them. */
  bytes: number;
}

const MIB = 1024 * 1024;

/** The table in #16. A family's size is the hard cap on both plans. */
export const QUOTAS: Record<HouseholdType, Record<Plan, Quota>> = {
  personal: {
    free: { devices: 2, members: 1, bytes: 32 * MIB },
    pro: { devices: 8, members: 1, bytes: 256 * MIB },
  },
  family: {
    free: { devices: 4, members: 2, bytes: 256 * MIB },
    pro: { devices: 16, members: 8, bytes: 256 * MIB },
  },
};

/** What `meta.plan` holds once an entitlement has been shown (#48). Absent is free. */
export interface StoredPlan {
  plan: 'pro';
  /** When the entitlement runs out, epoch ms. */
  exp: number;
  slot: string;
}

/** Worked out each time it is asked, never written down: a lapse needs no job to notice it. */
export function effectivePlan(stored: StoredPlan | null, now: number): Plan {
  return stored && now <= stored.exp + PLAN_GRACE_MS ? 'pro' : 'free';
}
