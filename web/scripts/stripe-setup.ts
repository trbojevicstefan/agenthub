// Creates or updates the Stripe objects the web server needs. Run it once in test mode, then once in live mode:
//   STRIPE_SECRET_KEY=sk_test_... npm run stripe:setup --workspace web
//   STRIPE_SECRET_KEY=sk_test_... npm run stripe:setup --workspace web -- --webhook https://app.opaya.dev
// It is safe to run again. It makes:
//   - the products "Opaya Pro" and "Opaya Fleet", with a monthly and a yearly price each, found by the lookup keys in
//     src/plans.ts;
//   - the founding-member coupon (30% off for 12 months, at most 100 customers) and its promotion code FOUNDING;
//   - the Billing Portal settings (change plan, card, cancel at period end, invoices);
//   - with --webhook: the webhook endpoint. Stripe shows its signing secret only once; put it in Secret Manager as
//     STRIPE_WEBHOOK_SECRET.
import Stripe from "stripe";
import { paidPlans, type Interval } from "../src/plans.js";

const FOUNDING = { coupon: "opaya-founding", code: "FOUNDING", percentOff: 30, months: 12, maxRedemptions: 100 };
const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"];

async function product(stripe: Stripe, plan: ReturnType<typeof paidPlans>[number]) {
  const found = await stripe.products.search({ query: `metadata["opaya_plan"]:"${plan.name}"` });
  if (found.data[0]) return found.data[0];
  return stripe.products.create({ name: `Opaya ${plan.title}`, description: plan.summary, metadata: { opaya_plan: plan.name } });
}

async function price(stripe: Stripe, productId: string, lookupKey: string, amount: number, interval: Interval) {
  const [existing] = (await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 })).data;
  if (existing && existing.unit_amount === amount * 100 && existing.currency === "usd" && existing.recurring?.interval === interval && existing.product === productId) return { price: existing, changed: false };
  // A changed amount gets a new price. The lookup key moves to it; current subscribers keep their old price.
  const created = await stripe.prices.create({ product: productId, currency: "usd", unit_amount: amount * 100, recurring: { interval }, lookup_key: lookupKey, transfer_lookup_key: true, tax_behavior: "exclusive", metadata: { opaya_lookup_key: lookupKey } });
  return { price: created, changed: true };
}

async function founding(stripe: Stripe) {
  let coupon: Stripe.Coupon;
  try {
    coupon = await stripe.coupons.retrieve(FOUNDING.coupon);
  } catch {
    coupon = await stripe.coupons.create({ id: FOUNDING.coupon, name: "Founding member", percent_off: FOUNDING.percentOff, duration: "repeating", duration_in_months: FOUNDING.months, max_redemptions: FOUNDING.maxRedemptions });
  }
  const [code] = (await stripe.promotionCodes.list({ code: FOUNDING.code, limit: 1 })).data;
  if (!code) await stripe.promotionCodes.create({ promotion: { type: "coupon", coupon: coupon.id }, code: FOUNDING.code, restrictions: { first_time_transaction: true } });
  return coupon;
}

async function portal(stripe: Stripe, products: { product: string; prices: string[] }[], baseURL: string) {
  const features: Stripe.BillingPortal.ConfigurationCreateParams.Features = {
    customer_update: { enabled: true, allowed_updates: ["email", "address", "tax_id", "name"] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: "at_period_end", cancellation_reason: { enabled: true, options: ["too_expensive", "missing_features", "switched_service", "unused", "other"] } },
    subscription_update: { enabled: true, default_allowed_updates: ["price"], products, proration_behavior: "create_prorations" },
  };
  const business_profile = { headline: "Opaya: manage your plan", privacy_policy_url: "https://opaya.dev/privacy", terms_of_service_url: "https://opaya.dev/terms" };
  const [current] = (await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 })).data;
  if (current) {
    await stripe.billingPortal.configurations.update(current.id, { features, business_profile, default_return_url: `${baseURL}/billing` });
    return true;
  }
  await stripe.billingPortal.configurations.create({ features, business_profile, default_return_url: `${baseURL}/billing` });
  return false;
}

async function webhook(stripe: Stripe, baseURL: string) {
  const url = `${baseURL}/api/auth/stripe/webhook`;
  const existing = (await stripe.webhookEndpoints.list({ limit: 100 })).data.find(w => w.url === url);
  if (existing) {
    await stripe.webhookEndpoints.update(existing.id, { enabled_events: WEBHOOK_EVENTS });
    return { url, secret: "" };
  }
  const created = await stripe.webhookEndpoints.create({ url, enabled_events: WEBHOOK_EVENTS, description: "Opaya web server (better-auth Stripe plugin)" });
  return { url, secret: created.secret ?? "" };
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!/^sk_(test|live)_/.test(key) && !/^rk_(test|live)_/.test(key)) throw new Error("Set STRIPE_SECRET_KEY to a Stripe secret key (sk_test_... or sk_live_...).");
  const at = process.argv.indexOf("--webhook");
  const baseURL = (at > 0 ? process.argv[at + 1] : process.env.OPAYA_BASE_URL || "https://app.opaya.dev")!.replace(/\/+$/, "");
  const stripe = new Stripe(key);
  console.log(`Stripe ${key.includes("_live_") ? "LIVE" : "test"} mode, for ${baseURL}.`);
  const portalProducts: { product: string; prices: string[] }[] = [];
  for (const plan of paidPlans()) {
    const p = await product(stripe, plan);
    const prices: string[] = [];
    for (const interval of ["month", "year"] as const) {
      const r = await price(stripe, p.id, plan.lookupKeys![interval], plan.price![interval], interval);
      prices.push(r.price.id);
      console.log(`  ${plan.title} ${interval}: ${r.price.id} ($${plan.price![interval]})${r.changed ? " (new)" : ""}`);
    }
    portalProducts.push({ product: p.id, prices });
  }
  const coupon = await founding(stripe);
  console.log(`  Founding coupon ${coupon.id}: ${coupon.percent_off}% for ${coupon.duration_in_months} months, ${coupon.times_redeemed}/${coupon.max_redemptions} used. Code: ${FOUNDING.code}`);
  const isDefault = await portal(stripe, portalProducts, baseURL);
  console.log(isDefault ? "  Billing Portal settings updated." : "  Billing Portal settings created. Open Settings > Billing > Customer portal in the Stripe Dashboard and save it once, so it becomes the default.");
  if (at > 0) {
    const hook = await webhook(stripe, baseURL);
    console.log(hook.secret ? `  Webhook ${hook.url} created. Put this signing secret in Secret Manager as STRIPE_WEBHOOK_SECRET:\n  ${hook.secret}` : `  Webhook ${hook.url} already exists. Its events are up to date.`);
  }
}

main().catch(error => {
  console.error(String(error?.message || error));
  process.exit(1);
});
