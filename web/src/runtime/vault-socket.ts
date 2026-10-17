// The Vault of one user's runtime container: a Unix socket in that user's folder (only that container mounts it),
// answered from the KMS secret store. desktop/remote-vault.cjs is the client.
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import type { Server } from "node:net";
import type { SecretStore } from "../secret-store.js";
import { desktopModule } from "./desktop.js";

const wire = desktopModule<{ server: (options: object) => Server }>("wire.cjs");

export const newSocketToken = () => randomBytes(32).toString("hex");

export async function serveVault({ path, token, store }: { path: string; token: string; store: SecretStore }) {
  await rm(path, { force: true });
  const listener = wire.server({
    token,
    snapshot: () => null,
    dispatch: async (method: string, input: { key?: unknown; value?: unknown } | undefined) => {
      if (method === "vaultLoad") {
        const names = await store.list();
        return Object.fromEntries(await Promise.all(names.map(async name => [name, await store.get(name)])));
      }
      if (method === "vaultSet") return void (await store.set(String(input?.key ?? ""), String(input?.value ?? "")));
      if (method === "vaultRemove") return void (await store.remove(String(input?.key ?? "")));
      throw new Error("Unsupported vault action.");
    },
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(path, () => resolve());
  });
  return listener;
}
