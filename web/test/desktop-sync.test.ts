// Sync end to end (SYNC_PLAN.md): the desktop app's engine over HTTPS with its desktop session, the web server, and a
// web runtime that syncs over its socket.
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RuntimeManager } from "../src/runtime/manager.js";
import { processLauncher } from "../src/runtime/process-launcher.js";
import { pull, push } from "../src/sync.js";
import { Browser, setup, startTrial, verifiedUser } from "./helpers.js";

const require = createRequire(import.meta.url);
const { Account, TOKEN_KEY } = require("../../desktop/account.cjs");
const { Sync } = require("../../desktop/sync.cjs");
const { Store, Vault } = require("../../desktop/store.cjs");
const { Broker } = require("../../desktop/broker.cjs");
const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "test", encryptString: (s: string) => Buffer.from("enc:" + s), decryptString: (b: Buffer) => b.toString().slice(4) };

async function until<T>(check: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("Timed out.");
    await new Promise(r => setTimeout(r, 200));
  }
}

test("the desktop app and a web runtime sync machines, agents and a marked Vault key through the server", { skip: process.platform === "win32" && "web runtimes run on Linux" }, async t => {
  const usersDir = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "os-")));
  t.after(() => rm(usersDir, { recursive: true, force: true }));
  const env = await setup({ runtime: { usersDir, launcherDir: "", kmsKey: "", egressIp: "" } });
  t.after(env.close);
  const { browser, organizationId } = await verifiedUser(env);
  await startTrial(env, browser, organizationId);

  // The desktop app, signed in with the device flow.
  const desktop = new Browser(r => env.app.fetch(r), "198.51.100.20");
  const code = (await (await desktop.fetch("/api/auth/device/code", { json: { client_id: "opaya-desktop" } })).json()) as { device_code: string; user_code: string };
  await browser.fetch(`/api/auth/device?user_code=${code.user_code}`);
  await browser.fetch("/api/auth/device/approve", { json: { userCode: code.user_code } });
  const token = ((await (await desktop.fetch("/api/auth/device/token", { json: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: code.device_code, client_id: "opaya-desktop" } })).json()) as { access_token: string }).access_token;
  const root = await mkdtemp(join(tmpdir(), "osd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = new Vault(root, safeStorage);
  const broker = new Broker({ store: new Store(root), vault, emit: () => {}, approve: async () => true });
  await broker.init();
  await vault.set(TOKEN_KEY, token, true);
  const account = new Account({ root, vault, baseUrl: env.config.baseURL, keys: env.signer.jwks.keys, fetchImpl: (url: string, init: RequestInit) => env.app.fetch(new Request(url, init)) });
  await account.load();

  const host = await broker.saveHost({ name: "prod", hostname: "203.0.113.5", username: "root", port: 22 });
  const agent = await broker.saveAgent({ agent: { name: "hermes", provider: "hermes", protocol: "acp", transport: "ssh", hostId: host.id, command: "hermes", args: ["acp"] } });
  const key = "opaya-secret-0f8fad5b-d9cb-469f-a165-70867728950e";
  await vault.set(key, JSON.stringify("sk-synced-value"), true);
  const opaya = { secrets: [{ id: "S1", key, name: "OPENAI_API_KEY", mask: "sk-…lue", kept: true, sync: true }] };
  const kinds = ["host", "agent", "conversation", "transcript", "settings"];
  const sync = new Sync({ root, broker, opaya, vault, transport: account.syncTransport(), sends: [...kinds, "secret"], accepts: kinds, account: "ana@example.com" });
  await sync.load();
  await sync.round();
  assert.deepEqual((await pull(env.db, organizationId, 0)).records.map(r => r.kind).sort(), ["agent", "host", "secret", "settings"]);
  assert.equal(await env.store(organizationId).get(key), JSON.stringify("sk-synced-value"), "the value is in the KMS store");

  // The web runtime starts and pulls them.
  const { launcher } = processLauncher(usersDir);
  const manager = new RuntimeManager({ usersDir, launcher: async () => launcher, secrets: env.store, sync: org => ({ pull: since => pull(env.db, org, since), push: records => push(env.db, org, records) }), startTimeoutMs: 20_000 });
  t.after(() => manager.stopAll());
  const runtime = await manager.attach({ id: (await env.db.selectFrom("user").select("id").executeTakeFirstOrThrow()).id as string, organizationId, hostLimit: 5 }, {});
  let last: any;
  const snapshot = await until(async () => {
    const s = (last = await runtime.call("snapshot"));
    return s.agents.length && s.opayaAgent?.secrets?.length ? s : undefined;
  }).catch(async error => {
    const { readdir, readFile } = await import("node:fs/promises");
    const dir = join(usersDir, (await readdir(usersDir))[0]!);
    console.log("Runtime sync state:", JSON.stringify(last?.sync), "hosts", last?.hosts?.length, "agents", last?.agents?.length, "secrets", last?.opayaAgent?.secrets?.length);
    console.log("Runtime log:", await readFile(join(dir, "service-startup.log"), "utf8"));
    throw error;
  });
  assert.deepEqual(snapshot.hosts.map((h: { name: string }) => h.name), ["prod"]);
  assert.deepEqual(snapshot.agents.map((a: { id: string }) => a.id), [agent.id]);
  assert.equal(snapshot.opayaAgent.secrets[0].name, "OPENAI_API_KEY");
  assert.equal(snapshot.opayaAgent.secrets[0].synced, true);

  // A machine added in the web app reaches the desktop app.
  await runtime.call("saveHost", { name: "web-added", hostname: "203.0.113.9", username: "ubuntu", port: 22 });
  await runtime.call("syncNow");
  await sync.round();
  assert.deepEqual(broker.data.hosts.map((h: { name: string }) => h.name).sort(), ["prod", "web-added"]);

  // Free: the server refuses sync, and the desktop engine reports it.
  await env.db.deleteFrom("subscription").execute();
  await assert.rejects(sync.round(), /Sync comes with Pro and Fleet/);
  assert.match(sync.describe().error, /Pro and Fleet/);
});
