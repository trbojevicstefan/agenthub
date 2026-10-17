import { raw } from "hono/html";
import type { FC } from "hono/jsx";
import { date, Errors, Field, Layout, PROVIDER_TITLES, type Viewer } from "./layout.js";

export interface SessionRow {
  id: string;
  current: boolean;
  desktop: boolean;
  name: string;
  ipAddress: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TwoFactorSetup {
  qrSvg: string;
  secret: string;
  backupCodes: string[];
}

// A short name for a browser session from its user agent ("Chrome on macOS").
export function browserName(userAgent: string) {
  const ua = userAgent || "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "A browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export const AccountPage: FC<{
  viewer: Viewer;
  hasPassword: boolean;
  // Linked GitHub or Google accounts: the provider and the account row ID (for unlink).
  linked: { provider: string; id: string }[];
  providers: string[];
  twoFactor: boolean;
  setup?: TwoFactorSetup;
  sessions: SessionRow[];
  notice?: string;
  error?: string;
}> = ({ viewer, hasPassword, linked, providers, twoFactor, setup, sessions, notice, error }) => (
  <Layout title="Account" viewer={viewer} current="account">
    <h1>Account</h1>
    <Errors error={error} ok={notice} />

    <section class="card">
      <h2>Profile</h2>
      <form method="post" action="/account/profile">
        <Field label="Name" name="name" autocomplete="name" required maxlength={80} value={viewer.name} />
        <div class="field">
          <label>Email</label>
          <div>{viewer.email}</div>
        </div>
        <button type="submit">Save</button>
      </form>
    </section>

    <section class="card">
      <h2>Sign-in methods</h2>
      <table>
        <tbody>
          <tr>
            <td>{PROVIDER_TITLES.credential}</td>
            <td class="right">{hasPassword ? <span class="muted">Set</span> : <a href="/forgot-password">Set a password</a>}</td>
          </tr>
          {providers.map(provider => {
            const account = linked.find(a => a.provider === provider);
            return (
            <tr>
              <td>{PROVIDER_TITLES[provider] ?? provider}</td>
              <td class="right">
                {account ? (
                  linked.length + (hasPassword ? 1 : 0) > 1 ? (
                    <form method="post" action="/account/unlink">
                      <input type="hidden" name="account" value={account.id} />
                      <button class="link" type="submit">
                        Unlink
                      </button>
                    </form>
                  ) : (
                    <span class="muted">Linked</span>
                  )
                ) : (
                  <form method="post" action="/account/link">
                    <input type="hidden" name="provider" value={provider} />
                    <button class="link" type="submit">
                      Link
                    </button>
                  </form>
                )}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
      {hasPassword ? (
        <form method="post" action="/account/password" class="mt">
          <h3>Change the password</h3>
          <Field label="Current password" name="current" type="password" autocomplete="current-password" required />
          <Field label="New password" name="password" id="new-password" type="password" autocomplete="new-password" required minlength={10} maxlength={128} hint="Your other devices are signed out." />
          <button type="submit">Change the password</button>
        </form>
      ) : null}
    </section>

    <section class="card" id="two-factor">
      <h2>Two-factor authentication</h2>
      {setup ? (
        <>
          <p>Scan this code with an authenticator app (1Password, Google Authenticator, Authy and others). Then type the 6-digit code that the app shows.</p>
          <div class="qr">{raw(setup.qrSvg)}</div>
          <p class="mt muted">
            <small>
              If you cannot scan the code, type this key in the app: <code>{setup.secret}</code>
            </small>
          </p>
          <h3>Backup codes</h3>
          <p class="muted">Keep these codes in a safe place. Each code signs you in one time if you lose the authenticator app.</p>
          <div class="codes">
            {setup.backupCodes.map(code => (
              <div>{code}</div>
            ))}
          </div>
          <form method="post" action="/account/two-factor/verify">
            <Field label="Code from the app" name="code" id="totp-code" class="code" autocomplete="one-time-code" inputmode="numeric" required maxlength={6} autofocus />
            <button class="primary" type="submit">
              Turn on two-factor
            </button>
          </form>
        </>
      ) : twoFactor ? (
        <>
          <p>
            <span class="badge">On</span> Sign-in with a password also needs a code from your authenticator app.
          </p>
          {hasPassword ? (
            <form method="post" action="/account/two-factor/disable" class="mt">
              <Field label="Password" name="password" id="two-factor-off-password" type="password" autocomplete="current-password" required />
              <button class="danger" type="submit">
                Turn off two-factor
              </button>
            </form>
          ) : null}
        </>
      ) : hasPassword ? (
        <form method="post" action="/account/two-factor/enable">
          <p class="muted">Sign-in with a password then also needs a code from an authenticator app.</p>
          <Field label="Password" name="password" id="two-factor-password" type="password" autocomplete="current-password" required />
          <button type="submit">Set up two-factor</button>
        </form>
      ) : (
        <p class="muted">You sign in with {linked.map(a => PROVIDER_TITLES[a.provider] ?? a.provider).join(" or ")}. Turn on two-factor there. To use two-factor in Opaya, set a password first.</p>
      )}
    </section>

    <section class="card" id="devices">
      <h2>Signed-in devices</h2>
      <table>
        <thead>
          <tr>
            <th>Device</th>
            <th>Last active</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sessions.map(s => (
            <tr>
              <td>
                {s.name} {s.desktop ? <span class="badge">Desktop app</span> : null}
                <div class="muted">
                  <small>{`Signed in ${date(s.createdAt)}${s.ipAddress ? ` from ${s.ipAddress}` : ""}`}</small>
                </div>
              </td>
              <td>{date(s.updatedAt)}</td>
              <td class="right">
                {s.current ? (
                  <span class="muted">This browser</span>
                ) : (
                  <form method="post" action="/account/sessions/revoke">
                    <input type="hidden" name="id" value={s.id} />
                    <button class="link" type="submit">
                      Sign out
                    </button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>

    <section class="card">
      <h2>Delete the account</h2>
      <p class="muted">This deletes your account, your organization and your plan at once. A paid plan ends now, with no refund. You cannot undo this.</p>
      <form method="post" action="/account/delete">
        {hasPassword ? <Field label="Password" name="password" id="delete-password" type="password" autocomplete="current-password" required /> : null}
        <div class="field">
          <label>
            <input type="checkbox" name="confirm" value="yes" /> I understand that this cannot be undone
          </label>
        </div>
        <button class="danger" type="submit">
          Delete my account
        </button>
      </form>
    </section>
  </Layout>
);
