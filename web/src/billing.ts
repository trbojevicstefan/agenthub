// Stripe plans through @better-auth/stripe. Subscriptions belong to the user's personal organization (referenceId).
import { stripe as stripePlugin } from "@better-auth/stripe";
import Stripe from "stripe";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { stripePlans } from "./plans.js";

export const LIVE_STATUSES = ["active", "trialing", "past_due"] as const;

export function stripeClient(config: Config) {
  // Without a key (development) Stripe calls fail with an authentication error. Nothing else breaks.
  return new Stripe(config.secrets.STRIPE_SECRET_KEY || "sk_test_not_configured", { maxNetworkRetries: 2, timeout: 20_000 });
}

export async function isOwner(db: Database, userId: string, organizationId: string) {
  const row = await db.selectFrom("member").select("id").where("userId", "=", userId).where("organizationId", "=", organizationId).where("role", "=", "owner").executeTakeFirst();
  return Boolean(row);
}

// The Stripe plugin gives a trial only to an organization that had none. The no-card settings follow the same rule.
export async function hadTrial(db: Database, organizationId: string) {
  const rows = await db.selectFrom("subscription").select(["trialStart", "trialEnd", "status"]).where("referenceId", "=", organizationId).execute();
  return rows.some(r => r.trialStart || r.trialEnd || r.status === "trialing");
}

// Extra Checkout options. A trial needs no card: Checkout asks for a card only when money is due now, and a trial
// that ends with no card ends the subscription (the entitlements go back to Free).
export function checkoutParams({ trial, automaticTax }: { trial: boolean; automaticTax: boolean }): Stripe.Checkout.SessionCreateParams {
  return {
    allow_promotion_codes: true,
    billing_address_collection: "auto",
    ...(automaticTax ? { automatic_tax: { enabled: true }, tax_id_collection: { enabled: true } } : {}),
    ...(trial
      ? {
          payment_method_collection: "if_required",
          subscription_data: { trial_settings: { end_behavior: { missing_payment_method: "cancel" } } },
        }
      : {}),
  };
}

export function billingPlugin({ config, db, client }: { config: Config; db: Database; client: Stripe }) {
  return stripePlugin({
    stripeClient: client,
    stripeWebhookSecret: config.secrets.STRIPE_WEBHOOK_SECRET || "whsec_not_configured",
    createCustomerOnSignUp: false,
    organization: {
      enabled: true,
      // Receipts go to the owner's email.
      getCustomerCreateParams: async (_organization, ctx) => {
        const email = (ctx.context as { session?: { user?: { email?: string } } }).session?.user?.email;
        return email ? { email } : {};
      },
    },
    subscription: {
      enabled: true,
      plans: stripePlans(),
      requireEmailVerification: true,
      // Only the owner of an organization sees or changes its subscription.
      authorizeReference: async ({ user, referenceId }) => isOwner(db, user.id, referenceId),
      getCheckoutSessionParams: async ({ plan, subscription }) => ({
        params: checkoutParams({ trial: Boolean(plan.freeTrial) && !(await hadTrial(db, subscription.referenceId)), automaticTax: config.automaticTax }),
      }),
    },
  });
}

// Before an account is deleted: end its organization's Stripe customer (this ends its subscriptions at once) and remove
// the organization with its subscriptions, members, web app secrets and synced records, and the user's browser
// subscriptions and approval rules.
export async function deleteOrganizationsOf({ db, client, userId }: { db: Database; client: Stripe; userId: string }) {
  const owned = await db.selectFrom("member").select("organizationId").where("userId", "=", userId).where("role", "=", "owner").execute();
  for (const { organizationId } of owned) {
    const org = await db.selectFrom("organization").select(["id", "stripeCustomerId"]).where("id", "=", organizationId).executeTakeFirst();
    if (org?.stripeCustomerId) {
      try {
        await client.customers.del(org.stripeCustomerId);
      } catch (error) {
        if ((error as { code?: string }).code !== "resource_missing") throw error;
      }
    }
    await db.deleteFrom("opaya_secret").where("organization_id", "=", organizationId).execute();
    await db.deleteFrom("opaya_sync_record").where("organization_id", "=", organizationId).execute();
    await db.deleteFrom("opaya_sync_state").where("organization_id", "=", organizationId).execute();
    await db.deleteFrom("subscription").where("referenceId", "=", organizationId).execute();
    await db.deleteFrom("invitation").where("organizationId", "=", organizationId).execute();
    await db.deleteFrom("member").where("organizationId", "=", organizationId).execute();
    await db.deleteFrom("organization").where("id", "=", organizationId).execute();
  }
  await db.deleteFrom("member").where("userId", "=", userId).execute();
  await db.deleteFrom("opaya_push_subscription").where("user_id", "=", userId).execute();
  await db.deleteFrom("opaya_approval_rule").where("user_id", "=", userId).execute();
}
