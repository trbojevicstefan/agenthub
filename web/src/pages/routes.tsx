// The account pages. Forms post here; each handler sends the request on to better-auth through auth.handler, so the
// rate limits and the origin checks of better-auth apply to them too.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { csrf } from "hono/csrf";
import { renderSVG } from "uqr";
import { DEVICE_NAME_HEADER } from "../auth.js";
import { planState } from "../plan-state.js";
import { paidPlans } from "../plans.js";
import type { AppDeps, Env } from "../server.js";
import { AccountPage, browserName, type SessionRow } from "./account.js";
import { CheckEmailPage, ForgotPage, LoginPage, loginNotice, ResetPage, SignUpPage, TwoFactorPage } from "./auth-pages.js";
import { BillingPage, PricingPage, type Invoice } from "./billing.js";
import { DeviceApprovePage, DeviceCodePage, DeviceDonePage } from "./device.js";
import { SITE_CSS } from "./style.js";

type C = Context<Env>;
interface AuthResult<T = any> {
  ok: boolean;
  status: number;
  data: T;
}

// Where a page may send the user after sign-in: our own pages only.
const NEXT_PREFIXES = ["/billing", "/account", "/pricing", "/device", "/app"];
export function safeNext(value: unknown, fallback = "/billing") {
  const next = typeof value === "string" ? value : "";
  if (!/^\/[A-Za-z0-9/_?=&%.~+-]*$/.test(next) || next.startsWith("//") || next.includes("/..")) return fallback;
  return NEXT_PREFIXES.some(p => next === p || next.startsWith(p + "/") || next.startsWith(p + "?")) ? next : fallback;
}

const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "The email or the password is not correct.",
  EMAIL_NOT_VERIFIED: "Confirm your email first. We sent you a new link.",
  USER_ALREADY_EXISTS: "An account with this email exists already. Sign in, or reset the password.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "An account with this email exists already. Sign in, or reset the password.",
  PASSWORD_TOO_SHORT: "The password must have 10 characters or more.",
  PASSWORD_TOO_LONG: "The password must have 128 characters or fewer.",
  INVALID_PASSWORD: "The password is not correct.",
  INVALID_CODE: "The code is not correct. Try again.",
  INVALID_TWO_FACTOR_CODE: "The code is not correct. Try again.",
  INVALID_BACKUP_CODE: "The backup code is not correct.",
  INVALID_TOKEN: "The link is not valid any more. Ask for a new link.",
  FAILED_TO_UNLINK_LAST_ACCOUNT: "You need at least one way to sign in.",
  SESSION_EXPIRED: "For your security, sign in again and then try again.",
  ALREADY_SUBSCRIBED_PLAN: "You have this plan already.",
};
function message(result: AuthResult, fallback = "Something went wrong. Try again.") {
  if (result.status === 429) return "Too many tries. Wait a minute and try again.";
  const code = result.data?.code;
  return (code && MESSAGES[code]) || result.data?.message || fallback;
}

const ACCOUNT_NOTICES: Record<string, string> = {
  profile: "Your profile is saved.",
  password: "Your password is changed. Your other devices are signed out.",
  linked: "The sign-in method is linked.",
  unlinked: "The sign-in method is removed.",
  "2fa-on": "Two-factor authentication is on.",
  "2fa-off": "Two-factor authentication is off.",
  device: "The device is signed out.",
};
const ACCOUNT_ERRORS: Record<string, string> = { link: "The provider was not linked. Try again." };

let logo: Promise<Buffer> | undefined;
const logoFile = () => (logo ??= readFile(fileURLToPath(new URL("../../../ui/assets/opaya-logo.png", import.meta.url))));

export function pageRoutes(app: Hono<Env>, { config, auth, db }: AppDeps) {
  const providers = Object.keys(auth.options.socialProviders ?? {});

  async function call<T = any>(c: C, path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<AuthResult<T>> {
    const headers = new Headers({ origin: config.baseURL });
    for (const name of ["cookie", "user-agent", "x-forwarded-for", "accept-language", DEVICE_NAME_HEADER]) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await auth.handler(new Request(`${config.baseURL}/api/auth${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    for (const cookie of response.headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data: data as T };
  }
  const form = async (c: C) => {
    const body = await c.req.parseBody();
    return (name: string) => (typeof body[name] === "string" ? (body[name] as string).trim() : "");
  };
  const viewerOf = (c: C) => {
    const s = c.get("session");
    return s ? { email: s.user.email, name: s.user.name } : null;
  };
  const signedIn: MiddlewareHandler<Env> = async (c, next) => {
    if (!c.get("session")) return c.redirect(`/login?next=${encodeURIComponent(safeNext(c.req.path + (new URL(c.req.url).search || ""), "/billing"))}`);
    await next();
  };
  const organizationOf = (c: C) => c.get("session")!.session.activeOrganizationId as string;

  // Form posts must come from our own pages (better-auth checks its own JSON routes).
  app.use("*", async (c, next) => (c.req.path.startsWith("/api/") ? next() : csrf({ origin: config.baseURL })(c, next)));

  app.get("/assets/site.css", c => c.body(SITE_CSS, 200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600" }));
  app.get("/assets/opaya-logo.png", async c => c.body(new Uint8Array(await logoFile()), 200, { "content-type": "image/png", "cache-control": "public, max-age=86400" }));
  app.get("/", c => c.redirect(c.get("session") ? "/billing" : "/login"));

  // Sign-up and sign-in.
  app.get("/signup", c => {
    const next = safeNext(c.req.query("next"));
    if (c.get("session")) return c.redirect(next);
    return c.html(<SignUpPage providers={providers} next={next} />);
  });
  app.post("/signup", async c => {
    const f = await form(c);
    const next = safeNext(f("next"));
    const values = { name: f("name").slice(0, 80), email: f("email") };
    const result = await call(c, "/sign-up/email", { name: values.name, email: values.email, password: f("password"), callbackURL: next });
    if (!result.ok) return c.html(<SignUpPage providers={providers} next={next} values={values} error={message(result)} />, result.status === 429 ? 429 : 400);
    return c.html(<CheckEmailPage email={values.email} />);
  });
  app.get("/login", c => {
    const next = safeNext(c.req.query("next"));
    if (c.get("session")) return c.redirect(next);
    return c.html(<LoginPage providers={providers} next={next} {...loginNotice(c.req.query())} />);
  });
  app.post("/login", async c => {
    const f = await form(c);
    const next = safeNext(f("next"));
    const result = await call<{ twoFactorRedirect?: boolean }>(c, "/sign-in/email", { email: f("email"), password: f("password"), rememberMe: true, callbackURL: next });
    if (!result.ok) return c.html(<LoginPage providers={providers} next={next} email={f("email")} error={message(result)} />, result.status === 429 ? 429 : 400);
    if (result.data?.twoFactorRedirect) return c.redirect(`/login/two-factor?next=${encodeURIComponent(next)}`);
    return c.redirect(next);
  });
  app.post("/login/social", async c => {
    const f = await form(c);
    const next = safeNext(f("next"));
    if (!providers.includes(f("provider"))) return c.redirect("/login?error=social");
    const result = await call<{ url?: string }>(c, "/sign-in/social", { provider: f("provider"), callbackURL: next, newUserCallbackURL: next, errorCallbackURL: "/login?error=social" });
    return c.redirect(result.ok && result.data?.url ? result.data.url : "/login?error=social");
  });
  app.get("/login/two-factor", c => c.html(<TwoFactorPage next={safeNext(c.req.query("next"))} />));
  app.post("/login/two-factor", async c => {
    const f = await form(c);
    const next = safeNext(f("next"));
    const code = f("code").replace(/\s+/g, "");
    const trustDevice = f("trust") === "1";
    const result = /^\d{6}$/.test(code) ? await call(c, "/two-factor/verify-totp", { code, trustDevice }) : await call(c, "/two-factor/verify-backup-code", { code, trustDevice });
    if (!result.ok) return c.html(<TwoFactorPage next={next} error={message(result, "The code is not correct. Try again.")} />, result.status === 429 ? 429 : 400);
    return c.redirect(next);
  });
  app.post("/logout", async c => {
    await call(c, "/sign-out", {});
    return c.redirect("/login?notice=signed-out");
  });
  app.get("/forgot-password", c => c.html(<ForgotPage />));
  app.post("/forgot-password", async c => {
    const f = await form(c);
    const result = await call(c, "/request-password-reset", { email: f("email"), redirectTo: `${config.baseURL}/reset-password` });
    if (result.status === 429) return c.html(<ForgotPage error={message(result)} />, 429);
    return c.html(<ForgotPage sent />);
  });
  app.get("/reset-password", c => c.html(<ResetPage token={c.req.query("error") ? "" : c.req.query("token") ?? ""} />));
  app.post("/reset-password", async c => {
    const f = await form(c);
    const result = await call(c, "/reset-password", { newPassword: f("password"), token: f("token") });
    if (!result.ok) return c.html(<ResetPage token={result.data?.code === "INVALID_TOKEN" ? "" : f("token")} error={message(result)} />, 400);
    return c.redirect("/login?notice=reset");
  });

  // The device flow: the desktop app opens /device?user_code=... in the system browser.
  const deviceNameFor = async (code: string) =>
    ((await db.selectFrom("opaya_device_name").select("name").where("user_code", "=", code.replace(/[^A-Za-z0-9]/g, "").toUpperCase()).executeTakeFirst())?.name as string | undefined) ?? "Opaya desktop";
  app.get("/device", signedIn, async c => {
    const viewer = viewerOf(c)!;
    const code = (c.req.query("user_code") ?? "").trim().slice(0, 20);
    if (!code) return c.html(<DeviceCodePage viewer={viewer} />);
    const result = await call<{ status?: string }>(c, `/device?user_code=${encodeURIComponent(code)}`);
    if (!result.ok) return c.html(<DeviceCodePage viewer={viewer} code={code} error="The code is not correct, or it expired. Start the sign-in again in the desktop app." />, 400);
    if (result.data?.status !== "pending") return c.html(<DeviceCodePage viewer={viewer} error="This code was used already. Start the sign-in again in the desktop app." />, 400);
    return c.html(<DeviceApprovePage viewer={viewer} code={code.replace(/[^A-Za-z0-9]/g, "").toUpperCase()} deviceName={await deviceNameFor(code)} />);
  });
  app.post("/device", signedIn, async c => {
    const viewer = viewerOf(c)!;
    const f = await form(c);
    const approve = f("action") === "approve";
    const result = await call(c, approve ? "/device/approve" : "/device/deny", { userCode: f("user_code") });
    if (!result.ok) return c.html(<DeviceCodePage viewer={viewer} error="The code is not correct, or it expired. Start the sign-in again in the desktop app." />, 400);
    return c.html(<DeviceDonePage viewer={viewer} approved={approve} deviceName={await deviceNameFor(f("user_code"))} />);
  });

  // Plans and billing.
  app.get("/pricing", async c => {
    const session = c.get("session");
    const state = session ? await planState(db, organizationOf(c)) : null;
    return c.html(<PricingPage viewer={viewerOf(c)} state={state} error={c.req.query("error") === "checkout" ? "The checkout did not start. Try again." : undefined} />);
  });
  app.post("/billing/checkout", signedIn, async c => {
    const f = await form(c);
    const plan = paidPlans().find(p => p.name === f("plan"));
    if (!plan) return c.redirect("/pricing");
    const result = await call<{ url?: string }>(c, "/subscription/upgrade", {
      plan: plan.name,
      annual: f("interval") === "year",
      referenceId: organizationOf(c),
      customerType: "organization",
      successUrl: "/billing?checkout=done",
      cancelUrl: "/pricing",
      returnUrl: "/billing?checkout=changed",
    });
    if (!result.ok || !result.data?.url) {
      const state = await planState(db, organizationOf(c));
      return c.html(<PricingPage viewer={viewerOf(c)} state={state} error={message(result, "The checkout did not start. Try again.")} />, 400);
    }
    return c.redirect(result.data.url);
  });
  app.post("/billing/portal", signedIn, async c => {
    const result = await call<{ url?: string }>(c, "/subscription/billing-portal", { referenceId: organizationOf(c), customerType: "organization", returnUrl: "/billing" });
    return c.redirect(result.ok && result.data?.url ? result.data.url : "/billing?error=portal");
  });
  app.get("/billing", signedIn, async c => {
    const state = await planState(db, organizationOf(c));
    let invoice: Invoice | null = null;
    if (state.stripeCustomerId && state.stripeSubscriptionId && !state.cancelAtPeriodEnd) {
      try {
        const preview = await auth.stripe.invoices.createPreview({ customer: state.stripeCustomerId, subscription: state.stripeSubscriptionId });
        invoice = { amount: preview.amount_due / 100, currency: preview.currency, date: preview.next_payment_attempt ? new Date(preview.next_payment_attempt * 1000) : preview.period_end ? new Date(preview.period_end * 1000) : null };
      } catch {
        invoice = null;
      }
    }
    const checkout = c.req.query("checkout");
    const notice = checkout === "done" ? "Thank you. Your plan is active. It can take a minute to show here." : checkout === "changed" ? "Your plan is changed." : undefined;
    return c.html(<BillingPage viewer={viewerOf(c)!} state={state} invoice={invoice} notice={notice} error={c.req.query("error") === "portal" ? "The billing page did not open. Try again." : undefined} />);
  });

  // Account.
  async function accountPage(c: C, extra: { setup?: { totpURI: string; backupCodes: string[] }; error?: string } = {}) {
    const session = c.get("session")!;
    const headers = c.req.raw.headers;
    const [accounts, sessions] = await Promise.all([auth.api.listUserAccounts({ headers }), auth.api.listSessions({ headers })]);
    const rows: SessionRow[] = sessions
      .map(s => ({
        id: s.id,
        current: s.id === session.session.id,
        desktop: (s as { client?: string }).client === "desktop",
        name: (s as { client?: string }).client === "desktop" ? `Opaya on ${(s as { deviceName?: string }).deviceName || "a computer"}` : browserName(s.userAgent ?? ""),
        ipAddress: s.ipAddress ?? "",
        createdAt: new Date(s.createdAt),
        updatedAt: new Date(s.updatedAt),
      }))
      .sort((a, b) => Number(b.current) - Number(a.current) || b.updatedAt.getTime() - a.updatedAt.getTime());
    const setup = extra.setup ? { qrSvg: renderSVG(extra.setup.totpURI, { border: 1 }), secret: new URL(extra.setup.totpURI).searchParams.get("secret") ?? "", backupCodes: extra.setup.backupCodes } : undefined;
    const notice = ACCOUNT_NOTICES[c.req.query("notice") ?? ""];
    const error = extra.error ?? ACCOUNT_ERRORS[c.req.query("error") ?? ""];
    return c.html(
      <AccountPage
        viewer={viewerOf(c)!}
        hasPassword={accounts.some(a => a.providerId === "credential")}
        linked={accounts.filter(a => a.providerId !== "credential").map(a => ({ provider: a.providerId, id: a.id }))}
        providers={providers}
        twoFactor={Boolean((session.user as { twoFactorEnabled?: boolean }).twoFactorEnabled)}
        setup={setup}
        sessions={rows}
        notice={extra.setup || extra.error ? undefined : notice}
        error={error}
      />,
      extra.error ? 400 : 200,
    );
  }
  app.get("/account", signedIn, c => accountPage(c));
  const back = (c: C, notice: string, hash = "") => c.redirect(`/account?notice=${notice}${hash}`);
  app.post("/account/profile", signedIn, async c => {
    const f = await form(c);
    const result = await call(c, "/update-user", { name: f("name").slice(0, 80) });
    return result.ok ? back(c, "profile") : accountPage(c, { error: message(result) });
  });
  app.post("/account/password", signedIn, async c => {
    const f = await form(c);
    const result = await call(c, "/change-password", { currentPassword: f("current"), newPassword: f("password"), revokeOtherSessions: true });
    return result.ok ? back(c, "password") : accountPage(c, { error: message(result) });
  });
  app.post("/account/link", signedIn, async c => {
    const f = await form(c);
    if (!providers.includes(f("provider"))) return c.redirect("/account");
    const result = await call<{ url?: string }>(c, "/link-social", { provider: f("provider"), callbackURL: "/account?notice=linked", errorCallbackURL: "/account?error=link" });
    return c.redirect(result.ok && result.data?.url ? result.data.url : "/account?error=link");
  });
  app.post("/account/unlink", signedIn, async c => {
    const f = await form(c);
    const result = await call(c, "/unlink-account", { accountId: f("account") });
    return result.ok ? back(c, "unlinked") : accountPage(c, { error: message(result) });
  });
  app.post("/account/two-factor/enable", signedIn, async c => {
    const f = await form(c);
    const result = await call<{ totpURI?: string; backupCodes?: string[] }>(c, "/two-factor/enable", { password: f("password") });
    if (!result.ok || !result.data?.totpURI) return accountPage(c, { error: message(result) });
    return accountPage(c, { setup: { totpURI: result.data.totpURI, backupCodes: result.data.backupCodes ?? [] } });
  });
  app.post("/account/two-factor/verify", signedIn, async c => {
    const f = await form(c);
    const result = await call(c, "/two-factor/verify-totp", { code: f("code").replace(/\s+/g, "") });
    return result.ok ? back(c, "2fa-on", "#two-factor") : accountPage(c, { error: "The code is not correct. Set up two-factor again and type the newest code." });
  });
  app.post("/account/two-factor/disable", signedIn, async c => {
    const f = await form(c);
    const result = await call(c, "/two-factor/disable", { password: f("password") });
    return result.ok ? back(c, "2fa-off", "#two-factor") : accountPage(c, { error: message(result) });
  });
  app.post("/account/sessions/revoke", signedIn, async c => {
    const f = await form(c);
    const target = (await auth.api.listSessions({ headers: c.req.raw.headers })).find(s => s.id === f("id"));
    if (target && target.id !== c.get("session")!.session.id) await call(c, "/revoke-session", { token: target.token });
    return back(c, "device", "#devices");
  });
  app.post("/account/delete", signedIn, async c => {
    const f = await form(c);
    if (f("confirm") !== "yes") return accountPage(c, { error: "Tick the box to confirm." });
    const password = f("password");
    const result = await call(c, "/delete-user", password ? { password } : {});
    return result.ok ? c.redirect("/login?notice=deleted") : accountPage(c, { error: message(result) });
  });
}
