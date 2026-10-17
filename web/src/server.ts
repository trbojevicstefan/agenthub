import { Hono, type Context, type MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { Auth } from "./auth.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { entitlementsFor, type Signer } from "./entitlements.js";
import type { SecretStore } from "./secret-store.js";
import { webSshKey } from "./ssh-key.js";
import { pull, push, SECRET_KEY, SyncError } from "./sync.js";
import { pageRoutes } from "./pages/routes.js";
import { appRoutes } from "./runtime/app.js";

export type Session = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;
export type Env = { Variables: { session: Session | null } };

export interface AppDeps {
  config: Config;
  auth: Auth;
  db: Database;
  signer: Signer;
  // The web app's secret store of an organization (Phase 2; absent when the web app is off).
  secrets?: (organizationId: string) => SecretStore;
}

// A desktop session (made by the device flow) reaches only these paths. So a desktop app cannot create an account or
// start a checkout, even with a changed build: the server refuses it.
const DESKTOP_PATHS = new Set(["/api/auth/get-session", "/api/auth/sign-out", "/api/auth/device/code", "/api/auth/device/token", "/api/entitlements", "/api/web-ssh-key", "/api/sync", "/api/sync/secrets", "/api/health", "/.well-known/jwks.json"]);
export const desktopAllowed = (path: string) => DESKTOP_PATHS.has(path.replace(/\/+$/, "") || "/");

const hasCredentials = (c: Context) => Boolean(c.req.header("authorization") || /(^|;\s*)(__Secure-)?better-auth\.session_token=/.test(c.req.header("cookie") ?? ""));

// Reads the session (cookie or bearer token) one time for each request and refuses desktop sessions off the allowlist.
function sessions(auth: Auth): MiddlewareHandler<Env> {
  return async (c, next) => {
    c.set("session", null);
    if (hasCredentials(c)) {
      const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
      if (session?.session.client === "desktop" && !desktopAllowed(c.req.path)) return c.json({ code: "DESKTOP_NOT_ALLOWED", message: "The desktop app cannot do this. Open app.opaya.dev in a browser." }, 403);
      c.set("session", session);
    }
    await next();
  };
}

// Pages load only their own files. Forms may lead to Stripe and to the GitHub and Google sign-in pages.
const CSP = {
  defaultSrc: ["'self'"],
  imgSrc: ["'self'", "data:"],
  styleSrc: ["'self'"],
  scriptSrc: ["'self'"],
  connectSrc: ["'self'"],
  formAction: ["'self'", "https://checkout.stripe.com", "https://billing.stripe.com", "https://github.com", "https://accounts.google.com"],
  frameAncestors: ["'none'"],
  baseUri: ["'none'"],
  objectSrc: ["'none'"],
};

export function createApp(deps: AppDeps) {
  const { config, auth, db, signer, secrets } = deps;
  const app = new Hono<Env>();
  const pageHeaders = secureHeaders({ contentSecurityPolicy: CSP, strictTransportSecurity: false, referrerPolicy: "strict-origin-when-cross-origin" });
  // /app sets its own policy (runtime/app.ts): the shared interface uses inline styles.
  const appHeaders = secureHeaders({ contentSecurityPolicy: undefined, strictTransportSecurity: false, referrerPolicy: "strict-origin-when-cross-origin", xFrameOptions: "DENY" });
  app.use("*", (c, next) => (c.req.path === "/app" || c.req.path.startsWith("/app/") ? appHeaders(c, next) : pageHeaders(c, next)));
  app.use("*", sessions(auth));
  app.get("/api/health", c => c.json({ ok: true, production: config.production }));
  app.on(["GET", "POST"], "/api/auth/*", c => auth.handler(c.req.raw));
  // The public keys that check entitlement tokens.
  app.get("/.well-known/jwks.json", c => c.json(signer.jwks, 200, { "cache-control": "public, max-age=3600" }));
  // The signed entitlements of the session's organization. The desktop app calls this at start and every 24 hours.
  app.get("/api/entitlements", async c => {
    const session = c.get("session");
    if (!session) return c.json({ code: "UNAUTHORIZED", message: "Sign in first." }, 401);
    const organizationId = (session.session.activeOrganizationId as string | null | undefined) || (await auth.personalOrganization(session.user.id));
    const entitlements = await entitlementsFor(db, organizationId);
    const { token, expiresAt } = await signer.sign({ userId: session.user.id, organizationId }, entitlements);
    return c.json({ token, expiresAt, ...entitlements, account: { email: session.user.email, name: session.user.name } }, 200, { "cache-control": "no-store" });
  });
  // The public half of the organization's web SSH key, and the address machines must allow. The desktop app's
  // "Allow web access" adds it to a machine's authorized_keys.
  if (config.runtime && secrets)
    app.get("/api/web-ssh-key", async c => {
      const session = c.get("session");
      if (!session) return c.json({ code: "UNAUTHORIZED", message: "Sign in first." }, 401);
      const organizationId = (session.session.activeOrganizationId as string | null | undefined) || (await auth.personalOrganization(session.user.id));
      if (!(await entitlementsFor(db, organizationId)).features.web) return c.json({ code: "PLAN", message: "The web app comes with Pro and Fleet." }, 403);
      return c.json({ publicKey: await webSshKey(secrets(organizationId), organizationId), comment: `opaya-web ${organizationId}`, address: config.runtime!.egressIp }, 200, { "cache-control": "no-store" });
    });
  // Sync (SYNC_PLAN.md): the desktop app pulls and pushes records here with its desktop session.
  const syncAccess = async (c: Context<Env>) => {
    const session = c.get("session");
    if (!session) return { error: c.json({ code: "UNAUTHORIZED", message: "Sign in first." }, 401) };
    const organizationId = (session.session.activeOrganizationId as string | null | undefined) || (await auth.personalOrganization(session.user.id));
    if (!(await entitlementsFor(db, organizationId)).features.sync) return { error: c.json({ code: "PLAN", message: "Sync comes with Pro and Fleet." }, 403) };
    return { organizationId };
  };
  const syncFailed = (c: Context<Env>, error: unknown) => {
    if (error instanceof SyncError) return c.json({ code: "SYNC", message: error.message }, error.status);
    throw error;
  };
  app.get("/api/sync", async c => {
    const access = await syncAccess(c);
    if (access.error) return access.error;
    try {
      return c.json(await pull(db, access.organizationId, Number(c.req.query("since") ?? 0)), 200, { "cache-control": "no-store" });
    } catch (error) {
      return syncFailed(c, error);
    }
  });
  app.post("/api/sync", async c => {
    const access = await syncAccess(c);
    if (access.error) return access.error;
    const body = (await c.req.json().catch(() => null)) as { records?: unknown } | null;
    try {
      return c.json(await push(db, access.organizationId, body?.records));
    } catch (error) {
      return syncFailed(c, error);
    }
  });
  // The value of a desktop Vault key marked "Sync to web", or its removal. Values never travel in records.
  if (config.runtime && secrets)
    app.post("/api/sync/secrets", async c => {
      const access = await syncAccess(c);
      if (access.error) return access.error;
      const body = (await c.req.json().catch(() => null)) as { key?: unknown; value?: unknown } | null;
      const key = String(body?.key ?? "");
      if (!SECRET_KEY.test(key)) return c.json({ code: "SYNC", message: "Invalid key name." }, 400);
      if (typeof body?.value === "string" && body.value) await secrets(access.organizationId).set(key, body.value);
      else await secrets(access.organizationId).remove(key);
      return c.json({ ok: true });
    });
  if (config.runtime) appRoutes(app, deps);
  pageRoutes(app, deps);
  return app;
}
