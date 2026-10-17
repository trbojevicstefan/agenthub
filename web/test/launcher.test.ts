import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { containerSpec, createLauncher, dockerApi, serveLauncher, type LauncherOptions } from "../src/launcher.js";
import { desktopModule } from "../src/runtime/desktop.js";

const wire = desktopModule("wire.cjs");
const OPTIONS: LauncherOptions = { image: "opaya-runtime:latest", network: "opaya-runtime", usersHostDir: "/var/lib/opaya/users", uid: 10001, gid: 10001, memoryMb: 1024, cpus: 1, pids: 256 };
const USER = "Ab12cd34Ef56gh78";
const TOKEN = "d".repeat(64);

test("the runtime container has fixed, locked-down options", () => {
  const spec = containerSpec(OPTIONS, { userId: USER, vaultToken: TOKEN, hostLimit: 5 });
  assert.equal(spec.User, "10001:10001");
  assert.deepEqual(spec.Env, [`OPAYA_VAULT_TOKEN=${TOKEN}`, "OPAYA_HOST_LIMIT=5"]);
  assert.deepEqual(spec.HostConfig.Binds, [`/var/lib/opaya/users/${USER}:/data:rw`], "only the user's own folder");
  assert.equal(spec.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(spec.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(spec.HostConfig.SecurityOpt, ["no-new-privileges:true"]);
  assert.equal(spec.HostConfig.Privileged, false);
  assert.equal(spec.HostConfig.Memory, 1024 * 1024 * 1024);
  assert.equal(spec.HostConfig.PidsLimit, 256);
  assert.equal(spec.HostConfig.NetworkMode, "opaya-runtime");
  assert.ok(!JSON.stringify(spec).includes("docker.sock"), "no Docker socket in a runtime");
});

test("the launcher starts, finds and stops a runtime through the Docker API, and refuses anything else", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ol-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A Docker Engine for the test.
  const containers = new Map<string, { running: boolean; spec: any }>();
  const networks = new Map<string, any>();
  const calls: string[] = [];
  const docker = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://docker");
      calls.push(`${req.method} ${url.pathname}`);
      const send = (status: number, value?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(value === undefined ? "" : JSON.stringify(value));
      };
      if (url.pathname === "/v1.43/networks/opaya-runtime") return networks.has("opaya-runtime") ? send(200, {}) : send(404, { message: "network not found" });
      if (req.method === "POST" && url.pathname === "/v1.43/networks/create") return networks.set(JSON.parse(body).Name, JSON.parse(body)), send(201, { Id: "n1" });
      const m = /^\/v1\.43\/containers\/([^/]+)(?:\/(json|start|stop))?$/.exec(url.pathname);
      if (req.method === "POST" && url.pathname === "/v1.43/containers/create") {
        containers.set(url.searchParams.get("name")!, { running: false, spec: JSON.parse(body) });
        return send(201, { Id: "c1" });
      }
      if (req.method === "GET" && url.pathname === "/v1.43/containers/json") return send(200, [...containers].filter(([, c]) => c.running).map(([, c]) => ({ Labels: c.spec.Labels })));
      if (!m) return send(404, { message: "no route" });
      const c = containers.get(m[1]!);
      if (req.method === "DELETE") return containers.delete(m[1]!) ? send(204) : send(404, { message: "No such container" });
      if (!c) return send(404, { message: "No such container" });
      if (m[2] === "json") return send(200, { State: { Running: c.running, StartedAt: "2026-10-17T00:00:00Z" } });
      if (m[2] === "start") return (c.running = true), send(204);
      if (m[2] === "stop") return c.running ? ((c.running = false), send(204)) : send(304);
      send(404);
    });
  });
  const dockerSocket = join(dir, "docker.sock");
  await new Promise<void>(r => docker.listen(dockerSocket, r));
  t.after(() => docker.close());

  const launcher = createLauncher(OPTIONS, dockerApi(dockerSocket));
  const listener = await serveLauncher({ dir, launcher });
  t.after(() => listener.close());
  const client = await wire.connect(join(dir, "launcher.sock"), (await readFile(join(dir, "launcher.token"), "utf8")).trim());
  t.after(() => client.close());

  assert.deepEqual(await client.call("status", { userId: USER }), { running: false });
  assert.deepEqual(await client.call("start", { userId: USER, vaultToken: TOKEN, hostLimit: 5 }), { started: true, running: true });
  const created = containers.get(`opaya-runtime-${USER}`)!;
  assert.equal(networks.get("opaya-runtime").Options["com.docker.network.bridge.enable_icc"], "false", "runtimes cannot reach each other");
  assert.equal(created.spec.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(await client.call("start", { userId: USER, vaultToken: TOKEN, hostLimit: 5 }), { started: false, running: true }, "a running runtime is not started twice");
  assert.deepEqual(await client.call("list"), [USER]);
  assert.deepEqual(await client.call("stop", { userId: USER }), { stopped: true });
  assert.equal((await client.call("status", { userId: USER })).running, false);

  await assert.rejects(client.call("start", { userId: "../../etc", vaultToken: TOKEN, hostLimit: 5 }), /Invalid user ID/);
  await assert.rejects(client.call("start", { userId: USER, vaultToken: "x", hostLimit: 5 }), /Invalid Vault token/);
  await assert.rejects(client.call("start", { userId: USER, vaultToken: TOKEN, hostLimit: -1 }), /Invalid machine limit/);
  await assert.rejects(client.call("exec", { userId: USER, cmd: "sh" }), /Unsupported launcher request/);
  await assert.rejects(wire.connect(join(dir, "launcher.sock"), "e".repeat(64)), /rejected/);
  assert.ok(calls.every(c => !c.includes("/exec") && !c.includes("/images")), "the launcher never runs commands or pulls images");
});
