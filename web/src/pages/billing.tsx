import type { FC } from "hono/jsx";
import type { PlanState } from "../plan-state.js";
import { PLANS, type Plan } from "../plans.js";
import { date, Errors, Layout, Notice, type Viewer } from "./layout.js";

const money = (amount: number, currency = "usd") => new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: amount % 1 ? 2 : 0 }).format(amount);

const CheckoutButtons: FC<{ plan: Plan; trial: boolean; change?: boolean }> = ({ plan, trial, change }) => (
  <div class="stack">
    {(["month", "year"] as const).map(interval => (
      <form method="post" action="/billing/checkout">
        <input type="hidden" name="plan" value={plan.name} />
        <input type="hidden" name="interval" value={interval} />
        <button class={`wide ${interval === "month" ? "primary" : ""}`} type="submit">
          {change
            ? `Change to ${plan.title}: ${money(plan.price![interval])}/${interval}`
            : trial
              ? `Start the 14-day trial, then ${money(plan.price![interval])}/${interval}`
              : `Buy ${plan.title} for ${money(plan.price![interval])}/${interval}`}
        </button>
      </form>
    ))}
  </div>
);

export const PricingPage: FC<{ viewer: Viewer | null; state: PlanState | null; error?: string }> = ({ viewer, state, error }) => (
  <Layout title="Pricing" viewer={viewer} current="pricing">
    <h1>Plans</h1>
    <p class="muted">The desktop app is free. A plan adds remote machines, the web app and sync. Prices are in US dollars.</p>
    <Errors error={error} />
    <div class="grid">
      {PLANS.map(plan => {
        const current = state ? state.plan.name === plan.name : plan.name === "free" && Boolean(viewer);
        return (
          <section class={`card plan ${current ? "current" : ""}`}>
            <h2>
              {plan.title} {current ? <span class="badge">Your plan</span> : null}
            </h2>
            <p class="muted">{plan.summary}</p>
            <div class="price">
              {plan.price ? (
                <>
                  {money(plan.price.month)}
                  <span> / month</span>
                </>
              ) : (
                <>
                  $0<span> / always</span>
                </>
              )}
            </div>
            {plan.price ? <small class="muted">{`or ${money(plan.price.year)} / year (${Math.round(100 - (plan.price.year / (plan.price.month * 12)) * 100)}% less)`}</small> : <small class="muted">No account needed</small>}
            <ul>
              {plan.points.map(point => (
                <li>{point}</li>
              ))}
            </ul>
            {!plan.price ? (
              <a class="button wide" href="https://opaya.dev/download">
                Download the desktop app
              </a>
            ) : current ? (
              <a class="button wide" href="/billing">
                Manage your plan
              </a>
            ) : viewer ? (
              <CheckoutButtons plan={plan} trial={Boolean(plan.trialDays) && !state?.hadTrial} change={Boolean(state?.plan.price)} />
            ) : (
              <a class="button primary wide" href={`/signup?next=${encodeURIComponent("/pricing")}`}>
                {plan.trialDays ? "Start the free trial" : `Get ${plan.title}`}
              </a>
            )}
          </section>
        );
      })}
    </div>
    <p class="muted">Do you have a promotion code? Type it on the checkout page. Teams with shared agents come later.</p>
  </Layout>
);

const STATUS_TEXT: Record<PlanState["status"], string> = { free: "Free", trialing: "Trial", active: "Active", past_due: "Payment failed" };

export interface Invoice {
  amount: number;
  currency: string;
  date: Date | null;
}

export const BillingPage: FC<{ viewer: Viewer; state: PlanState; invoice: Invoice | null; notice?: string; error?: string }> = ({ viewer, state, invoice, notice, error }) => {
  const { plan } = state;
  return (
    <Layout title="Billing" viewer={viewer} current="billing">
      <h1>Billing</h1>
      <Errors error={error} ok={notice} />
      {state.status === "past_due" ? <Notice kind="error">The last payment failed. Update your card in Manage billing to keep your plan.</Notice> : null}
      <div class="grid">
        <section class="card">
          <h2>
            {plan.title} {state.status === "free" ? null : <span class="badge">{STATUS_TEXT[state.status]}</span>}
          </h2>
          <dl>
            {state.status === "trialing" && state.trialEnd ? (
              <>
                <dt>Trial ends</dt>
                <dd>{date(state.trialEnd)}</dd>
              </>
            ) : null}
            {state.interval && plan.price ? (
              <>
                <dt>Price</dt>
                <dd>{`${money(plan.price[state.interval])} / ${state.interval}`}</dd>
              </>
            ) : null}
            {state.cancelAtPeriodEnd && state.periodEnd ? (
              <>
                <dt>Ends</dt>
                <dd>{`${date(state.periodEnd)}. Then the plan is Free.`}</dd>
              </>
            ) : invoice ? (
              <>
                <dt>Next invoice</dt>
                <dd>{`${money(invoice.amount, invoice.currency)}${invoice.date ? ` on ${date(invoice.date)}` : ""}`}</dd>
              </>
            ) : null}
          </dl>
          {state.status === "trialing" && !invoice ? <p class="mt muted">Add a card in Manage billing to keep Pro after the trial. Without a card, the plan goes back to Free.</p> : null}
          <div class="row mt">
            {state.stripeCustomerId ? (
              <form method="post" action="/billing/portal">
                <button class="primary" type="submit">
                  Manage billing
                </button>
              </form>
            ) : null}
            {plan.name === "free" ? (
              <a class="button primary" href="/pricing">
                Upgrade
              </a>
            ) : (
              <a class="button" href="/pricing">
                Compare plans
              </a>
            )}
          </div>
        </section>
        <section class="card">
          <h2>Limits</h2>
          <dl>
            <dt>Remote machines</dt>
            <dd>{plan.limits.hosts}</dd>
            <dt>Web app</dt>
            <dd>{plan.features.web ? "Yes" : "No"}</dd>
            <dt>Desktop and web sync</dt>
            <dd>{plan.features.sync ? "Yes" : "No"}</dd>
          </dl>
          <p class="mt muted">
            <small>The desktop app gets these limits when it is signed in. Machines that are already saved keep working above the limit.</small>
          </p>
        </section>
      </div>
      <p class="muted">Manage billing opens Stripe. There you can change the plan, change the card, see invoices and cancel.</p>
    </Layout>
  );
};
