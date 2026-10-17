// The runtime manager with a launcher that starts desktop/runtime.cjs as a local process, in place of a container: the
// same environment, folder and sockets as the Docker launcher gives it.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RuntimeManager, type LauncherClient } from "../src/runtime/manager.js";
import { kmsSecretStore, localKeyWrapper } from "../src/secret-store.js";
import { setup } from "./helpers.js";

const RUNTIME = fileURLToPath(new URL("../../desktop/runtime.cjs", import.meta.url));

function processLauncher(usersDir: string) {
  const children = new Map<string, ChildProcess>();
  const calls: string[] = [];
  const launcher: LauncherClient = {
    async call(method, input) {
      const x = (input ?? {}) as { userId: string; vaultToken: string; hostLimit: number };
      calls.push(method);
      const alive = (id: string) => Boolean(children.get(id) && children.get(id)!.exitCode === null);
      if (method === "status") return { running: alive(x.userId) };
      if (method === "list") return [...children.keys()].filter(alive);
      if (method === "start") {
        const dir = join(usersDir, x.userId);
        const child = spawn(process.execPath, [RUNTIME], { env: { ...process.env, OPAYA_DATA: dir, HOME: join(dir, "home"), OPAYA_VAULT_TOKEN: x.vaultToken, OPAYA_HOST_LIMIT: String(x.hostLimit) }, stdio: "ignore" });
        children.set(x.userId, child);
        return { started: true, running: true };
      }
      if (method === "stop") {
        const child = children.get(x.userId);
        if (child && child.exitCode === null) {
          child.kill("SIGTERM");
          await new Promise(r => child.once("exit", r));
        }
        return { stopped: true };
      }
      throw new Error("Unsupported launcher request.");
    },
  };
  return { launcher, children, calls };
}

test("the manager starts a user's runtime, keeps it while used, stops it when idle and starts it again with the data", { skip: process.platform === "win32" && "web runtimes run on Linux" }, async t => {
  const env = await setup();
  t.after(env.close);
  const usersDir = await realpath(await mkdtemp(join(tmpdir(), "om-")));
  t.after(() => rm(usersDir, { recursive: true, force: true }));
  const kms = localKeyWrapper();
  const { launcher, children, calls } = processLauncher(usersDir);
  const manager = new RuntimeManager({ usersDir, launcher: async () => launcher, secrets: org => kmsSecretStore({ db: env.db, kms, organizationId: org }), idleMs: 200, startTimeoutMs: 20_000 });
  t.after(() => manager.stopAll());
  const user = { id: "user0001AbCd", organizationId: "org_1", hostLimit: 5 };
  const browser = {};

  const client = await manager.attach(user, browser);
  assert.equal((await client.call("snapshot")).runtime, "web");
  const agent = await client.call("saveAgent", { agent: { name: "api", provider: "custom", protocol: "openai", transport: "http", endpoint: "https://api.example.com/v1" }, token: "tok-xyz" });
  assert.equal(await kmsSecretStore({ db: env.db, kms, organizationId: "org_1" }).get(agent.id), "tok-xyz", "the token is in the KMS store");
  assert.equal(await manager.attach(user, {}), client, "a second tab shares the runtime");

  // Idle with a holder left: still running.
  manager.detach(user.id, browser);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(children.get(user.id)!.exitCode, null);
  // Nobody attached: stopped after the idle time.
  for (const holder of [...(manager as any).runtimes.get(user.id).holders]) manager.detach(user.id, holder);
  for (let i = 0; i < 40 && children.get(user.id)!.exitCode === null; i++) await new Promise(r => setTimeout(r, 100));
  assert.notEqual(children.get(user.id)!.exitCode, null, "the runtime stopped");
  assert.deepEqual(manager.running(), []);

  // Started again: the agent and its token are there.
  const again = await manager.attach(user, {});
  const snapshot = await again.call("snapshot");
  assert.deepEqual(snapshot.agents.map((a: { name: string }) => a.name), ["api"]);
  assert.equal(snapshot.agents[0].hasToken, true);
  assert.ok(calls.filter(c => c === "start").length === 2);
});

test("a schedule keeps an idle runtime running", { skip: process.platform === "win32" && "web runtimes run on Linux" }, async t => {
  const env = await setup();
  t.after(env.close);
  const usersDir = await realpath(await mkdtemp(join(tmpdir(), "om-")));
  t.after(() => rm(usersDir, { recursive: true, force: true }));
  const { launcher, children } = processLauncher(usersDir);
  const manager = new RuntimeManager({ usersDir, launcher: async () => launcher, secrets: org => kmsSecretStore({ db: env.db, kms: localKeyWrapper(), organizationId: org }), idleMs: 150, startTimeoutMs: 20_000 });
  t.after(() => manager.stopAll());
  const user = { id: "user0002AbCd", organizationId: "org_2", hostLimit: 5 }, browser = {};
  const client = await manager.attach(user, browser);
  await client.call("scheduleSave", { agentId: "opaya", name: "Daily", cron: "0 9 * * *", prompt: "Check the servers." });
  manager.detach(user.id, browser);
  await new Promise(r => setTimeout(r, 600));
  assert.equal(children.get(user.id)!.exitCode, null, "still running for its schedule");
});
