// A Stripe client for tests: the real library (so webhook signatures are real), with the API calls answered here.
import Stripe from "stripe";

export const WEBHOOK_SECRET = "whsec_test_opaya";
const PRICES: Record<string, { id: string; interval: "month" | "year"; amount: number }> = {
  opaya_pro_month: { id: "price_pro_month", interval: "month", amount: 1900 },
  opaya_pro_year: { id: "price_pro_year", interval: "year", amount: 18000 },
  opaya_fleet_month: { id: "price_fleet_month", interval: "month", amount: 4900 },
  opaya_fleet_year: { id: "price_fleet_year", interval: "year", amount: 46800 },
};
const price = (lookupKey: string) => {
  const p = PRICES[lookupKey]!;
  return { id: p.id, object: "price", lookup_key: lookupKey, unit_amount: p.amount, currency: "usd", recurring: { interval: p.interval, usage_type: "licensed" } };
};

export function fakeStripe() {
  const client = new Stripe("sk_test_fake", { maxNetworkRetries: 0 });
  const calls: { method: string; params: any }[] = [];
  const subscriptions = new Map<string, any>();
  let n = 0;
  const record = (method: string, params: any) => calls.push({ method, params });
  const resources = {
    customers: {
      search: async () => ({ data: [] }),
      list: async () => ({ data: [] }),
      create: async (params: any) => (record("customers.create", params), { id: `cus_${++n}`, object: "customer", ...params }),
      retrieve: async (id: string) => ({ id, object: "customer", name: "", deleted: false }),
      update: async (id: string, params: any) => (record("customers.update", { id, ...params }), { id }),
      del: async (id: string) => (record("customers.del", { id }), { id, deleted: true }),
    },
    prices: {
      list: async ({ lookup_keys }: { lookup_keys: string[] }) => ({ data: lookup_keys.filter(k => PRICES[k]).map(price) }),
      retrieve: async (id: string) => price(Object.keys(PRICES).find(k => PRICES[k]!.id === id)!),
    },
    checkout: { sessions: { create: async (params: any) => (record("checkout.sessions.create", params), { id: `cs_${++n}`, url: `https://checkout.stripe.com/c/pay/cs_${n}` }) } },
    billingPortal: { sessions: { create: async (params: any) => (record("billingPortal.sessions.create", params), { url: "https://billing.stripe.com/p/session/test" }) } },
    subscriptions: {
      list: async ({ customer }: { customer: string }) => ({ data: [...subscriptions.values()].filter(s => s.customer === customer && ["active", "trialing"].includes(s.status)) }),
      retrieve: async (id: string) => subscriptions.get(id),
      update: async (id: string, params: any) => (record("subscriptions.update", { id, ...params }), subscriptions.get(id)),
      cancel: async (id: string) => (record("subscriptions.cancel", { id }), { ...subscriptions.get(id), status: "canceled" }),
    },
  };
  for (const [name, value] of Object.entries(resources)) Object.assign((client as any)[name], value);
  Object.assign((client as any).checkout.sessions, resources.checkout.sessions);
  Object.assign((client as any).billingPortal.sessions, resources.billingPortal.sessions);

  // A Stripe subscription as Checkout makes it, and the signed webhook event Stripe sends about it.
  function subscription({ id, customer, lookupKey, status, trialDays = 0, metadata }: { id: string; customer: string; lookupKey: string; status: string; trialDays?: number; metadata: Record<string, string> }) {
    const now = Math.floor(Date.now() / 1000);
    const end = now + (trialDays || 30) * 86400;
    const sub = {
      id,
      object: "subscription",
      customer,
      status,
      metadata,
      cancel_at_period_end: false,
      cancel_at: null,
      canceled_at: null,
      ended_at: null,
      trial_start: trialDays ? now : null,
      trial_end: trialDays ? end : null,
      items: { data: [{ id: `si_${id}`, quantity: 1, price: price(lookupKey), current_period_start: now, current_period_end: end }] },
    };
    subscriptions.set(id, sub);
    return sub;
  }
  function event(type: string, object: unknown) {
    const payload = JSON.stringify({ id: `evt_${++n}`, object: "event", type, data: { object } });
    const signature = client.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    return { payload, signature };
  }
  return { client, calls, subscriptions, subscription, event };
}
