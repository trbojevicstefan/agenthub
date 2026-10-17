// Makes a new Ed25519 key for entitlement tokens.
//   npm run entitlements:key --workspace web
// Put the private key (the first JSON line) in Secret Manager as ENTITLEMENTS_PRIVATE_KEY. To rotate, put a JSON array
// with the new key first and the old key second, so tokens signed with the old key stay valid for their 14 days.
// With --desktop, the public key is also added to desktop/account-keys.json: the desktop build then checks tokens
// offline from the first start. Commit that file.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { newKey } from "../src/entitlements.js";

const key = await newKey();
const { d: _private, ...publicKey } = key;
console.log("Private key (Secret Manager: ENTITLEMENTS_PRIVATE_KEY):");
console.log(JSON.stringify(key));
console.log("\nPublic key:");
console.log(JSON.stringify(publicKey));
if (process.argv.includes("--desktop")) {
  const file = fileURLToPath(new URL("../../desktop/account-keys.json", import.meta.url));
  const current = JSON.parse(await readFile(file, "utf8").catch(() => '{"keys":[]}')) as { keys: object[] };
  current.keys = [{ ...publicKey, use: "sig" }, ...current.keys].slice(0, 3);
  await writeFile(file, JSON.stringify(current, null, 2) + "\n");
  console.log(`\nAdded the public key to ${file}.`);
}
