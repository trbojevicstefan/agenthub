import assert from "node:assert/strict";
import { test } from "node:test";
import { Browser, setup, verifiedUser } from "./helpers.js";

type Env = Awaited<ReturnType<typeof setup>>;
const lastCheckout = (env: Env) => env.stripe.calls.filter(c => c.method === "checkout.sessions.create").at(-1)!.params;

async function webhook(env: Env, type: string, object: unknown) {
  const { payload, signature } = env.stripe.event(type, object);
  return new Browser(r => env.app.fetch(r)).fetch("/api/auth/stripe/webhook", { method: "POST", body: payload, headers: { "stripe-signature": signature, "content-type": "application/json", origin: "" } });
}

async function checkout(env: Env, browser: Browser, organizationId: string, plan: string, annual = false) {
  const response = await browser.fetch("/api/auth/subscription/upgrade", { json: { plan, annual, customerType: "organization", referenceId: organizationId, successUrl: "/billing?checkout=done", cancelUrl: "/pricing" } });
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { url: string }).url;
}

const subscriptionRow = (env: Env, organizationId: string) => env.db.selectFrom("subscription").selectAll().where("referenceId", "=", organizationId).orderBy("periodStart", "desc").execute();

test("the Pro trial needs no card, ends without one, and comes only once", async t => {
  const env = await setup();
  t.after(env.close);
  const { browser, organizationId } = await verifiedUser(env);
  assert.match(await checkout(env, browser, organizationId, "pro"), /^https:\/\/checkout\.stripe\.com\//);
  const customer = env.stripe.calls.find(c => c.method === "customers.create")!.params;
  assert.equal(customer.email, "ana@example.com", "receipts go to the owner");
  assert.equal(customer.metadata.organizationId, organizationId);
  let params = lastCheckout(env);
  assert.equal(params.client_reference_id, organizationId);
  assert.equal(params.line_items[0].price, "price_pro_month");
  assert.equal(params.allow_promotion_codes, true);
  assert.equal(params.subscription_data.trial_period_days, 14);
  assert.equal(params.payment_method_collection, "if_required");
  assert.deepEqual(params.subscription_data.trial_settings, { end_behavior: { missing_payment_method: "cancel" } });
  assert.equal(params.automatic_tax, undefined, "Stripe Tax stays off until it is set up");

  // Stripe made the subscription in its trial and sends the webhook.
  const customerId = (await env.db.selectFrom("organization").select("stripeCustomerId").where("id", "=", organizationId).executeTakeFirstOrThrow()).stripeCustomerId as string;
  const sub = env.stripe.subscription({ id: "sub_trial", customer: customerId, lookupKey: "opaya_pro_month", status: "trialing", trialDays: 14, metadata: params.subscription_data.metadata });
  let response = await webhook(env, "checkout.session.completed", { object: "checkout.session", mode: "subscription", subscription: sub.id, client_reference_id: organizationId, metadata: params.metadata });
  assert.equal(response.status, 200);
  let [row] = await subscriptionRow(env, organizationId);
  assert.equal(row!.status, "trialing");
  assert.equal(row!.plan, "pro");
  assert.ok(row!.trialEnd);

  // Day 14 with no card: Stripe cancels the subscription.
  response = await webhook(env, "customer.subscription.deleted", { ...sub, status: "canceled", canceled_at: Math.floor(Date.now() / 1000), ended_at: Math.floor(Date.now() / 1000) });
  assert.equal(response.status, 200);
  [row] = await subscriptionRow(env, organizationId);
  assert.equal(row!.status, "canceled");

  // A second checkout for the same organization has no trial, so Checkout asks for a card.
  await checkout(env, browser, organizationId, "pro");
  params = lastCheckout(env);
  assert.equal(params.subscription_data.trial_period_days, undefined);
  assert.equal(params.payment_method_collection, undefined);
  assert.equal(params.subscription_data.trial_settings, undefined);
});

test("Fleet yearly uses the yearly price and has no trial", async t => {
  const env = await setup();
  t.after(env.close);
  const { browser, organizationId } = await verifiedUser(env);
  await checkout(env, browser, organizationId, "fleet", true);
  const params = lastCheckout(env);
  assert.equal(params.line_items[0].price, "price_fleet_year");
  assert.equal(params.subscription_data.trial_period_days, undefined);
  assert.equal(params.allow_promotion_codes, true);
});

test("only the owner changes an organization's subscription, and webhooks need Stripe's signature", async t => {
  const env = await setup();
  t.after(env.close);
  const ana = await verifiedUser(env);
  const bob = await verifiedUser(env, { email: "bob@example.com", ip: "203.0.113.8" });
  const response = await bob.browser.fetch("/api/auth/subscription/upgrade", { json: { plan: "pro", customerType: "organization", referenceId: ana.organizationId, successUrl: "/billing", cancelUrl: "/pricing" } });
  assert.equal(response.status, 401);
  const forged = await new Browser(r => env.app.fetch(r)).fetch("/api/auth/stripe/webhook", { method: "POST", body: JSON.stringify({ type: "customer.subscription.deleted", data: { object: {} } }), headers: { "stripe-signature": "t=1,v1=bad", "content-type": "application/json", origin: "" } });
  assert.equal(forged.status, 400);
});

test("deleting the account ends its Stripe customer and removes its organization", async t => {
  const env = await setup();
  t.after(env.close);
  const { browser, organizationId } = await verifiedUser(env);
  await checkout(env, browser, organizationId, "pro");
  const response = await browser.fetch("/api/auth/delete-user", { json: { password: "correct horse battery" } });
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok(env.stripe.calls.some(c => c.method === "customers.del"));
  assert.equal((await env.db.selectFrom("organization").selectAll().execute()).length, 0);
  assert.equal((await env.db.selectFrom("subscription").selectAll().execute()).length, 0);
  assert.equal((await env.db.selectFrom("user").selectAll().execute()).length, 0);
});
