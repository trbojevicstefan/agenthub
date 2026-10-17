import { environmentReader, loadSecrets, secretManagerReader, type Secrets } from "./secrets.js";

export interface Config {
  production: boolean;
  // The public address, for example https://app.opaya.dev. Links in emails and Stripe return addresses use it.
  baseURL: string;
  port: number;
  emailFrom: string;
  // Stripe Tax on Checkout. Turn it on only after Stripe Tax is set up and the company is registered where it must be.
  automaticTax: boolean;
  // The web app (Phase 2): where the users' folders and the launcher's socket are, and the Cloud KMS key for user
  // secrets. Without usersDir the web app is off.
  runtime: { usersDir: string; launcherDir: string; kmsKey: string } | null;
  secrets: Secrets;
}

function runtimeConfig(env: NodeJS.ProcessEnv, production: boolean): Config["runtime"] {
  if (!env.OPAYA_USERS_DIR) return null;
  if (production && !env.OPAYA_KMS_KEY) throw new Error("Set OPAYA_KMS_KEY: the web app keeps user secrets with Cloud KMS.");
  return { usersDir: env.OPAYA_USERS_DIR.replace(/\/+$/, ""), launcherDir: (env.OPAYA_LAUNCHER_DIR || "/run/opaya-launcher").replace(/\/+$/, ""), kmsKey: env.OPAYA_KMS_KEY || "" };
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const production = env.OPAYA_ENV === "production";
  const baseURL = (env.OPAYA_BASE_URL || (production ? "https://app.opaya.dev" : "http://localhost:3000")).replace(/\/+$/, "");
  const url = new URL(baseURL);
  if (production && url.protocol !== "https:") throw new Error("OPAYA_BASE_URL must use https in production.");
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT is not a valid port.");
  const read = env.GCP_PROJECT ? secretManagerReader(env.GCP_PROJECT) : environmentReader(env);
  if (production && !env.GCP_PROJECT) throw new Error("Set GCP_PROJECT: production reads its secrets from Google Secret Manager.");
  return {
    production,
    baseURL,
    port,
    emailFrom: env.OPAYA_EMAIL_FROM || "Opaya <accounts@opaya.dev>",
    automaticTax: env.STRIPE_AUTOMATIC_TAX === "true",
    runtime: runtimeConfig(env, production),
    secrets: await loadSecrets(read, { production }),
  };
}
