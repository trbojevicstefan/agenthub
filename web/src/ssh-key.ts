// The web SSH key (Phase 2): one Ed25519 key pair for each user, in OpenSSH's own formats, made with node:crypto (the
// server has no ssh-keygen). The private key stays in the user's KMS secret store; the runtime gets it through its
// Vault socket. The public key line ends with "opaya-web <organization ID>", so the desktop app can remove exactly that
// line from a machine's authorized_keys.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { SecretStore } from "./secret-store.js";

export const PRIVATE_KEY_NAME = "opaya_web_ssh_key";
export const PUBLIC_KEY_NAME = "opaya_web_ssh_pub";

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const sshString = (value: Buffer | string) => {
  const b = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([u32(b.length), b]);
};

export function newSshKey(comment: string) {
  if (!/^[\x20-\x7e]{1,100}$/.test(comment)) throw new Error("Invalid key comment.");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  const publicBlob = Buffer.concat([sshString("ssh-ed25519"), sshString(pub)]);
  // openssh-key-v1, not encrypted: the store encrypts it.
  const check = randomBytes(4);
  let body = Buffer.concat([check, check, sshString("ssh-ed25519"), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(comment)]);
  const padding = Buffer.from(Array.from({ length: (8 - (body.length % 8)) % 8 }, (_, i) => i + 1));
  body = Buffer.concat([body, padding]);
  const blob = Buffer.concat([Buffer.from("openssh-key-v1\0"), sshString("none"), sshString("none"), sshString(""), u32(1), sshString(publicBlob), sshString(body)]);
  const lines = blob.toString("base64").match(/.{1,70}/g)!.join("\n");
  seed.fill(0);
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${publicBlob.toString("base64")} ${comment}`,
  };
}

// The organization's web SSH key, made the first time it is needed.
export async function webSshKey(store: SecretStore, organizationId: string) {
  const existing = await store.get(PUBLIC_KEY_NAME);
  if (existing && (await store.has(PRIVATE_KEY_NAME))) return existing;
  const key = newSshKey(`opaya-web ${organizationId}`);
  // The Vault keeps one line per value, so the private key is kept as base64.
  await store.set(PRIVATE_KEY_NAME, Buffer.from(key.privateKey).toString("base64"));
  await store.set(PUBLIC_KEY_NAME, key.publicKey);
  return key.publicKey;
}
