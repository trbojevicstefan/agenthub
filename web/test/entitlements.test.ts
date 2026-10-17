import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalJWKSet, jwtVerify } from "jose";
import { AUDIENCE, createSigner, newKey } from "../src/entitlements.js";
import { Browser, setup, verifiedUser } from "./helpers.js";

type Env = Awaited<ReturnType<typeof setup>>;

async function desktopToken(env: Env, web: Browser) {
  const desktop = new Browser(r => env.app.fetch(r), "198.51.100.20");
  const code = (await (await desktop.fetch("/api/auth/device/code", { json: { client_id: "opaya-desktop" } })).json()) as { device_code: string; user_code: string };
  await web.fetch(`/api/auth/device?user_code=${code.user_code}`);
  await web.fetch("/api/auth/device/approve", { json: { userCode: code.user_code } });
  const response = await desktop.fetch("/api/auth/device/token", { json: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: code.device_code, client_id: "opaya-desktop" } });
  return { desktop, token: ((await response.json()) as { access_token: string }).access_token };
}

async function entitlements(env: Env, desktop: Browser, token: string) {
  const response = await desktop.fetch("/api/entitlements", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = (await response.json()) as { token: string; plan: string; expiresAt: number };
  const jwks = createLocalJWKSet((await (await desktop.fetch("/.well-known/jwks.json")).json()) as never);
  const { payload, protectedHeader } = await jwtVerify(body.token, jwks, { audience: AUDIENCE, issuer: env.config.baseURL });
  assert.equal(protectedHeader.alg, "EdDSA");
  assert.equal(protectedHeader.typ, "opaya-entitlements+jwt");
  return { body, payload: payload as Record<string, any> };
}

test("the desktop gets signed entitlements that follow the subscription", async t => {
  const env = await setup();
  t.after(env.close);
  const { browser, user, organizationId } = await verifiedUser(env);
  const { desktop, token } = await desktopToken(env, browser);
  assert.equal((await desktop.fetch("/api/entitlements")).status, 401, "no session, no entitlements");

  let { payload } = await entitlements(env, desktop, token);
  assert.equal(payload.sub, user.id);
  assert.equal(payload.org, organizationId);
  assert.equal(payload.plan, "free");
  assert.equal(payload.status, "free");
  assert.deepEqual(payload.limits, { hosts: 1 });
  assert.deepEqual(payload.features, { web: false, sync: false });
  assert.equal(payload.exp! - payload.iat!, 14 * 24 * 60 * 60);

  // Pro trial starts (Checkout, then the webhook).
  await browser.fetch("/api/auth/subscription/upgrade", { json: { plan: "pro", customerType: "organization", referenceId: organizationId, successUrl: "/billing", cancelUrl: "/pricing" } });
  const params = env.stripe.calls.filter(c => c.method === "checkout.sessions.create").at(-1)!.params;
  const customerId = (await env.db.selectFrom("organization").select("stripeCustomerId").where("id", "=", organizationId).executeTakeFirstOrThrow()).stripeCustomerId as string;
  const sub = env.stripe.subscription({ id: "sub_e", customer: customerId, lookupKey: "opaya_pro_month", status: "trialing", trialDays: 14, metadata: params.subscription_data.metadata });
  const send = (type: string, object: unknown) => {
    const { payload: body, signature } = env.stripe.event(type, object);
    return desktop.fetch("/api/auth/stripe/webhook", { method: "POST", body, headers: { "stripe-signature": signature, "content-type": "application/json", origin: "" } });
  };
  await send("checkout.session.completed", { object: "checkout.session", mode: "subscription", subscription: sub.id, client_reference_id: organizationId, metadata: params.metadata });
  ({ payload } = await entitlements(env, desktop, token));
  assert.equal(payload.plan, "pro");
  assert.equal(payload.status, "trialing");
  assert.equal(payload.trialEnd, sub.trial_end);
  assert.deepEqual(payload.limits, { hosts: 5 });
  assert.deepEqual(payload.features, { web: true, sync: true });

  // Cancelled: one webhook later the token says Free again.
  await send("customer.subscription.deleted", { ...sub, status: "canceled", ended_at: Math.floor(Date.now() / 1000) });
  ({ payload } = await entitlements(env, desktop, token));
  assert.equal(payload.plan, "free");
  assert.equal(payload.limits.hosts, 1);

  // The web session can read them too.
  assert.equal((await browser.fetch("/api/entitlements")).status, 200);
});

test("a changed token or a token from another key fails the check", async t => {
  const env = await setup();
  t.after(env.close);
  const now = Math.floor(Date.now() / 1000);
  const { token } = await env.signer.sign({ userId: "u1", organizationId: "o1" }, { plan: "free", status: "free", trialEnd: null, limits: { hosts: 1 }, features: { web: false, sync: false } }, now);
  const jwks = createLocalJWKSet(env.signer.jwks as never);
  await jwtVerify(token, jwks, { audience: AUDIENCE });
  const [header, body, signature] = token.split(".");
  const changed = JSON.parse(Buffer.from(body!, "base64url").toString());
  changed.limits.hosts = 500;
  await assert.rejects(jwtVerify(`${header}.${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`, jwks, { audience: AUDIENCE }));
  const other = await createSigner(JSON.stringify(await newKey("test-key")), env.config.baseURL);
  const forged = await other.sign({ userId: "u1", organizationId: "o1" }, { plan: "fleet", status: "active", trialEnd: null, limits: { hosts: 20 }, features: { web: true, sync: true } });
  await assert.rejects(jwtVerify(forged.token, jwks, { audience: AUDIENCE }), "same kid, other key");
});

test("the signing key must be a private Ed25519 JWK, and older keys stay published", async () => {
  await assert.rejects(createSigner("not json", "http://x"), /not JSON/);
  await assert.rejects(createSigner(JSON.stringify({ kty: "EC" }), "http://x"), /Ed25519/);
  const [a, b] = [await newKey("a"), await newKey("b")];
  const signer = await createSigner(JSON.stringify([a, b]), "http://x");
  assert.deepEqual(signer.jwks.keys.map(k => k.kid), ["a", "b"]);
  assert.ok(signer.jwks.keys.every(k => !("d" in k)), "no private part is published");
});
