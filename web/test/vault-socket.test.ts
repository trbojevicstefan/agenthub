import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { desktopModule } from "../src/runtime/desktop.js";
import { newSocketToken, serveVault } from "../src/runtime/vault-socket.js";
import { kmsSecretStore, localKeyWrapper } from "../src/secret-store.js";
import { setup } from "./helpers.js";

const { RemoteVault } = desktopModule("remote-vault.cjs");

test("a runtime container reads and changes its user's secrets through its vault socket", async t => {
  const env = await setup();
  t.after(env.close);
  const dir = await mkdtemp(join(tmpdir(), "opaya-vault-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = kmsSecretStore({ db: env.db, kms: localKeyWrapper(), organizationId: "org_a" });
  await store.set("agent_one", "token-one");
  const token = newSocketToken(), path = join(dir, "vault.sock");
  const listener = await serveVault({ path, token, store });
  t.after(() => listener.close());

  const vault = new RemoteVault({ address: path, token });
  await vault.load();
  assert.equal(vault.get("agent_one"), "token-one");
  assert.equal(vault.has("agent_one"), true);
  await vault.set("s_openai", JSON.stringify("sk-test"));
  assert.equal(await store.get("s_openai"), JSON.stringify("sk-test"), "written to the server store");
  await vault.remove("agent_one");
  assert.equal(await store.has("agent_one"), false);
  assert.deepEqual(await vault.list(), ["s_openai"]);
  await assert.rejects(vault.set("bad key", "x"), /Invalid identifier/);
  vault.close();

  const stranger = new RemoteVault({ address: path, token: newSocketToken() });
  await assert.rejects(stranger.load(), /rejected|disconnected|timed out/);
});
