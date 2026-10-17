import assert from "node:assert/strict";
import { test } from "node:test";
import { Browser, linkIn, setup } from "./helpers.js";

async function signedIn(env: Awaited<ReturnType<typeof setup>>, app: Awaited<ReturnType<typeof setup>>["app"], email = "ana@example.com") {
  const browser = new Browser(r => app.fetch(r));
  await browser.fetch("/api/auth/sign-up/email", { json: { email, password: "correct horse battery", name: "Ana" } });
  const link = new URL(linkIn(env.mails.at(-1)));
  await browser.fetch(link.pathname + link.search);
  return browser;
}

test("the desktop signs in with the device flow and gets a desktop session", async t => {
  const env = await setup();
  t.after(env.close);
  const app = env.app;
  const desktop = new Browser(r => app.fetch(r), "198.51.100.20");
  let response = await desktop.fetch("/api/auth/device/code", { json: { client_id: "somebody-else" } });
  assert.equal(response.status, 400, "only known clients");
  response = await desktop.fetch("/api/auth/device/code", { json: { client_id: "opaya-desktop" }, headers: { "x-opaya-device": "Ana's MacBook <script>" } });
  assert.equal(response.status, 200);
  const code = (await response.json()) as { device_code: string; user_code: string; verification_uri_complete: string; interval: number };
  assert.equal(code.verification_uri_complete, `http://localhost:3000/device?user_code=${code.user_code}`);
  const poll = () => desktop.fetch("/api/auth/device/token", { json: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: code.device_code, client_id: "opaya-desktop" } });
  assert.equal(((await (await poll()).json()) as { error: string }).error, "authorization_pending");

  const web = await signedIn(env, app);
  response = await web.fetch(`/api/auth/device?user_code=${code.user_code}`);
  assert.equal(((await response.json()) as { status: string }).status, "pending");
  response = await web.fetch("/api/auth/device/approve", { json: { userCode: code.user_code } });
  assert.equal(response.status, 200);
  await env.db.updateTable("deviceCode").set({ lastPolledAt: null }).execute();
  response = await poll();
  assert.equal(response.status, 200);
  const token = ((await response.json()) as { access_token: string }).access_token;
  assert.ok(token);

  const bearer = { authorization: `Bearer ${token}` };
  response = await desktop.fetch("/api/auth/get-session", { headers: bearer });
  const session = (await response.json()) as { session: { client: string; deviceName: string; activeOrganizationId: string }; user: { email: string } };
  assert.equal(session.user.email, "ana@example.com");
  assert.equal(session.session.client, "desktop");
  assert.equal(session.session.deviceName, "Ana's MacBook script");
  assert.ok(session.session.activeOrganizationId);

  // Off the allowlist: no account changes, no checkout, no sign-up, no approving other devices.
  for (const [path, json] of [["/api/auth/subscription/upgrade", { plan: "pro" }], ["/api/auth/sign-up/email", { email: "x@example.com", password: "correct horse battery", name: "X" }], ["/api/auth/update-user", { name: "Y" }], ["/api/auth/device/approve", { userCode: "ABCD" }]] as const) {
    response = await desktop.fetch(path, { json, headers: bearer });
    assert.equal(response.status, 403, path);
  }
  response = await desktop.fetch("/api/auth/list-sessions", { headers: bearer });
  assert.equal(response.status, 403);
  // The web session is not limited.
  response = await web.fetch("/api/auth/list-sessions");
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as unknown[]).length, 2);

  response = await desktop.fetch("/api/auth/sign-out", { json: {}, headers: bearer });
  assert.equal(response.status, 200);
  response = await desktop.fetch("/api/auth/get-session", { headers: bearer });
  assert.equal(await response.json(), null);
});

test("a denied or expired device code gives no token", async t => {
  const env = await setup();
  t.after(env.close);
  const app = env.app;
  const desktop = new Browser(r => app.fetch(r));
  const code = (await (await desktop.fetch("/api/auth/device/code", { json: { client_id: "opaya-desktop" } })).json()) as { device_code: string; user_code: string };
  const web = await signedIn(env, app);
  await web.fetch(`/api/auth/device?user_code=${code.user_code}`);
  assert.equal((await web.fetch("/api/auth/device/deny", { json: { userCode: code.user_code } })).status, 200);
  const poll = await desktop.fetch("/api/auth/device/token", { json: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: code.device_code, client_id: "opaya-desktop" } });
  assert.equal(((await poll.json()) as { error: string }).error, "access_denied");
});
