import { Hono, type Context, type MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { Auth } from "./auth.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { entitlementsFor, type Signer } from "./entitlements.js";
import { pageRoutes } from "./pages/routes.js";

export type Session = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;
export type Env = { Variables: { session: Session | null } };

export interface AppDeps {
  config: Config;
  auth: Auth;
  db: Database;
  signer: Signer;
}

// A desktop session (made by the device flow) reaches only these paths. So a desktop app cannot create an account or
// start a checkout, even with a changed build: the server refuses it.
const DESKTOP_PATHS = new Set(["/api/auth/get-session", "/api/auth/sign-out", "/api/auth/device/code", "/api/auth/device/token", "/api/entitlements", "/api/health", "/.well-known/jwks.json"]);
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
  const { config, auth, db, signer } = deps;
  const app = new Hono<Env>();
  app.use("*", secureHeaders({ contentSecurityPolicy: CSP, strictTransportSecurity: false, referrerPolicy: "strict-origin-when-cross-origin" }));
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
  pageRoutes(app, deps);
  return app;
}
