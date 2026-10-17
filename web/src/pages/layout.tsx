import type { Child, FC, PropsWithChildren } from "hono/jsx";

export interface Viewer {
  email: string;
  name: string;
}

export const Layout: FC<PropsWithChildren<{ title: string; viewer?: Viewer | null; narrow?: boolean; current?: string }>> = ({ title, viewer, narrow, current, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="referrer" content="strict-origin-when-cross-origin" />
      <title>{`${title} · Opaya`}</title>
      <link rel="icon" href="/assets/opaya-logo.png" />
      <link rel="stylesheet" href="/assets/site.css" />
    </head>
    <body>
      <header class="top">
        <a class="brand" href="/">
          <img src="/assets/opaya-logo.png" alt="" />
          Opaya
        </a>
        <nav>
          <a href="/pricing" aria-current={current === "pricing" ? "page" : undefined}>
            Pricing
          </a>
          {viewer ? (
            <>
              <a href="/billing" aria-current={current === "billing" ? "page" : undefined}>
                Billing
              </a>
              <a href="/account" aria-current={current === "account" ? "page" : undefined}>
                Account
              </a>
              <form method="post" action="/logout">
                <button class="link" type="submit">
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <>
              <a href="/login" aria-current={current === "login" ? "page" : undefined}>
                Sign in
              </a>
              <a class="button primary" href="/signup">
                Create account
              </a>
            </>
          )}
        </nav>
      </header>
      <main class={narrow ? "narrow" : undefined}>{children}</main>
      <footer>
        Opaya · <a href="https://opaya.dev">opaya.dev</a> · <a href="https://opaya.dev/privacy">Privacy</a> · <a href="https://opaya.dev/terms">Terms</a>
      </footer>
    </body>
  </html>
);

export const Notice: FC<PropsWithChildren<{ kind?: "error" | "ok" | "info" }>> = ({ kind = "info", children }) => (
  <div class={`notice ${kind}`} role={kind === "error" ? "alert" : "status"}>
    {children}
  </div>
);

export const Field: FC<{ label: string; name: string; id?: string; type?: string; value?: string; autocomplete?: string; required?: boolean; hint?: Child; minlength?: number; maxlength?: number; autofocus?: boolean; class?: string; inputmode?: "numeric" | "text" | "email"; pattern?: string }> = ({ label, name, id = name, type = "text", hint, ...input }) => (
  <div class="field">
    <label for={id}>{label}</label>
    <input id={id} name={name} type={type} {...input} />
    {hint ? <small>{hint}</small> : null}
  </div>
);

export const Errors: FC<{ error?: string | null; ok?: string | null }> = ({ error, ok }) => (
  <>
    {error ? <Notice kind="error">{error}</Notice> : null}
    {ok ? <Notice kind="ok">{ok}</Notice> : null}
  </>
);

export const PROVIDER_TITLES: Record<string, string> = { github: "GitHub", google: "Google", credential: "Email and password" };

export const SocialButtons: FC<{ providers: string[]; next: string; verb: string }> = ({ providers, next, verb }) =>
  providers.length ? (
    <div class="social">
      {providers.map(provider => (
        <form method="post" action="/login/social">
          <input type="hidden" name="provider" value={provider} />
          <input type="hidden" name="next" value={next} />
          <button class="wide" type="submit">
            {`${verb} with ${PROVIDER_TITLES[provider] ?? provider}`}
          </button>
        </form>
      ))}
      <div class="or">or</div>
    </div>
  ) : null;

export const date = (value: Date | string | number | null | undefined) =>
  value ? new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "";
