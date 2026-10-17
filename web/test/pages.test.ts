import assert from "node:assert/strict";
import { test } from "node:test";
import { safeNext } from "../src/pages/routes.js";
import { Browser, linkIn, setup, totp, verifiedUser } from "./helpers.js";

type Env = Awaited<ReturnType<typeof setup>>;
const text = (r: Response) => r.text();
const location = (r: Response) => r.headers.get("location") ?? "";
const hidden = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];

test("sign up and sign in with the forms", async t => {
  const env = await setup();
  t.after(env.close);
  const browser = new Browser(r => env.app.fetch(r));
  let response = await browser.fetch("/signup");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.match(await text(response), /Create your Opaya account/);
  response = await browser.fetch("/signup", { form: { name: "Ana", email: "ana@example.com", password: "short", next: "/billing" } });
  assert.equal(response.status, 400);
  assert.match(await text(response), /10 characters or more/);
  response = await browser.fetch("/signup", { form: { name: "Ana", email: "ana@example.com", password: "correct horse battery", next: "/billing" } });
  assert.match(await text(response), /We sent a link to <strong>ana@example.com<\/strong>/);
  const link = new URL(linkIn(env.mails.at(-1)));
  response = await browser.fetch(link.pathname + link.search);
  assert.equal(location(response), "/billing");
  response = await browser.fetch("/billing");
  assert.equal(response.status, 200);
  assert.match(await text(response), /Free/);

  response = await browser.fetch("/logout", { method: "POST", form: {} });
  assert.equal(location(response), "/login?notice=signed-out");
  response = await browser.fetch("/billing");
  assert.equal(location(response), "/login?next=%2Fbilling");
  response = await browser.fetch("/login", { form: { email: "ana@example.com", password: "wrong password!", next: "/billing" } });
  assert.equal(response.status, 400);
  assert.match(await text(response), /The email or the password is not correct/);
  response = await browser.fetch("/login", { form: { email: "ana@example.com", password: "correct horse battery", next: "/account" } });
  assert.equal(location(response), "/account");
  assert.match(await text(await browser.fetch("/account")), /Signed-in devices/);
});

test("forms refuse other origins and redirects stay on Opaya", async t => {
  const env = await setup();
  t.after(env.close);
  const browser = new Browser(r => env.app.fetch(r));
  const response = await browser.fetch("/login", { form: { email: "a@example.com", password: "x" }, headers: { origin: "https://evil.example" } });
  assert.equal(response.status, 403);
  assert.equal(hidden(await text(await browser.fetch("/login?next=https://evil.example/")), "next"), "/billing");
  assert.equal(safeNext("//evil.example/billing"), "/billing");
  assert.equal(safeNext("/billing/../../x"), "/billing");
  assert.equal(safeNext("/device?user_code=ABCD2345"), "/device?user_code=ABCD2345");
  assert.equal(safeNext("/api/auth/delete-user"), "/billing");
  assert.equal(safeNext("javascript:alert(1)"), "/billing");
});

test("two-factor setup on the account page, then sign-in asks for the code", async t => {
  const env = await setup();
  t.after(env.close);
  const { browser } = await verifiedUser(env);
  let response = await browser.fetch("/account/two-factor/enable", { form: { password: "correct horse battery" } });
  const html = await text(response);
  assert.match(html, /<svg/);
  const secret = /<code>([A-Z2-7=]+)<\/code>/.exec(html)?.[1];
  assert.ok(secret);
  assert.equal((html.match(/<div>[A-Za-z0-9-]{8,}<\/div>/g) ?? []).length, 10, "ten backup codes");
  response = await browser.fetch("/account/two-factor/verify", { form: { code: totp(`otpauth://totp/x?secret=${secret}`) } });
  assert.equal(location(response), "/account?notice=2fa-on#two-factor");

  const other = new Browser(r => env.app.fetch(r), "203.0.113.99");
  response = await other.fetch("/login", { form: { email: "ana@example.com", password: "correct horse battery", next: "/billing" } });
  assert.equal(location(response), "/login/two-factor?next=%2Fbilling");
  response = await other.fetch("/login/two-factor", { form: { code: "123456", next: "/billing" } });
  assert.equal(response.status, 400);
  response = await other.fetch("/login/two-factor", { form: { code: totp(`otpauth://totp/x?secret=${secret}`), next: "/billing" } });
  assert.equal(location(response), "/billing");
  assert.equal((await other.fetch("/billing")).status, 200);
});

test("the /device page connects the desktop app after sign-in", async t => {
  const env = await setup();
  t.after(env.close);
  const desktop = new Browser(r => env.app.fetch(r), "198.51.100.20");
  const code = (await (await desktop.fetch("/api/auth/device/code", { json: { client_id: "opaya-desktop" }, headers: { "x-opaya-device": "Ana's MacBook Pro" } })).json()) as { device_code: string; user_code: string; verification_uri_complete: string };
  const page = new URL(code.verification_uri_complete);
  const browser = new Browser(r => env.app.fetch(r));
  let response = await browser.fetch(page.pathname + page.search);
  assert.equal(location(response), `/login?next=${encodeURIComponent(`/device?user_code=${code.user_code}`)}`);
  const { browser: signedIn } = await verifiedUser(env);
  response = await signedIn.fetch(`/device?user_code=${code.user_code.slice(0, 4)}-${code.user_code.slice(4)}`);
  const html = await text(response);
  assert.match(html, /Connect Ana&#39;s MacBook Pro\?/);
  assert.match(html, new RegExp(`${code.user_code.slice(0, 4)}-${code.user_code.slice(4)}`));
  assert.match(html, /ana@example.com/);
  response = await signedIn.fetch("/device", { form: { user_code: code.user_code, action: "approve" } });
  assert.match(await text(response), /is signed in as ana@example.com/);
  await env.db.updateTable("deviceCode").set({ lastPolledAt: null }).execute();
  response = await desktop.fetch("/api/auth/device/token", { json: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: code.device_code, client_id: "opaya-desktop" } });
  assert.equal(response.status, 200);
  const token = ((await response.json()) as { access_token: string }).access_token;

  // The account page lists the desktop app and can sign it out.
  response = await signedIn.fetch("/account");
  const account = await text(response);
  assert.match(account, /Opaya on Ana&#39;s MacBook Pro/);
  const sessions = await env.db.selectFrom("session").select(["id", "client"]).execute();
  const desktopId = sessions.find(s => s.client === "desktop")!.id;
  response = await signedIn.fetch("/account/sessions/revoke", { form: { id: desktopId } });
  assert.equal(location(response), "/account?notice=device#devices");
  response = await desktop.fetch("/api/auth/get-session", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(await response.json(), null);
  // The same code cannot be used again.
  response = await signedIn.fetch(`/device?user_code=${code.user_code}`);
  assert.equal(response.status, 400);
});

test("pricing starts a checkout; billing shows the plan; the account can be deleted", async t => {
  const env: Env = await setup();
  t.after(env.close);
  const signedOut = new Browser(r => env.app.fetch(r));
  assert.match(await text(await signedOut.fetch("/pricing")), /Start the free trial/);
  const { browser, organizationId } = await verifiedUser(env);
  let html = await text(await browser.fetch("/pricing"));
  assert.match(html, /Start the 14-day trial, then \$19\/month/);
  assert.match(html, /Buy Fleet for \$49\/month/);
  let response = await browser.fetch("/billing/checkout", { form: { plan: "pro", interval: "year" } });
  assert.match(location(response), /^https:\/\/checkout\.stripe\.com\//);
  const params = env.stripe.calls.filter(c => c.method === "checkout.sessions.create").at(-1)!.params;
  assert.equal(params.line_items[0].price, "price_pro_year");
  assert.equal(params.client_reference_id, organizationId);

  // The webhook arrives: the billing page shows the trial.
  const customerId = (await env.db.selectFrom("organization").select("stripeCustomerId").where("id", "=", organizationId).executeTakeFirstOrThrow()).stripeCustomerId as string;
  const sub = env.stripe.subscription({ id: "sub_page", customer: customerId, lookupKey: "opaya_pro_year", status: "trialing", trialDays: 14, metadata: params.subscription_data.metadata });
  const { payload, signature } = env.stripe.event("checkout.session.completed", { object: "checkout.session", mode: "subscription", subscription: sub.id, client_reference_id: organizationId, metadata: params.metadata });
  await signedOut.fetch("/api/auth/stripe/webhook", { method: "POST", body: payload, headers: { "stripe-signature": signature, "content-type": "application/json", origin: "" } });
  html = await text(await browser.fetch("/billing?checkout=done"));
  assert.match(html, /Pro <span class="badge">Trial<\/span>/);
  assert.match(html, /Trial ends/);
  assert.match(html, /Manage billing/);
  assert.match(html, /Thank you/);
  html = await text(await browser.fetch("/pricing"));
  assert.match(html, /Change to Fleet/);
  response = await browser.fetch("/billing/portal", { form: {} });
  assert.equal(location(response), "https://billing.stripe.com/p/session/test");

  response = await browser.fetch("/account/delete", { form: { password: "correct horse battery" } });
  assert.equal(response.status, 400, "the box must be ticked");
  response = await browser.fetch("/account/delete", { form: { password: "correct horse battery", confirm: "yes" } });
  assert.equal(location(response), "/login?notice=deleted");
  assert.ok(env.stripe.calls.some(c => c.method === "customers.del"));
  assert.equal((await env.db.selectFrom("user").selectAll().execute()).length, 0);
});
