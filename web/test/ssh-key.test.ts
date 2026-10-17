import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { kmsSecretStore, localKeyWrapper } from "../src/secret-store.js";
import { newSshKey, PRIVATE_KEY_NAME, webSshKey } from "../src/ssh-key.js";
import { setup } from "./helpers.js";

const hasKeygen = (() => {
  try {
    execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
    return true;
  } catch (error) {
    return (error as { status?: number }).status !== undefined;
  }
})();

test("the web SSH key is a valid OpenSSH Ed25519 key pair", { skip: !hasKeygen && "needs ssh-keygen" }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "osk-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = newSshKey("opaya-web org_123");
  assert.match(key.publicKey, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+=* opaya-web org_123$/);
  const file = join(dir, "id");
  await writeFile(file, key.privateKey, { mode: 0o600 });
  // OpenSSH reads the private key and derives the same public key from it.
  const derived = execFileSync("ssh-keygen", ["-y", "-f", file], { encoding: "utf8" }).trim();
  assert.equal(derived.split(" ").slice(0, 2).join(" "), key.publicKey.split(" ").slice(0, 2).join(" "));
  assert.notEqual(newSshKey("x").publicKey, newSshKey("x").publicKey);
  assert.throws(() => newSshKey("bad\ncomment"), /Invalid key comment/);
});

test("each organization gets one web SSH key, kept in its secret store", async t => {
  const env = await setup();
  t.after(env.close);
  const store = kmsSecretStore({ db: env.db, kms: localKeyWrapper(), organizationId: "org_9" });
  const first = await webSshKey(store, "org_9");
  assert.equal(await webSshKey(store, "org_9"), first, "made once");
  assert.match(first, / opaya-web org_9$/);
  const stored = Buffer.from(await store.get(PRIVATE_KEY_NAME), "base64").toString();
  assert.match(stored, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
});
