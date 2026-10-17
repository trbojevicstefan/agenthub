import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { bearer, deviceAuthorization, organization, twoFactor } from "better-auth/plugins";
import type Stripe from "stripe";
import { billingPlugin, deleteOrganizationsOf, stripeClient } from "./billing.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { emails, type Mailer } from "./mail.js";

// The device flow (RFC 8628) accepts only these clients. Later: "opaya-cord" for the cord CLI.
export const DESKTOP_CLIENT_ID = "opaya-desktop";
export const DEVICE_CLIENTS = new Set([DESKTOP_CLIENT_ID]);
// The desktop app sends its computer name in this header with /device/code. The /device page shows it.
export const DEVICE_NAME_HEADER = "x-opaya-device";

export interface AuthDeps {
  config: Config;
  db: Database;
  mailer: Mailer;
  stripe?: Stripe;
  rateLimit?: boolean;
  // Before an account is deleted, after its sign-in check: the web app closes its tabs, stops its runtime and removes
  // its folder.
  onDeleteUser?: (userId: string) => Promise<void>;
}

export const deviceName = (value: string | null | undefined) =>
  String(value ?? "")
    .replace(/[^\p{L}\p{N} ._'()-]/gu, "")
    .trim()
    .slice(0, 60);

export function createAuth({ config, db, mailer, stripe = stripeClient(config), rateLimit = config.production, onDeleteUser }: AuthDeps) {
  const s = config.secrets;
  const socialProviders = {
    ...(s.GITHUB_CLIENT_ID && s.GITHUB_CLIENT_SECRET ? { github: { clientId: s.GITHUB_CLIENT_ID, clientSecret: s.GITHUB_CLIENT_SECRET } } : {}),
    ...(s.GOOGLE_CLIENT_ID && s.GOOGLE_CLIENT_SECRET ? { google: { clientId: s.GOOGLE_CLIENT_ID, clientSecret: s.GOOGLE_CLIENT_SECRET, prompt: "select_account" as const } } : {}),
  };

  // Each user owns one personal organization. Plans, subscriptions and hosts belong to the organization, so the Team
  // plan needs no data migration later. Users cannot create other organizations yet.
  async function personalOrganization(userId: string): Promise<string> {
    const owned = async () =>
      (await db.selectFrom("member").select("organizationId").where("userId", "=", userId).where("role", "=", "owner").orderBy("createdAt").executeTakeFirst())?.organizationId as string | undefined;
    const existing = await owned();
    if (existing) return existing;
    const user = await db.selectFrom("user").select(["name", "email"]).where("id", "=", userId).executeTakeFirst();
    try {
      const org = await auth.api.createOrganization({
        body: { name: `${user?.name || String(user?.email || "").split("@")[0] || "My"} (personal)`.slice(0, 80), slug: `personal-${userId.toLowerCase()}`, userId, metadata: { personal: true }, keepCurrentActiveOrganization: true },
      });
      if (org?.id) return org.id;
    } catch (error) {
      // A parallel request created it first (the slug is unique).
      const created = await owned();
      if (created) return created;
      throw error;
    }
    const created = await owned();
    if (!created) throw new Error("The personal organization was not created.");
    return created;
  }

  const auth = betterAuth({
    appName: "Opaya",
    baseURL: config.baseURL,
    basePath: "/api/auth",
    secret: s.BETTER_AUTH_SECRET,
    database: { db, type: "postgres", transaction: true },
    trustedOrigins: [config.baseURL],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: async ({ user, url }) => mailer({ to: user.email, ...emails.reset(url) }),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: 24 * 60 * 60,
      sendVerificationEmail: async ({ user, url }) => mailer({ to: user.email, ...emails.verify(url) }),
    },
    socialProviders,
    account: { accountLinking: { enabled: true, trustedProviders: ["github", "google"] } },
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async user => {
          await onDeleteUser?.(user.id).catch(error => console.warn(`The web app data of a deleted account was not removed: ${(error as Error)?.message ?? error}`));
          await deleteOrganizationsOf({ db, client: stripe, userId: user.id });
        },
      },
    },
    session: {
      additionalFields: {
        // "desktop" for sessions the device flow created. Desktop sessions reach only an allowlist (server.ts).
        client: { type: "string", required: false, input: false },
        deviceName: { type: "string", required: false, input: false },
      },
    },
    rateLimit: {
      enabled: rateLimit,
      storage: "database",
      window: 60,
      max: 120,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60 * 60, max: 10 },
        "/request-password-reset": { window: 60 * 60, max: 5 },
        "/reset-password": { window: 60 * 60, max: 10 },
        "/send-verification-email": { window: 60 * 60, max: 5 },
        "/device/code": { window: 60, max: 10 },
        "/device/token": { window: 60, max: 30 },
      },
    },
    // Caddy sets X-Forwarded-For to the client address.
    advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for"] }, useSecureCookies: config.baseURL.startsWith("https:") },
    databaseHooks: {
      user: { create: { after: async user => void (await personalOrganization(user.id)) } },
      session: {
        create: {
          before: async (session, ctx) => {
            const data: Record<string, unknown> = {};
            if (!(session as { activeOrganizationId?: string }).activeOrganizationId) data.activeOrganizationId = await personalOrganization(session.userId);
            if (ctx?.path === "/device/token") {
              data.client = "desktop";
              const code = String((ctx.body as { device_code?: unknown } | undefined)?.device_code ?? "");
              const row = code ? await db.selectFrom("opaya_device_name").select("name").where("device_code", "=", code).executeTakeFirst() : undefined;
              data.deviceName = row?.name || "Opaya desktop";
            }
            return { data: { ...session, ...data } };
          },
        },
      },
    },
    hooks: {
      after: createAuthMiddleware(async ctx => {
        if (ctx.path !== "/device/code") return;
        const returned = ctx.context.returned as { device_code?: string; user_code?: string } | undefined;
        if (!returned?.device_code || !returned.user_code) return;
        const name = deviceName(ctx.headers?.get(DEVICE_NAME_HEADER)) || "Opaya desktop";
        await db.deleteFrom("opaya_device_name").where("created_at", "<", new Date(Date.now() - 60 * 60 * 1000)).execute();
        await db.insertInto("opaya_device_name").values({ device_code: returned.device_code, user_code: returned.user_code, name }).execute();
      }),
    },
    plugins: [
      twoFactor({ issuer: "Opaya" }),
      organization({ allowUserToCreateOrganization: false }),
      deviceAuthorization({ verificationUri: "/device", validateClient: clientId => DEVICE_CLIENTS.has(clientId), expiresIn: "15m", interval: "5s" }),
      bearer(),
      billingPlugin({ config, db, client: stripe }),
    ],
  });
  return Object.assign(auth, { personalOrganization, stripe });
}

export type Auth = ReturnType<typeof createAuth>;
