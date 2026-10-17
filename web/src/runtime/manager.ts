// One runtime container per active user. The manager gives the WebSocket relay a connection to the user's session
// service: it makes the user's folder and Vault socket, asks the launcher to start the container, waits for the
// service's socket, and stops the container when nobody uses it.
import { EventEmitter } from "node:events";
import { mkdir, readFile, rm } from "node:fs/promises";
import type { Server } from "node:net";
import { join } from "node:path";
import type { SecretStore } from "../secret-store.js";
import { desktopModule } from "./desktop.js";
import { newSocketToken, serveVault } from "./vault-socket.js";

// desktop/wire.cjs Client: call(), answer(), close(), events from the session service.
export interface ServiceClient extends EventEmitter {
  socket: { destroyed: boolean };
  call(method: string, input?: unknown, timeout?: number): Promise<any>;
  answer(id: string, allow: boolean, value?: string): void;
  close(): void;
}
export interface LauncherClient {
  call(method: string, input?: unknown, timeout?: number): Promise<any>;
}
export interface RuntimeUser {
  id: string;
  organizationId: string;
  hostLimit: number;
}

const wire = desktopModule<{ connect: (address: string, token: string, timeout?: number) => Promise<ServiceClient> }>("wire.cjs");
const USER = /^[A-Za-z0-9_-]{8,64}$/;

interface Runtime {
  user: RuntimeUser;
  dir: string;
  vault: Server | null;
  client: ServiceClient | null;
  starting: Promise<ServiceClient> | null;
  holders: Set<object>;
  idle: NodeJS.Timeout | null;
}

export interface ManagerOptions {
  // The users' folders as the web server sees them (/users in the web container).
  usersDir: string;
  launcher: () => Promise<LauncherClient>;
  secrets: (organizationId: string) => SecretStore;
  // No browser attached and no work: the container stops after this time (30 minutes).
  idleMs?: number;
  startTimeoutMs?: number;
}

export class RuntimeManager extends EventEmitter {
  private runtimes = new Map<string, Runtime>();
  constructor(private options: ManagerOptions) {
    super();
  }

  // A connection to the user's session service; `holder` (a browser socket) keeps the container running.
  async attach(user: RuntimeUser, holder: object): Promise<ServiceClient> {
    if (!USER.test(user.id)) throw new Error("Invalid user ID.");
    let r = this.runtimes.get(user.id);
    if (!r) {
      r = { user, dir: join(this.options.usersDir, user.id), vault: null, client: null, starting: null, holders: new Set(), idle: null };
      this.runtimes.set(user.id, r);
    }
    r.user = user;
    r.holders.add(holder);
    if (r.idle) clearTimeout(r.idle), (r.idle = null);
    if (r.client && !r.client.socket.destroyed) return r.client;
    const runtime = r;
    r.starting ??= this.start(runtime).finally(() => (runtime.starting = null));
    try {
      return await r.starting;
    } catch (error) {
      r.holders.delete(holder);
      throw error;
    }
  }

  detach(userId: string, holder: object) {
    const r = this.runtimes.get(userId);
    if (!r) return;
    r.holders.delete(holder);
    if (!r.holders.size) this.armIdle(r);
  }

  private armIdle(r: Runtime) {
    if (r.idle) clearTimeout(r.idle);
    r.idle = setTimeout(() => void this.idleCheck(r).catch(() => this.armIdle(r)), this.options.idleMs ?? 30 * 60 * 1000);
    r.idle.unref?.();
  }

  // Stop only when nobody is attached and nothing works: no agent turn, no running job, no enabled schedule (an idle
  // container would not send them).
  private async idleCheck(r: Runtime) {
    r.idle = null;
    if (r.holders.size) return;
    if (r.client && !r.client.socket.destroyed) {
      const [snapshot, jobs] = await Promise.all([r.client.call("snapshot"), r.client.call("jobs").catch(() => [])]);
      const busy = (snapshot?.agents ?? []).some((a: { busy?: boolean }) => a.busy) || (snapshot?.opayaAgent?.busy ?? false) || (jobs as { status?: string }[]).some(j => j.status === "running");
      const scheduled = (snapshot?.schedules ?? []).some((s: { enabled?: boolean }) => s.enabled !== false);
      if (busy || scheduled) return this.armIdle(r);
    }
    await this.stop(r.user.id);
  }

  private async start(r: Runtime): Promise<ServiceClient> {
    // Unix socket paths have a length limit (104 bytes on macOS, 108 on Linux).
    if (Buffer.byteLength(join(r.dir, "session-service.json")) > 100) throw new Error("The users' folder path is too long for the runtime sockets. Use a shorter OPAYA_USERS_DIR.");
    await mkdir(r.dir, { recursive: true, mode: 0o700 });
    const launcher = await this.options.launcher();
    // A runtime this manager did not start (the web server restarted) has an old Vault token: start it again.
    if (!r.vault && (await launcher.call("status", { userId: r.user.id }))?.running) await launcher.call("stop", { userId: r.user.id }, 60_000);
    if (!r.vault || !(await launcher.call("status", { userId: r.user.id }))?.running) {
      r.vault?.close();
      const vaultToken = newSocketToken();
      r.vault = await serveVault({ path: join(r.dir, "vault.sock"), token: vaultToken, store: this.options.secrets(r.user.organizationId) });
      await rm(join(r.dir, "session-service.json"), { force: true });
      await launcher.call("start", { userId: r.user.id, vaultToken, hostLimit: r.user.hostLimit }, 120_000);
    }
    const client = await this.connect(r);
    r.client = client;
    client.on("closed", () => {
      if (r.client !== client) return;
      r.client = null;
      this.emit("closed", r.user.id);
    });
    return client;
  }

  // The service writes session-service.json (with its socket token) when it is ready.
  private async connect(r: Runtime): Promise<ServiceClient> {
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 60_000);
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        const descriptor = JSON.parse(await readFile(join(r.dir, "session-service.json"), "utf8")) as { token?: string };
        if (descriptor.token) return await wire.connect(join(r.dir, "session.sock"), descriptor.token, 5000);
      } catch (error) {
        last = error;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`The web runtime did not start. ${String((last as Error)?.message ?? "")}`.trim());
  }

  async stop(userId: string) {
    const r = this.runtimes.get(userId);
    if (r?.idle) clearTimeout(r.idle);
    this.runtimes.delete(userId);
    r?.client?.close();
    r?.vault?.close();
    await (await this.options.launcher()).call("stop", { userId }, 60_000);
  }

  // At start and at shutdown: no runtime keeps an old Vault token.
  async stopAll() {
    const launcher = await this.options.launcher();
    const running = new Set<string>([...this.runtimes.keys(), ...((await launcher.call("list").catch(() => [])) as string[])]);
    for (const userId of running) await this.stop(userId).catch(() => {});
  }

  running() {
    return [...this.runtimes.values()].filter(r => r.client && !r.client.socket.destroyed).map(r => r.user.id);
  }
}

// The web server's connection to the launcher (web/src/launcher.ts), made again when it drops.
export function launcherConnection(dir: string) {
  let client: ServiceClient | null = null;
  return async (): Promise<LauncherClient> => {
    if (client && !client.socket.destroyed) return client;
    const token = (await readFile(join(dir, "launcher.token"), "utf8")).trim();
    client = await wire.connect(join(dir, "launcher.sock"), token, 5000);
    client.on("closed", () => (client = null));
    return client;
  };
}
