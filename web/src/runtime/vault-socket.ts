// The Vault of one user's runtime container: a Unix socket in that user's folder (only that container mounts it),
// answered from the KMS secret store. desktop/remote-vault.cjs is the client.
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import type { Server } from "node:net";
import type { SecretStore } from "../secret-store.js";
import { RESERVED_NAMES } from "../ssh-key.js";
import { desktopModule } from "./desktop.js";

const wire = desktopModule<{ server: (options: object) => Server }>("wire.cjs");

export const newSocketToken = () => randomBytes(32).toString("hex");

// sync: the runtime's sync calls (SYNC_PLAN.md), answered for its organization.
export interface SyncHandlers {
  pull(since: number): Promise<unknown>;
  push(records: unknown): Promise<unknown>;
}

// The runtime may change its user's keys, not the ones the web server keeps for it (the web SSH key).
const writable = (key: unknown) => {
  const name = String(key ?? "");
  if (RESERVED_NAMES.has(name)) throw new Error("This Vault key belongs to the web app.");
  return name;
};

export async function serveVault({ path, token, store, sync }: { path: string; token: string; store: SecretStore; sync?: SyncHandlers }) {
  await rm(path, { force: true });
  const listener = wire.server({
    token,
    snapshot: () => null,
    dispatch: async (method: string, input: { key?: unknown; value?: unknown } | undefined) => {
      if (method === "vaultLoad") {
        const names = await store.list();
        return Object.fromEntries(await Promise.all(names.map(async name => [name, await store.get(name)])));
      }
      if (method === "vaultSet") return void (await store.set(writable(input?.key), String(input?.value ?? "")));
      if (method === "vaultRemove") return void (await store.remove(writable(input?.key)));
      if (method === "vaultGet") return store.get(String(input?.key ?? ""));
      if (sync && method === "syncPull") return sync.pull(Number((input as { since?: unknown } | undefined)?.since ?? 0));
      if (sync && method === "syncPush") return sync.push((input as { records?: unknown } | undefined)?.records);
      throw new Error("Unsupported vault action.");
    },
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(path, () => resolve());
  });
  return listener;
}
