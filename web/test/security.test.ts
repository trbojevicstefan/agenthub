// Checks from the security review: other sites, large bodies, links in a user's folder, the web SSH key and Web Push.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import WebSocket from "ws";
import { pushService } from "../src/push.js";
import { RuntimeManager } from "../src/runtime/manager.js";
import { processLauncher } from "../src/runtime/process-launcher.js";
import { attachRelay } from "../src/runtime/relay.js";
import { newSocketToken, serveVault } from "../src/runtime/vault-socket.js";
import { desktopModule } from "../src/runtime/desktop.js";
import { kmsSecretStore, localKeyWrapper } from "../src/secret-store.js";
import { newSshKey, PRIVATE_KEY_NAME, publicKeyOf, webSshKey } from "../src/ssh-key.js";
import { BASE, setup, startTrial, verifiedUser } from "./helpers.js";

const { RemoteVault } = desktopModule("remote-vault.cjs");

test("the server's own JSON routes refuse other sites, bodies that are not JSON and large bodies", async t => {
  const env = await setup();
  t.after(env.close);
  const { browser, organizationId } = await verifiedUser(env);
  await startTrial(env, browser, organizationId);
  assert.equal((await browser.fetch("/api/sync", { json: { records: [] } })).status, 200);
  assert.equal((await browser.fetch("/api/sync", { json: { records: [] }, headers: { origin: "https://evil.opaya.dev" } })).status, 403, "a sibling domain");
  assert.equal((await browser.fetch("/api/sync", { method: "POST", body: JSON.stringify({ records: [] }), headers: { "content-type": "text/plain" } })).status, 415, "a form-like body needs no preflight");
  assert.equal((await browser.fetch("/api/sync", { method: "POST", body: "x".repeat(17 * 1024 * 1024), headers: { "content-type": "application/json" } })).status, 413);
  assert.equal((await browser.fetch("/login", { form: { email: "a@example.com", password: "x".repeat(200 * 1024) } })).status, 413);
});

test("the manager does not follow a link in a user's folder to another user's files", async t => {
  const usersDir = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "os-")));
  t.after(() => rm(usersDir, { recursive: true, force: true }));
  const dir = join(usersDir, "user0003AbCd"), other = join(usersDir, "user0004AbCd");
  await mkdir(dir), await mkdir(other);
  await writeFile(join(other, "session-service.json"), JSON.stringify({ token: "the other user's token" }));
  await symlink(join(other, "session-service.json"), join(dir, "session-service.json"));
  const manager = new RuntimeManager({ usersDir, launcher: async () => ({ call: async () => null }), secrets: () => kmsSecretStore({} as never), startTimeoutMs: 600 });
  await assert.rejects((manager as any).connect({ dir }), /ELOOP|symbolic link/i);
});

test("the web SSH public key comes from the private key, is made once, and the runtime cannot change it", async t => {
  const env = await setup();
  t.after(env.close);
  const store = kmsSecretStore({ db: env.db, kms: localKeyWrapper(), organizationId: "org_k" });
  const [a, b] = await Promise.all([webSshKey(store, "org_k"), webSshKey(store, "org_k")]);
  assert.equal(a, b, "two first calls keep one key");
  const key = newSshKey("x");
  assert.equal(publicKeyOf(key.privateKey, "x"), key.publicKey);
  assert.throws(() => publicKeyOf("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----", "x"), /not valid/);

  const dir = await mkdtemp(join(tmpdir(), "opaya-vault-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const token = newSocketToken(), path = join(dir, "vault.sock");
  const listener = await serveVault({ path, token, store });
  t.after(() => listener.close());
  const vault = new RemoteVault({ address: path, token });
  await vault.load();
  assert.ok(vault.get(PRIVATE_KEY_NAME), "the runtime reads the key");
  await assert.rejects(vault.set(PRIVATE_KEY_NAME, Buffer.from(newSshKey("y").privateKey).toString("base64")), /belongs to the web app/);
  await assert.rejects(vault.remove(PRIVATE_KEY_NAME), /belongs to the web app/);
  vault.close();
  assert.equal(await webSshKey(store, "org_k"), a);
});

test("Web Push goes only to the browsers' push services", async t => {
  const env = await setup();
  t.after(env.close);
  const push = pushService({ db: env.db, publicKey: "pub", privateKey: "priv", send: async () => {} });
  const keys = { p256dh: "BEl62iUYgUivxIkv69yViEuiBIa40HI80NM9OBhDBJ5yk", auth: "tBHItJI5svbpez7KI4CCXg" };
  for (const endpoint of ["https://10.0.0.5/x", "https://metadata.google.internal/x", "https://fcm.googleapis.com.evil.example/x", "https://fcm.googleapis.com:8443/x"])
    await assert.rejects(push.subscribe("u1", { endpoint, keys }), /Invalid push subscription/, endpoint);
  for (const endpoint of ["https://fcm.googleapis.com/fcm/send/a", "https://updates.push.services.mozilla.com/wpush/v2/a", "https://wns2-par02p.notify.windows.com/w/?token=a", "https://web.push.apple.com/a"])
    assert.equal(await push.subscribe("u1", { endpoint, keys }), true, endpoint);
});

test("an open web app tab closes when its session ends", { skip: process.platform === "win32" && "web runtimes run on Linux" }, async t => {
  const usersDir = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "os-")));
  t.after(() => rm(usersDir, { recursive: true, force: true }));
  const env = await setup({ runtime: { usersDir, launcherDir: "", kmsKey: "", egressIp: "" } });
  t.after(env.close);
  const { launcher } = processLauncher(usersDir);
  const manager = new RuntimeManager({ usersDir, launcher: async () => launcher, secrets: env.store, startTimeoutMs: 20_000 });
  t.after(() => manager.stopAll());
  const server = serve({ fetch: env.app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
  await new Promise(r => server.once("listening", r));
  t.after(() => new Promise(r => server.close(r)));
  attachRelay(server, { config: env.config, auth: env.auth, db: env.db, manager, usersDir, recheckMs: 200 });
  const { browser, organizationId } = await verifiedUser(env);
  await startTrial(env, browser, organizationId);
  const cookie = [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/app/ws`, { headers: { cookie, origin: BASE } });
  const closed = new Promise<number>(resolve => ws.on("close", code => resolve(code)));
  await new Promise<void>(resolve => ws.on("message", data => JSON.parse(data.toString()).kind === "hello" && resolve()));
  // Signed out in another tab: the session row goes, and the socket closes.
  assert.equal((await browser.fetch("/api/auth/sign-out", { json: {} })).status, 200);
  assert.equal(await closed, 4401);
});
