// User secrets on the server (Phase 2): envelope encryption with Google Cloud KMS.
// Each secret gets a new random 256-bit data key. AES-256-GCM encrypts the value with it, and Cloud KMS encrypts
// (wraps) the data key. Both use the same additional authenticated data: the organization ID and the secret name, so a
// row copied to another organization or another name does not decrypt. Postgres keeps only ciphertext.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { sql } from "kysely";
import type { Database } from "./db.js";

export interface SecretStore {
  get(name: string): Promise<string>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
  has(name: string): Promise<boolean>;
  list(): Promise<string[]>;
}

// Wraps and unwraps data keys. Production: Cloud KMS. Tests: a local key with the same rules.
export interface KeyWrapper {
  encrypt(plaintext: Buffer, aad: Buffer): Promise<{ ciphertext: Buffer; keyVersion: string }>;
  decrypt(ciphertext: Buffer, aad: Buffer): Promise<Buffer>;
}

const NAME = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_VALUE = 64 * 1024;
const aadFor = (organizationId: string, name: string) => Buffer.from(`opaya-secret\0${organizationId}\0${name}`);

export const SECRET_TABLE = sql`create table if not exists opaya_secret (
  organization_id text not null,
  name text not null,
  ciphertext bytea not null,
  iv bytea not null,
  tag bytea not null,
  wrapped_key bytea not null,
  kms_key_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, name)
)`;

// keyName: projects/P/locations/L/keyRings/R/cryptoKeys/K. The service account needs
// roles/cloudkms.cryptoKeyEncrypterDecrypter on this key only.
export function cloudKms(keyName: string, auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloudkms"] })): KeyWrapper {
  if (!/^projects\/[a-z][a-z0-9-]+\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+$/.test(keyName)) throw new Error("OPAYA_KMS_KEY is not a Cloud KMS key name.");
  const call = async (op: "encrypt" | "decrypt", body: Record<string, string>) => {
    const response = await auth.request<Record<string, string>>({ url: `https://cloudkms.googleapis.com/v1/${keyName}:${op}`, method: "POST", data: body, validateStatus: () => true });
    if (response.status !== 200) throw new Error(`Cloud KMS ${op} failed (HTTP ${response.status}).`);
    return response.data;
  };
  return {
    async encrypt(plaintext, aad) {
      const r = await call("encrypt", { plaintext: plaintext.toString("base64"), additionalAuthenticatedData: aad.toString("base64") });
      return { ciphertext: Buffer.from(r.ciphertext!, "base64"), keyVersion: r.name ?? keyName };
    },
    async decrypt(ciphertext, aad) {
      const r = await call("decrypt", { ciphertext: ciphertext.toString("base64"), additionalAuthenticatedData: aad.toString("base64") });
      return Buffer.from(r.plaintext!, "base64");
    },
  };
}

// For development and tests only: a local AES key in place of Cloud KMS, with the same AAD check.
export function localKeyWrapper(key = randomBytes(32)): KeyWrapper {
  return {
    async encrypt(plaintext, aad) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(aad);
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]), keyVersion: "local" };
    },
    async decrypt(ciphertext, aad) {
      const decipher = createDecipheriv("aes-256-gcm", key, ciphertext.subarray(0, 12)).setAAD(aad);
      decipher.setAuthTag(ciphertext.subarray(12, 28));
      return Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]);
    },
  };
}

export function kmsSecretStore({ db, kms, organizationId }: { db: Database; kms: KeyWrapper; organizationId: string }): SecretStore {
  const checkName = (name: string) => {
    if (!NAME.test(name) || Object.hasOwn(Object.prototype, name)) throw new Error("Invalid secret name.");
    return name;
  };
  return {
    async get(name) {
      const row = await db.selectFrom("opaya_secret").selectAll().where("organization_id", "=", organizationId).where("name", "=", checkName(name)).executeTakeFirst();
      if (!row) return "";
      const aad = aadFor(organizationId, name);
      const dataKey = await kms.decrypt(Buffer.from(row.wrapped_key), aad);
      try {
        const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(row.iv)).setAAD(aad);
        decipher.setAuthTag(Buffer.from(row.tag));
        return Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]).toString("utf8");
      } finally {
        dataKey.fill(0);
      }
    },
    async set(name, value) {
      checkName(name);
      if (typeof value !== "string" || Buffer.byteLength(value) > MAX_VALUE || value.includes("\0")) throw new Error("Invalid secret value.");
      if (!value) return this.remove(name);
      const aad = aadFor(organizationId, name), dataKey = randomBytes(32), iv = randomBytes(12);
      try {
        const cipher = createCipheriv("aes-256-gcm", dataKey, iv).setAAD(aad);
        const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        const wrapped = await kms.encrypt(dataKey, aad);
        const row = { organization_id: organizationId, name, ciphertext, iv, tag: cipher.getAuthTag(), wrapped_key: wrapped.ciphertext, kms_key_version: wrapped.keyVersion };
        await db
          .insertInto("opaya_secret")
          .values(row)
          .onConflict(oc => oc.columns(["organization_id", "name"]).doUpdateSet({ ...row, updated_at: sql`now()` }))
          .execute();
      } finally {
        dataKey.fill(0);
      }
    },
    async remove(name) {
      await db.deleteFrom("opaya_secret").where("organization_id", "=", organizationId).where("name", "=", checkName(name)).execute();
    },
    async has(name) {
      return Boolean(await db.selectFrom("opaya_secret").select("name").where("organization_id", "=", organizationId).where("name", "=", checkName(name)).executeTakeFirst());
    },
    async list() {
      return (await db.selectFrom("opaya_secret").select("name").where("organization_id", "=", organizationId).orderBy("name").execute()).map(r => r.name as string);
    },
  };
}
