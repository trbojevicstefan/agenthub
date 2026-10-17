import assert from "node:assert/strict";
import { test } from "node:test";
import { environmentReader, loadSecrets, secretManagerReader } from "../src/secrets.js";
import { loadConfig } from "../src/config.js";

const base = { BETTER_AUTH_SECRET: "x".repeat(40), DATABASE_URL: "postgres://localhost/opaya", ENTITLEMENTS_PRIVATE_KEY: "{}" };

test("development reads secrets from the environment", async () => {
  const secrets = await loadSecrets(environmentReader({ ...base, GITHUB_CLIENT_ID: "gh" }), { production: false });
  assert.equal(secrets.DATABASE_URL, base.DATABASE_URL);
  assert.equal(secrets.GITHUB_CLIENT_ID, "gh");
  assert.equal(secrets.STRIPE_SECRET_KEY, undefined);
});

test("a missing required secret stops the start", async () => {
  await assert.rejects(loadSecrets(environmentReader({ DATABASE_URL: "x" }), { production: false }), /BETTER_AUTH_SECRET/);
  await assert.rejects(loadSecrets(environmentReader(base), { production: true }), /STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY/);
  await assert.rejects(loadSecrets(environmentReader({ ...base, BETTER_AUTH_SECRET: "short" }), { production: false }), /32 characters/);
});

test("Secret Manager returns the latest version and treats a missing secret as not set", async () => {
  const urls: string[] = [];
  const auth = {
    async request({ url }: { url: string }) {
      urls.push(url);
      if (url.includes("/GITHUB_CLIENT_ID/")) return { status: 404, data: {} };
      return { status: 200, data: { payload: { data: Buffer.from("value-of-" + url.split("/secrets/")[1]!.split("/")[0]).toString("base64") } } };
    },
  };
  const read = secretManagerReader("opaya-prod", auth as never);
  assert.equal(await read("DATABASE_URL"), "value-of-DATABASE_URL");
  assert.equal(await read("GITHUB_CLIENT_ID"), undefined);
  assert.equal(urls[0], "https://secretmanager.googleapis.com/v1/projects/opaya-prod/secrets/DATABASE_URL/versions/latest:access");
  const denied = secretManagerReader("opaya-prod", { request: async () => ({ status: 403, data: {} }) } as never);
  await assert.rejects(denied("DATABASE_URL"), /HTTP 403/);
  assert.throws(() => secretManagerReader("Bad Project"), /not a valid/);
});

test("production needs https and Secret Manager", async () => {
  await assert.rejects(loadConfig({ ...base, OPAYA_ENV: "production" }), /GCP_PROJECT/);
  await assert.rejects(loadConfig({ ...base, OPAYA_ENV: "production", OPAYA_BASE_URL: "http://app.opaya.dev", GCP_PROJECT: "opaya-prod" }), /https/);
  const config = await loadConfig({ ...base, OPAYA_BASE_URL: "http://localhost:4000/", PORT: "4000" });
  assert.equal(config.baseURL, "http://localhost:4000");
  assert.equal(config.port, 4000);
});
