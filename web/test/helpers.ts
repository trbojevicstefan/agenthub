import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PGliteDialect } from "kysely-pglite-dialect";
import { createAuth } from "../src/auth.js";
import type { Config } from "../src/config.js";
import { createDatabase } from "../src/db.js";
import { createSigner, newKey } from "../src/entitlements.js";
import { kmsSecretStore, localKeyWrapper } from "../src/secret-store.js";
import type { Email } from "../src/mail.js";
import { migrate } from "../src/migrate.js";
import { createApp } from "../src/server.js";
import { fakeStripe, WEBHOOK_SECRET } from "./stripe-fake.js";

export const BASE = "http://localhost:3000";

export function testConfig(secrets: Config["secrets"] = {}): Config {
  return {
    production: false,
    baseURL: BASE,
    port: 3000,
    emailFrom: "Opaya <test@opaya.dev>",
    automaticTax: false,
    runtime: null,
    secrets: { BETTER_AUTH_SECRET: "test-secret-for-opaya-web-0123456789", DATABASE_URL: "pglite://memory", ENTITLEMENTS_PRIVATE_KEY: "", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, ...secrets },
  };
}

export async function setup({ rateLimit = false, secrets = {}, runtime = null, onDeleteUser }: { rateLimit?: boolean; secrets?: Config["secrets"]; runtime?: Config["runtime"]; onDeleteUser?: (userId: string) => Promise<void> } = {}) {
  const kms = localKeyWrapper();
  const pglite = new PGlite();
  const db = createDatabase(new PGliteDialect(pglite));
  const mails: Email[] = [];
  const config = { ...testConfig(secrets), runtime };
  const stripe = fakeStripe();
  const auth = createAuth({ config, db, mailer: async m => void mails.push(m), stripe: stripe.client, rateLimit, onDeleteUser });
  await migrate(auth, db);
  const signer = await createSigner(JSON.stringify(await newKey("test-key")), config.baseURL);
  const store = (organizationId: string) => kmsSecretStore({ db, kms, organizationId });
  const app = createApp({ config, auth, db, signer, secrets: store });
  return { pglite, db, mails, config, auth, stripe, signer, app, kms, store, close: () => db.destroy() };
}

// A browser for tests: keeps cookies, sends the Origin header like a real browser does, and talks to `handle`.
export class Browser {
  cookies = new Map<string, string>();
  constructor(private handle: (request: Request) => Response | Promise<Response>, private ip = "203.0.113.7") {}
  async fetch(path: string, init: RequestInit & { json?: unknown; form?: Record<string, string> } = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    headers.set("x-forwarded-for", this.ip);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    if (init.form) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(init.form).toString();
    }
    const method = init.method ?? (body !== undefined && body !== null ? "POST" : "GET");
    if (method !== "GET" && !headers.has("origin")) headers.set("origin", BASE);
    const response = await this.handle(new Request(new URL(path, BASE), { ...init, method, headers, body, redirect: "manual" }));
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const at = pair!.indexOf("=");
      const name = pair!.slice(0, at).trim(), value = pair!.slice(at + 1).trim();
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
}

export const linkIn = (mail: Email | undefined) => /https?:\/\/\S+/.exec(mail?.text ?? "")?.[0] ?? "";

// A user who signed up and confirmed the email, signed in in `browser`.
export async function verifiedUser(env: Awaited<ReturnType<typeof setup>>, { email = "ana@example.com", password = "correct horse battery", name = "Ana", ip = "203.0.113.7" } = {}) {
  const browser = new Browser(r => env.app.fetch(r), ip);
  await browser.fetch("/api/auth/sign-up/email", { json: { email, password, name } });
  const link = new URL(linkIn(env.mails.at(-1)));
  await browser.fetch(link.pathname + link.search);
  const session = (await (await browser.fetch("/api/auth/get-session")).json()) as { user: { id: string; email: string }; session: { activeOrganizationId: string } };
  return { browser, user: session.user, organizationId: session.session.activeOrganizationId };
}

// RFC 6238 code for an otpauth:// URI, as an authenticator app makes it.
export function totp(uri: string, at = Date.now()) {
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

// Pro in its trial for the organization: Checkout, then Stripe's webhook.
export async function startTrial(env: Awaited<ReturnType<typeof setup>>, browser: Browser, organizationId: string, plan = "pro") {
  await browser.fetch("/api/auth/subscription/upgrade", { json: { plan, customerType: "organization", referenceId: organizationId, successUrl: "/billing", cancelUrl: "/pricing" } });
  const params = env.stripe.calls.filter(c => c.method === "checkout.sessions.create").at(-1)!.params;
  const customerId = (await env.db.selectFrom("organization").select("stripeCustomerId").where("id", "=", organizationId).executeTakeFirstOrThrow()).stripeCustomerId as string;
  const sub = env.stripe.subscription({ id: `sub_${organizationId}`, customer: customerId, lookupKey: `opaya_${plan}_month`, status: "trialing", trialDays: 14, metadata: params.subscription_data.metadata });
  const { payload, signature } = env.stripe.event("checkout.session.completed", { object: "checkout.session", mode: "subscription", subscription: sub.id, client_reference_id: organizationId, metadata: params.metadata });
  await new Browser(r => env.app.fetch(r)).fetch("/api/auth/stripe/webhook", { method: "POST", body: payload, headers: { "stripe-signature": signature, "content-type": "application/json", origin: "" } });
  return sub;
}
