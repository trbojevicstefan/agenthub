import type { FC } from "hono/jsx";
import { Errors, Field, Layout, Notice, SocialButtons } from "./layout.js";

const nextQuery = (next: string) => (next && next !== "/billing" ? `?next=${encodeURIComponent(next)}` : "");

export const SignUpPage: FC<{ providers: string[]; next: string; error?: string; values?: { name?: string; email?: string } }> = ({ providers, next, error, values = {} }) => (
  <Layout title="Create your account" narrow>
    <h1>Create your Opaya account</h1>
    <p class="muted">The account works in the web app and in the desktop app. Pro is free for 14 days, with no card.</p>
    <div class="card">
      <Errors error={error} />
      <SocialButtons providers={providers} next={next} verb="Sign up" />
      <form method="post" action="/signup">
        <input type="hidden" name="next" value={next} />
        <Field label="Name" name="name" autocomplete="name" required maxlength={80} value={values.name} />
        <Field label="Email" name="email" type="email" autocomplete="email" required value={values.email} />
        <Field label="Password" name="password" type="password" autocomplete="new-password" required minlength={10} maxlength={128} hint="10 characters or more." />
        <button class="primary wide" type="submit">
          Create account
        </button>
      </form>
    </div>
    <p class="muted">
      Do you have an account? <a href={`/login${nextQuery(next)}`}>Sign in</a>
    </p>
  </Layout>
);

export const CheckEmailPage: FC<{ email: string }> = ({ email }) => (
  <Layout title="Confirm your email" narrow>
    <h1>Confirm your email</h1>
    <div class="card">
      <p>
        We sent a link to <strong>{email}</strong>. Open the link to finish your account.
      </p>
      <p class="muted">The link is valid for 24 hours. If you do not see the email, look in the spam folder.</p>
    </div>
  </Layout>
);

const LOGIN_NOTICES: Record<string, string> = {
  reset: "Your password is changed. Sign in with the new password.",
  deleted: "Your account is deleted.",
  "signed-out": "You are signed out.",
};
const LOGIN_ERRORS: Record<string, string> = {
  social: "The sign-in with that provider did not finish. Try again.",
  expired: "The link is not valid any more. Ask for a new link.",
  account_not_linked: "An account with this email exists already. Sign in with your password first, then link the provider in Account.",
};
export const loginNotice = (query: Record<string, string | undefined>) => ({
  ok: (query.notice && LOGIN_NOTICES[query.notice]) || undefined,
  error: query.error ? LOGIN_ERRORS[query.error] ?? LOGIN_ERRORS.social : undefined,
});

export const LoginPage: FC<{ providers: string[]; next: string; error?: string; ok?: string; email?: string }> = ({ providers, next, error, ok, email }) => (
  <Layout title="Sign in" narrow current="login">
    <h1>Sign in to Opaya</h1>
    {next.startsWith("/device") ? <p class="muted">Sign in to connect your desktop app.</p> : null}
    <div class="card">
      <Errors error={error} ok={ok} />
      <SocialButtons providers={providers} next={next} verb="Sign in" />
      <form method="post" action="/login">
        <input type="hidden" name="next" value={next} />
        <Field label="Email" name="email" type="email" autocomplete="email" required value={email} />
        <Field label="Password" name="password" type="password" autocomplete="current-password" required />
        <button class="primary wide" type="submit">
          Sign in
        </button>
      </form>
      <p class="mt">
        <a href="/forgot-password">Forgot your password?</a>
      </p>
    </div>
    <p class="muted">
      New to Opaya? <a href={`/signup${nextQuery(next)}`}>Create an account</a>
    </p>
  </Layout>
);

export const TwoFactorPage: FC<{ next: string; error?: string }> = ({ next, error }) => (
  <Layout title="Two-factor code" narrow>
    <h1>Enter your code</h1>
    <p class="muted">Open your authenticator app and type the 6-digit code for Opaya.</p>
    <div class="card">
      <Errors error={error} />
      <form method="post" action="/login/two-factor">
        <input type="hidden" name="next" value={next} />
        <Field label="Code" name="code" class="code" autocomplete="one-time-code" inputmode="numeric" required autofocus maxlength={20} hint="You can also type one of your backup codes." />
        <div class="field">
          <label>
            <input type="checkbox" name="trust" value="1" /> Do not ask again on this computer for 30 days
          </label>
        </div>
        <button class="primary wide" type="submit">
          Continue
        </button>
      </form>
    </div>
  </Layout>
);

export const ForgotPage: FC<{ sent?: boolean; error?: string }> = ({ sent, error }) => (
  <Layout title="Reset your password" narrow>
    <h1>Reset your password</h1>
    <div class="card">
      <Errors error={error} />
      {sent ? (
        <Notice kind="ok">If an account has this email, we sent it a link. The link is valid for 1 hour.</Notice>
      ) : (
        <form method="post" action="/forgot-password">
          <p class="muted">Type your email. We send you a link to set a new password. Use this also to set a first password for an account that uses GitHub or Google.</p>
          <Field label="Email" name="email" type="email" autocomplete="email" required />
          <button class="primary wide" type="submit">
            Send the link
          </button>
        </form>
      )}
    </div>
  </Layout>
);

export const ResetPage: FC<{ token: string; error?: string }> = ({ token, error }) => (
  <Layout title="Set a new password" narrow>
    <h1>Set a new password</h1>
    <div class="card">
      <Errors error={error} />
      {token ? (
        <form method="post" action="/reset-password">
          <input type="hidden" name="token" value={token} />
          <Field label="New password" name="password" type="password" autocomplete="new-password" required minlength={10} maxlength={128} hint="10 characters or more. All your devices are signed out." />
          <button class="primary wide" type="submit">
            Save the password
          </button>
        </form>
      ) : (
        <p>
          The link is not valid any more. <a href="/forgot-password">Ask for a new link</a>.
        </p>
      )}
    </div>
  </Layout>
);
