import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudKms, kmsSecretStore, localKeyWrapper, type KeyWrapper } from "../src/secret-store.js";
import { setup } from "./helpers.js";

test("secrets are stored as ciphertext and decrypt only for their organization and name", async t => {
  const env = await setup();
  t.after(env.close);
  const wrapper = localKeyWrapper(), seen: string[] = [];
  const kms: KeyWrapper = { encrypt: (p, aad) => (seen.push(aad.toString()), wrapper.encrypt(p, aad)), decrypt: (c, aad) => wrapper.decrypt(c, aad) };
  const store = kmsSecretStore({ db: env.db, kms, organizationId: "org_a" });
  await store.set("OPENAI_API_KEY", "sk-live-value-123");
  assert.equal(await store.get("OPENAI_API_KEY"), "sk-live-value-123");
  assert.equal(seen[0], "opaya-secret\0org_a\0OPENAI_API_KEY", "KMS gets the organization and the name as context");
  const row = await env.db.selectFrom("opaya_secret").selectAll().executeTakeFirstOrThrow();
  assert.ok(!Buffer.from(row.ciphertext).toString().includes("sk-live"), "no plaintext in Postgres");
  assert.equal(row.kms_key_version, "local");
  assert.equal(await store.has("OPENAI_API_KEY"), true);
  assert.deepEqual(await store.list(), ["OPENAI_API_KEY"]);

  // The row copied to another organization, or under another name, does not decrypt.
  await env.db.insertInto("opaya_secret").values({ ...row, organization_id: "org_b" }).execute();
  await assert.rejects(kmsSecretStore({ db: env.db, kms, organizationId: "org_b" }).get("OPENAI_API_KEY"));
  await env.db.insertInto("opaya_secret").values({ ...row, name: "OTHER" }).execute();
  await assert.rejects(store.get("OTHER"));

  await store.set("OPENAI_API_KEY", "sk-new");
  assert.equal(await store.get("OPENAI_API_KEY"), "sk-new");
  await store.remove("OPENAI_API_KEY");
  assert.equal(await store.get("OPENAI_API_KEY"), "");
  await assert.rejects(store.set("../x", "v"), /Invalid secret name/);
  await assert.rejects(store.set("constructor", "v"), /Invalid secret name/);
  await assert.rejects(store.set("A", "x".repeat(70_000)), /Invalid secret value/);
});

test("Cloud KMS gets the key name, base64 bodies and the context", async () => {
  const requests: { url: string; data: Record<string, string> }[] = [];
  const auth = {
    async request({ url, data }: { url: string; data: Record<string, string> }) {
      requests.push({ url, data });
      return url.endsWith(":encrypt") ? { status: 200, data: { name: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/3", ciphertext: Buffer.from("wrapped").toString("base64") } } : { status: 200, data: { plaintext: Buffer.from("key").toString("base64") } };
    },
  };
  const kms = cloudKms("projects/opaya-prod/locations/europe-west3/keyRings/opaya/cryptoKeys/user-secrets", auth as never);
  const wrapped = await kms.encrypt(Buffer.from("key"), Buffer.from("ctx"));
  assert.equal(wrapped.keyVersion, "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/3");
  assert.equal(requests[0]!.url, "https://cloudkms.googleapis.com/v1/projects/opaya-prod/locations/europe-west3/keyRings/opaya/cryptoKeys/user-secrets:encrypt");
  assert.deepEqual(requests[0]!.data, { plaintext: Buffer.from("key").toString("base64"), additionalAuthenticatedData: Buffer.from("ctx").toString("base64") });
  assert.equal((await kms.decrypt(wrapped.ciphertext, Buffer.from("ctx"))).toString(), "key");
  assert.throws(() => cloudKms("not a key"), /not a Cloud KMS key name/);
  const denied = cloudKms("projects/opaya-prod/locations/europe-west3/keyRings/opaya/cryptoKeys/user-secrets", { request: async () => ({ status: 403, data: {} }) } as never);
  await assert.rejects(denied.encrypt(Buffer.from("k"), Buffer.from("c")), /HTTP 403/);
});
