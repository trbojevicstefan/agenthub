// The launcher: the only process with access to the Docker socket. It runs in its own container with no network and
// accepts four requests from the web server, over a Unix socket that only the web server can reach: start, stop and
// status of one user's runtime container, and the list of running runtimes. The container options are fixed here; a
// request can choose only the user, its Vault socket token and its machine limit.
import { randomBytes } from "node:crypto";
import { chmod, chown, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { Server } from "node:net";
import { join } from "node:path";
import { desktopModule } from "./runtime/desktop.js";

export interface LauncherOptions {
  image: string;
  network: string;
  // The users' folders on the host (Docker binds use host paths), for example /var/lib/opaya/users.
  usersHostDir: string;
  uid: number;
  gid: number;
  memoryMb: number;
  cpus: number;
  pids: number;
}

export interface StartRequest {
  userId: string;
  vaultToken: string;
  hostLimit: number;
}

const USER = /^[A-Za-z0-9_-]{8,64}$/;
const TOKEN = /^[a-f0-9]{64}$/;
// Docker names are case-sensitive, like better-auth's user IDs.
export const containerName = (userId: string) => `opaya-runtime-${userId}`;

export function checkStart(input: unknown): StartRequest {
  const x = (input ?? {}) as Record<string, unknown>;
  if (typeof x.userId !== "string" || !USER.test(x.userId)) throw new Error("Invalid user ID.");
  if (typeof x.vaultToken !== "string" || !TOKEN.test(x.vaultToken)) throw new Error("Invalid Vault token.");
  if (!Number.isInteger(x.hostLimit) || (x.hostLimit as number) < 0 || (x.hostLimit as number) > 10_000) throw new Error("Invalid machine limit.");
  return { userId: x.userId, vaultToken: x.vaultToken, hostLimit: x.hostLimit as number };
}
const checkUser = (input: unknown) => {
  const userId = (input as { userId?: unknown } | undefined)?.userId;
  if (typeof userId !== "string" || !USER.test(userId)) throw new Error("Invalid user ID.");
  return userId;
};

// The runtime container: read-only root file system, no capabilities, no new privileges, limits for memory, CPU and
// processes, /tmp in memory, the user's folder as /data, and the runtime network (internet only).
export function containerSpec(options: LauncherOptions, { userId, vaultToken, hostLimit }: StartRequest) {
  const memory = options.memoryMb * 1024 * 1024;
  return {
    Image: options.image,
    User: `${options.uid}:${options.gid}`,
    Env: [`OPAYA_VAULT_TOKEN=${vaultToken}`, `OPAYA_HOST_LIMIT=${hostLimit}`],
    Labels: { "dev.opaya.role": "runtime", "dev.opaya.user": userId },
    StopTimeout: 15,
    HostConfig: {
      Binds: [`${options.usersHostDir}/${userId}:/data:rw`],
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: Math.round(options.cpus * 1e9),
      PidsLimit: options.pids,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
      NetworkMode: options.network,
      AutoRemove: true,
      RestartPolicy: { Name: "no" },
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "2" } },
    },
  };
}

export type DockerCall = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

// The Docker Engine API over its Unix socket.
export function dockerApi(socketPath = "/var/run/docker.sock"): DockerCall {
  return (method, path, body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = http.request({ socketPath, method, path: `/v1.43${path}`, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} }, response => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", chunk => (text += chunk));
        response.on("end", () => {
          let parsed: unknown = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {}
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      });
      request.on("error", reject);
      request.setTimeout(60_000, () => request.destroy(new Error("Docker did not answer.")));
      request.end(payload);
    });
}

// The runtime network: a bridge with internet access, no traffic between containers, and a fixed subnet, so the VPS
// firewall can block private addresses from it (deploy/README.md).
export const RUNTIME_SUBNET = "172.31.250.0/24";
export function networkSpec(name: string) {
  return { Name: name, Driver: "bridge", Internal: false, Options: { "com.docker.network.bridge.enable_icc": "false", "com.docker.network.bridge.name": "opaya-rt0" }, IPAM: { Config: [{ Subnet: RUNTIME_SUBNET }] }, Labels: { "dev.opaya.role": "runtime-network" } };
}

export function createLauncher(options: LauncherOptions, docker: DockerCall) {
  let network: Promise<void> | null = null;
  const ensureNetwork = () =>
    (network ??= (async () => {
      const r = await docker("GET", `/networks/${encodeURIComponent(options.network)}`);
      if (r.status === 200) return;
      const created = await docker("POST", "/networks/create", networkSpec(options.network));
      if (created.status !== 201 && created.status !== 409) throw fail("create the runtime network", created);
    })().catch(error => {
      network = null;
      throw error;
    }));
  const fail = (what: string, r: { status: number; body: any }) => new Error(`Docker could not ${what} (HTTP ${r.status}): ${String(r.body?.message ?? "").slice(0, 300)}`);
  async function status(userId: string) {
    const r = await docker("GET", `/containers/${containerName(userId)}/json`);
    if (r.status === 404) return { running: false };
    if (r.status !== 200) throw fail("read the runtime", r);
    return { running: Boolean(r.body?.State?.Running), startedAt: String(r.body?.State?.StartedAt ?? "") };
  }
  return {
    status: (input: unknown) => status(checkUser(input)),
    async start(input: unknown) {
      const request = checkStart(input);
      const name = containerName(request.userId);
      const current = await status(request.userId);
      if (current.running) return { started: false, running: true };
      await ensureNetwork();
      // A stopped container left behind (AutoRemove failed): remove it first.
      await docker("DELETE", `/containers/${name}?force=true`);
      let r = await docker("POST", `/containers/create?name=${encodeURIComponent(name)}`, containerSpec(options, request));
      if (r.status !== 201) throw fail("create the runtime", r);
      r = await docker("POST", `/containers/${name}/start`);
      if (r.status !== 204 && r.status !== 304) throw fail("start the runtime", r);
      return { started: true, running: true };
    },
    async stop(input: unknown) {
      const name = containerName(checkUser(input));
      const r = await docker("POST", `/containers/${name}/stop?t=15`);
      if (![204, 304, 404].includes(r.status)) throw fail("stop the runtime", r);
      return { stopped: r.status === 204 };
    },
    async list() {
      const filters = encodeURIComponent(JSON.stringify({ label: ["dev.opaya.role=runtime"] }));
      const r = await docker("GET", `/containers/json?filters=${filters}`);
      if (r.status !== 200) throw fail("list the runtimes", r);
      return (r.body as { Labels?: Record<string, string> }[]).map(c => c.Labels?.["dev.opaya.user"]).filter((u): u is string => Boolean(u && USER.test(u)));
    },
  };
}
export type Launcher = ReturnType<typeof createLauncher>;

const wire = desktopModule<{ server: (options: object) => Server }>("wire.cjs");

// The launcher's socket for the web server. The token is in a file next to the socket; both belong to the web
// server's user (uid), and only the web server's container mounts the folder.
export async function serveLauncher({ dir, launcher, uid, gid }: { dir: string; launcher: Launcher; uid?: number; gid?: number }) {
  const token = randomBytes(32).toString("hex");
  const socket = join(dir, "launcher.sock"), tokenFile = join(dir, "launcher.token");
  await rm(socket, { force: true });
  await writeFile(tokenFile, token, { mode: 0o600 });
  const actions: Record<string, (input: unknown) => Promise<unknown>> = { start: launcher.start, stop: launcher.stop, status: launcher.status, list: () => launcher.list() };
  const listener = wire.server({
    token,
    snapshot: () => null,
    dispatch: async (method: string, input: unknown) => {
      if (!Object.hasOwn(actions, method)) throw new Error("Unsupported launcher request.");
      return actions[method]!(input);
    },
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(socket, () => resolve());
  });
  await chmod(socket, 0o600);
  if (uid !== undefined && gid !== undefined) {
    await chown(socket, uid, gid);
    await chown(tokenFile, uid, gid);
  }
  return listener;
}
