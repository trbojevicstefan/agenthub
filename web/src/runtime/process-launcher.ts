// For development and tests only: starts desktop/runtime.cjs as a local process in place of a container, with the
// same environment, folder and sockets the Docker launcher gives it. No isolation: never use it on a server.
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LauncherClient } from "./manager.js";

const RUNTIME = fileURLToPath(new URL("../../../desktop/runtime.cjs", import.meta.url));

export function processLauncher(usersDir: string, { log = false } = {}) {
  const children = new Map<string, ChildProcess>();
  const calls: string[] = [];
  const alive = (id: string) => Boolean(children.get(id) && children.get(id)!.exitCode === null);
  const launcher: LauncherClient = {
    async call(method, input) {
      const x = (input ?? {}) as { userId: string; vaultToken: string; hostLimit: number };
      calls.push(method);
      if (method === "status") return { running: alive(x.userId) };
      if (method === "list") return [...children.keys()].filter(alive);
      if (method === "start") {
        const dir = join(usersDir, x.userId);
        const child = spawn(process.execPath, [RUNTIME], { env: { ...process.env, OPAYA_DATA: dir, HOME: join(dir, "home"), OPAYA_VAULT_TOKEN: x.vaultToken, OPAYA_HOST_LIMIT: String(x.hostLimit) }, stdio: log ? "inherit" : "ignore" });
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
