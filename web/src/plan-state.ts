// The plan an organization has now, from its subscription rows (the Stripe webhook keeps them current).
import type { Database } from "./db.js";
import { FREE, plan as planNamed, type Interval, type Plan } from "./plans.js";

export type Status = "free" | "trialing" | "active" | "past_due";

export interface PlanState {
  plan: Plan;
  status: Status;
  trialEnd: Date | null;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  interval: Interval | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  hadTrial: boolean;
}

// past_due keeps the paid limits while Stripe retries the payment. Stripe then cancels the subscription, or marks it
// unpaid, and both give Free.
const RANK: Record<string, number> = { active: 3, trialing: 2, past_due: 1 };

export async function planState(db: Database, organizationId: string): Promise<PlanState> {
  const rows = await db.selectFrom("subscription").selectAll().where("referenceId", "=", organizationId).execute();
  const org = await db.selectFrom("organization").select("stripeCustomerId").where("id", "=", organizationId).executeTakeFirst();
  const hadTrial = rows.some(r => r.trialStart || r.trialEnd || r.status === "trialing");
  const live = rows
    .filter(r => RANK[r.status] && (!r.periodEnd || new Date(r.periodEnd).getTime() > Date.now() - 3 * 86400_000))
    .sort((a, b) => RANK[b.status]! - RANK[a.status]! || new Date(b.periodEnd ?? 0).getTime() - new Date(a.periodEnd ?? 0).getTime())[0];
  const plan = live ? planNamed(live.plan) : FREE;
  if (!live || plan === FREE)
    return { plan: FREE, status: "free", trialEnd: null, periodEnd: null, cancelAtPeriodEnd: false, interval: null, stripeCustomerId: org?.stripeCustomerId ?? null, stripeSubscriptionId: null, hadTrial };
  return {
    plan,
    status: live.status as Status,
    trialEnd: live.trialEnd ? new Date(live.trialEnd) : null,
    periodEnd: live.periodEnd ? new Date(live.periodEnd) : null,
    cancelAtPeriodEnd: Boolean(live.cancelAtPeriodEnd || live.cancelAt),
    interval: live.billingInterval === "year" ? "year" : live.billingInterval === "month" ? "month" : null,
    stripeCustomerId: live.stripeCustomerId ?? org?.stripeCustomerId ?? null,
    stripeSubscriptionId: live.stripeSubscriptionId ?? null,
    hadTrial,
  };
}
