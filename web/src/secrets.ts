// App secrets. In production the server reads them from Google Secret Manager at start. In development and tests
// they come from environment variables with the same names.
import { GoogleAuth } from "google-auth-library";

export const REQUIRED_SECRETS = ["BETTER_AUTH_SECRET", "DATABASE_URL", "ENTITLEMENTS_PRIVATE_KEY"] as const;
export const PRODUCTION_SECRETS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "RESEND_API_KEY"] as const;
export const OPTIONAL_SECRETS = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "WEB_PUSH_PUBLIC_KEY", "WEB_PUSH_PRIVATE_KEY"] as const;
export const SECRET_NAMES = [...REQUIRED_SECRETS, ...PRODUCTION_SECRETS, ...OPTIONAL_SECRETS] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export type Secrets = Partial<Record<SecretName, string>>;

// Reads one secret version. Returns undefined when the secret does not exist (an optional login method not set up yet).
export type SecretReader = (name: SecretName) => Promise<string | undefined>;

export function secretManagerReader(project: string, auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] })): SecretReader {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw new Error("GCP_PROJECT is not a valid Google Cloud project ID.");
  return async name => {
    const url = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${name}/versions/latest:access`;
    const response = await auth.request<{ payload?: { data?: string } }>({ url, method: "GET", validateStatus: () => true });
    if (response.status === 404) return undefined;
    if (response.status !== 200) throw new Error(`Secret Manager refused ${name} (HTTP ${response.status}).`);
    const data = response.data.payload?.data;
    return data === undefined ? undefined : Buffer.from(data, "base64").toString("utf8").trim();
  };
}

export function environmentReader(env: NodeJS.ProcessEnv = process.env): SecretReader {
  return async name => env[name] || undefined;
}

export async function loadSecrets(read: SecretReader, { production }: { production: boolean }): Promise<Secrets> {
  const values = await Promise.all(SECRET_NAMES.map(async name => [name, await read(name)] as const));
  const secrets: Secrets = Object.fromEntries(values.filter(([, value]) => value));
  const required: readonly SecretName[] = production ? [...REQUIRED_SECRETS, ...PRODUCTION_SECRETS] : REQUIRED_SECRETS;
  const missing = required.filter(name => !secrets[name]);
  if (missing.length) throw new Error(`Missing secrets: ${missing.join(", ")}.`);
  if (secrets.BETTER_AUTH_SECRET!.length < 32) throw new Error("BETTER_AUTH_SECRET must have at least 32 characters.");
  return secrets;
}
