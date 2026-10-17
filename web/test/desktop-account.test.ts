// The desktop app's account code (desktop/account.cjs) against this server: device sign-in, the signed entitlements and
// the offline check, end to end.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setup, verifiedUser } from "./helpers.js";

const require = createRequire(import.meta.url);
const { Account, verify } = require("../../desktop/account.cjs");
const { Vault } = require("../../desktop/store.cjs");
const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "test", encryptString: (s: string) => Buffer.from("enc:" + s), decryptString: (b: Buffer) => b.toString().slice(4) };

test("the desktop app signs in to this server and checks its entitlements offline", async t => {
  const env = await setup();
  t.after(env.close);
  const root = await mkdtemp(join(tmpdir(), "opaya-account-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = new Vault(root, safeStorage);
  await vault.load();
  const { browser } = await verifiedUser(env);
  let approved: Promise<void> | undefined;
  const opened: string[] = [];
  const account = new Account({
    root,
    vault,
    baseUrl: env.config.baseURL,
    keys: [],
    name: "Test Mac",
    version: "0.36.0",
    fetchImpl: (url: string, init: RequestInit) => env.app.fetch(new Request(url, { ...init, headers: { ...(init.headers as Record<string, string>), "x-forwarded-for": "198.51.100.20" } })),
    openExternal: async (url: string) => {
      opened.push(url);
      // The user approves in the browser.
      const page = new URL(url);
      approved = (async () => {
        await browser.fetch(page.pathname + page.search);
        await browser.fetch("/device", { form: { user_code: page.searchParams.get("user_code")!, action: "approve" } });
      })();
    },
    // Between polls: wait for the approval, and let the server accept the next poll at once.
    sleep: async () => {
      await approved;
      await env.db.updateTable("deviceCode").set({ lastPolledAt: null }).execute();
    },
  });
  await account.load();
  await account.signIn();
  await account.polling;
  assert.equal(opened[0]!.startsWith(`${env.config.baseURL}/device?user_code=`), true);
  const state = account.state();
  assert.equal(state.signedIn, true, state.error);
  assert.equal(state.email, "ana@example.com");
  assert.equal(state.plan, "free");
  assert.equal(state.limits.hosts, 1);
  // The token was signed with jose on the server and checks with node:crypto on the desktop.
  const saved = account.data.token as string;
  assert.equal(verify(saved, env.signer.jwks.keys, { issuer: env.config.baseURL }).org, (await env.db.selectFrom("member").select("organizationId").executeTakeFirstOrThrow()).organizationId);
  // The server knows the session as the desktop app on "Test Mac".
  const session = await env.db.selectFrom("session").select(["client", "deviceName", "userAgent"]).where("client", "=", "desktop").executeTakeFirstOrThrow();
  assert.equal(session.deviceName, "Test Mac");
  assert.match(session.userAgent as string, /^Opaya\/0\.36\.0/);
  await account.signOut();
  assert.equal(await env.db.selectFrom("session").select("id").where("client", "=", "desktop").executeTakeFirst(), undefined);
});
