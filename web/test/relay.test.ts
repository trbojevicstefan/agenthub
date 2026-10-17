// The web app end to end: the browser's WebSocket, the relay, the runtime manager and a runtime (as a local process).
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import WebSocket from "ws";
import { RuntimeManager } from "../src/runtime/manager.js";
import { processLauncher } from "../src/runtime/process-launcher.js";
import { attachRelay } from "../src/runtime/relay.js";
import { kmsSecretStore, localKeyWrapper } from "../src/secret-store.js";
import { BASE, setup, startTrial, verifiedUser } from "./helpers.js";

type Message = { kind: string; id?: number; value?: any; error?: string; event?: string };

function open(port: number, cookie: string, origin = BASE) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/app/ws`, { headers: { cookie, origin } });
  const messages: Message[] = [];
  const waiters: { test: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
  ws.on("message", data => {
    const m = JSON.parse(data.toString()) as Message;
    messages.push(m);
    for (const w of [...waiters]) if (w.test(m)) waiters.splice(waiters.indexOf(w), 1), w.resolve(m);
  });
  const next = (test: (m: Message) => boolean, ms = 20_000) =>
    new Promise<Message>((resolve, reject) => {
      const found = messages.find(test);
      if (found) return resolve(found);
      waiters.push({ test, resolve });
      setTimeout(() => reject(new Error("No such message in time.")), ms).unref();
    });
  let id = 0;
  const call = async (method: string, input: unknown = {}) => {
    const n = ++id;
    ws.send(JSON.stringify({ kind: "call", id: n, method, input }));
    const r = await next(m => m.kind === "result" && m.id === n, 60_000);
    if (r.error) throw new Error(r.error);
    return r.value;
  };
  const closed = new Promise<number>(resolve => ws.on("close", code => resolve(code)));
  const failed = new Promise<number>(resolve => ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)));
  return { ws, call, next, closed, failed };
}

test("a Pro user's browser reaches its runtime through the relay; others do not", { skip: process.platform === "win32" && "web runtimes run on Linux" }, async t => {
  // Socket paths have a 104-character limit on macOS: user IDs are 32 characters, so the folder must be short.
  const usersDir = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "or-")));
  t.after(() => rm(usersDir, { recursive: true, force: true }));
  const env = await setup({ runtime: { usersDir, launcherDir: "", kmsKey: "" } });
  t.after(env.close);
  const kms = localKeyWrapper();
  const { launcher } = processLauncher(usersDir);
  const manager = new RuntimeManager({ usersDir, launcher: async () => launcher, secrets: org => kmsSecretStore({ db: env.db, kms, organizationId: org }), startTimeoutMs: 20_000 });
  t.after(() => manager.stopAll());
  const server = serve({ fetch: env.app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
  await new Promise(r => server.once("listening", r));
  t.after(() => new Promise(r => server.close(r)));
  attachRelay(server, { config: env.config, auth: env.auth, db: env.db, manager, usersDir });
  const port = (server.address() as AddressInfo).port;

  const { browser, organizationId } = await verifiedUser(env);
  const cookie = [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  // Free: no web app.
  let tab = open(port, cookie);
  assert.equal(await tab.closed, 4402);
  assert.equal((await browser.fetch("/app/")).headers.get("location"), "/pricing?web=1");
  // No session, or another site's page: refused.
  assert.equal(await open(port, "").closed, 4401);
  assert.equal(await open(port, cookie, "https://evil.example").failed, 403);

  await startTrial(env, browser, organizationId);
  const page = await browser.fetch("/app/");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<script defer src="web-transport.js"><\/script><script defer src="app.js"><\/script>/);
  assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
  assert.equal((await browser.fetch("/app/vendor/xterm.js")).status, 200);
  assert.equal((await browser.fetch("/app/../package.json")).status, 404);

  tab = open(port, cookie);
  const hello = await tab.next(m => m.kind === "hello");
  assert.equal(hello.value.runtime, "web");
  const host = await tab.call("saveHost", { name: "vps", hostname: "203.0.113.5", username: "root", port: 22 });
  assert.equal(host.name, "vps");
  await tab.next(m => m.kind === "event" && m.event === "state" && m.value.hosts.length === 1);
  await assert.rejects(tab.call("discover", {}), /In the web app/);
  await assert.rejects(tab.call("cordConnect", {}), /desktop app only/);
  await assert.rejects(tab.call("shutdown", {}), /desktop app only/, "the browser cannot stop the service");
  assert.deepEqual(await tab.call("openDocs", { topic: "codex" }), { url: "https://developers.openai.com/codex/app-server/" });

  // An approval goes to the tab and comes back.
  const agent = await tab.call("saveAgent", { agent: { name: "api", provider: "custom", protocol: "openai", transport: "http", endpoint: "https://api.example.com/v1" }, token: "tok-1" });
  const removing = tab.call("removeAgent", { id: agent.id });
  const approval = await tab.next(m => m.kind === "event" && m.event === "approval");
  assert.match(approval.value.title, /Remove this agent connection/);
  assert.equal(await tab.call("approvalAnswer", { id: approval.value.id, choice: "once" }), true);
  assert.equal(await removing, true);
  tab.ws.close();
});
