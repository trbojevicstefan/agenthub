// The web SSH key (Phase 2): one Ed25519 key pair for each user, in OpenSSH's own formats, made with node:crypto (the
// server has no ssh-keygen). The private key stays in the user's KMS secret store; the runtime gets it through its
// Vault socket. The public key line ends with "opaya-web <organization ID>", so the desktop app can remove exactly that
// line from a machine's authorized_keys. The public key is always read from the private key, so the runtime cannot
// make the desktop app install another key.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { SecretStore } from "./secret-store.js";

export const PRIVATE_KEY_NAME = "opaya_web_ssh_key";
// Vault keys that only the web server writes: the runtime's Vault socket refuses changes to them (vault-socket.ts).
export const RESERVED_NAMES = new Set([PRIVATE_KEY_NAME]);

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

// The public key line of an OpenSSH private key. openssh-key-v1 keeps the public key unencrypted after the header.
export function publicKeyOf(privateKey: string, comment: string) {
  const blob = Buffer.from(privateKey.replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, "").replace(/\s+/g, ""), "base64");
  const magic = "openssh-key-v1\0";
  let at = magic.length;
  const field = () => {
    const n = blob.readUInt32BE(at);
    if (at + 4 + n > blob.length) throw new RangeError("Short key.");
    const value = blob.subarray(at + 4, at + 4 + n);
    at += 4 + n;
    return value;
  };
  try {
    if (blob.subarray(0, at).toString("latin1") !== magic) throw new Error("No OpenSSH key.");
    field(), field(), field(); // cipher, KDF, KDF options
    if (blob.readUInt32BE(at) !== 1) throw new Error("Not one key.");
    at += 4;
    const pub = field();
    if (pub.length !== 51 || pub.subarray(0, 15).toString("latin1") !== "\0\0\0\x0bssh-ed25519") throw new Error("Not an Ed25519 key.");
    return `ssh-ed25519 ${pub.toString("base64")} ${comment}`;
  } catch {
    throw new Error("The stored web SSH key is not valid.");
  }
}

// The organization's web SSH key, made the first time it is needed. Two first calls at the same time keep the key
// that was stored first.
export async function webSshKey(store: SecretStore, organizationId: string) {
  const comment = `opaya-web ${organizationId}`;
  let stored = await store.get(PRIVATE_KEY_NAME);
  if (!stored) {
    // The Vault keeps one line per value, so the private key is kept as base64.
    await store.create(PRIVATE_KEY_NAME, Buffer.from(newSshKey(comment).privateKey).toString("base64"));
    stored = await store.get(PRIVATE_KEY_NAME);
  }
  return publicKeyOf(Buffer.from(stored, "base64").toString("utf8"), comment);
}
