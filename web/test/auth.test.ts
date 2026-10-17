import assert from "node:assert/strict";
import { test } from "node:test";
import { Browser, linkIn, setup, totp } from "./helpers.js";

test("sign up, verify the email, sign in and get one personal organization", async t => {
  const env = await setup();
  t.after(env.close);
  const browser = new Browser(r => env.auth.handler(r));
  let response = await browser.fetch("/api/auth/sign-up/email", { json: { email: "ana@example.com", password: "correct horse battery", name: "Ana" } });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(browser.cookies.size, 0, "no session before the email is verified");
  response = await browser.fetch("/api/auth/sign-in/email", { json: { email: "ana@example.com", password: "correct horse battery" } });
  assert.equal(response.status, 403);
  const link = linkIn(env.mails.at(-1));
  assert.match(link, /\/api\/auth\/verify-email\?token=/);
  response = await browser.fetch(new URL(link).pathname + new URL(link).search);
  assert.ok([200, 302].includes(response.status), String(response.status));
  response = await browser.fetch("/api/auth/get-session");
  const session = (await response.json()) as { user: { id: string; emailVerified: boolean }; session: { activeOrganizationId: string } };
  assert.equal(session.user.emailVerified, true);
  assert.ok(session.session.activeOrganizationId);
  const members = await env.db.selectFrom("member").selectAll().where("userId", "=", session.user.id).execute();
  assert.equal(members.length, 1);
  assert.equal(members[0]!.role, "owner");
  assert.equal(members[0]!.organizationId, session.session.activeOrganizationId);
  response = await browser.fetch("/api/auth/sign-out", { method: "POST", json: {} });
  response = await browser.fetch("/api/auth/sign-in/email", { json: { email: "ana@example.com", password: "correct horse battery" } });
  assert.equal(response.status, 200);
  const again = (await (await browser.fetch("/api/auth/get-session")).json()) as typeof session;
  assert.equal(again.session.activeOrganizationId, session.session.activeOrganizationId);
  assert.equal((await env.db.selectFrom("organization").selectAll().execute()).length, 1);
});

async function signedUp(env: Awaited<ReturnType<typeof setup>>, email = "ana@example.com", password = "correct horse battery") {
  const browser = new Browser(r => env.auth.handler(r));
  await browser.fetch("/api/auth/sign-up/email", { json: { email, password, name: "Ana" } });
  const link = new URL(linkIn(env.mails.at(-1)));
  await browser.fetch(link.pathname + link.search);
  return browser;
}

test("two-factor: after setup, sign-in needs the authenticator code", async t => {
  const env = await setup();
  t.after(env.close);
  const browser = await signedUp(env);
  let response = await browser.fetch("/api/auth/two-factor/enable", { json: { password: "correct horse battery" } });
  const setupData = (await response.json()) as { totpURI: string; backupCodes: string[] };
  assert.match(setupData.totpURI, /^otpauth:\/\/totp\/Opaya:ana%40example\.com\?/);
  assert.equal(setupData.backupCodes.length, 10);
  response = await browser.fetch("/api/auth/two-factor/verify-totp", { json: { code: totp(setupData.totpURI) } });
  assert.equal(response.status, 200, await response.clone().text());

  const other = new Browser(r => env.auth.handler(r), "203.0.113.9");
  response = await other.fetch("/api/auth/sign-in/email", { json: { email: "ana@example.com", password: "correct horse battery" } });
  assert.equal(((await response.json()) as { twoFactorRedirect: boolean }).twoFactorRedirect, true);
  assert.equal(await (await other.fetch("/api/auth/get-session")).json(), null, "no session before the code");
  response = await other.fetch("/api/auth/two-factor/verify-totp", { json: { code: "000000" } });
  assert.equal(response.status, 401);
  response = await other.fetch("/api/auth/two-factor/verify-backup-code", { json: { code: setupData.backupCodes[0] } });
  assert.equal(response.status, 200);
  assert.ok(((await (await other.fetch("/api/auth/get-session")).json()) as { user: unknown }).user);
});

test("password reset by email signs out every session", async t => {
  const env = await setup();
  t.after(env.close);
  const browser = await signedUp(env);
  const stranger = new Browser(r => env.auth.handler(r));
  let response = await stranger.fetch("/api/auth/request-password-reset", { json: { email: "ana@example.com", redirectTo: "/reset-password" } });
  assert.equal(response.status, 200);
  const link = new URL(linkIn(env.mails.at(-1)));
  assert.match(env.mails.at(-1)!.subject, /Reset your Opaya password/);
  response = await stranger.fetch(link.pathname + link.search);
  const target = new URL(response.headers.get("location")!, "http://localhost:3000");
  assert.equal(target.pathname, "/reset-password");
  response = await stranger.fetch("/api/auth/reset-password", { json: { newPassword: "a new long password", token: target.searchParams.get("token") } });
  assert.equal(response.status, 200);
  assert.equal(await (await browser.fetch("/api/auth/get-session")).json(), null, "old sessions end");
  response = await stranger.fetch("/api/auth/sign-in/email", { json: { email: "ana@example.com", password: "a new long password" } });
  assert.equal(response.status, 200);
  // A request for an unknown address looks the same and sends nothing.
  const sent = env.mails.length;
  response = await stranger.fetch("/api/auth/request-password-reset", { json: { email: "nobody@example.com", redirectTo: "/reset-password" } });
  assert.equal(response.status, 200);
  assert.equal(env.mails.length, sent);
});

test("sign-in attempts from one address are rate limited", async t => {
  const env = await setup({ rateLimit: true });
  t.after(env.close);
  const browser = new Browser(r => env.auth.handler(r), "192.0.2.50");
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await browser.fetch("/api/auth/sign-in/email", { json: { email: "x@example.com", password: "wrong password 123" } })).status);
  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(statuses[5], 429);
  const elsewhere = new Browser(r => env.auth.handler(r), "192.0.2.51");
  assert.equal((await elsewhere.fetch("/api/auth/sign-in/email", { json: { email: "x@example.com", password: "wrong password 123" } })).status, 401);
});

test("GitHub and Google sign-in start only when they are set up", async t => {
  const env = await setup({ secrets: { GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret", GOOGLE_CLIENT_ID: "g-id", GOOGLE_CLIENT_SECRET: "g-secret" } });
  t.after(env.close);
  const browser = new Browser(r => env.auth.handler(r));
  for (const [provider, host] of [["github", "github.com"], ["google", "accounts.google.com"]]) {
    const response = await browser.fetch("/api/auth/sign-in/social", { json: { provider, callbackURL: "/billing" } });
    const url = new URL(((await response.json()) as { url: string }).url);
    assert.equal(url.host, host);
    assert.equal(url.searchParams.get("redirect_uri"), `http://localhost:3000/api/auth/callback/${provider}`);
  }
  const plain = await setup();
  t.after(plain.close);
  const response = await new Browser(r => plain.auth.handler(r)).fetch("/api/auth/sign-in/social", { json: { provider: "github", callbackURL: "/billing" } });
  assert.equal(response.status, 404);
});
