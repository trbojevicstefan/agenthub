// The one source of the plan names, prices, limits and features. The Stripe plugin, the entitlements and the pricing
// page all read this file. Stripe prices are found by lookup key, so the same code works in test mode and live mode
// (web/scripts/stripe-setup.ts creates the prices with these keys).
import type { StripePlan } from "@better-auth/stripe";

export type PlanName = "free" | "pro" | "fleet";
export type Interval = "month" | "year";

export interface Plan {
  name: PlanName;
  title: string;
  summary: string;
  // US dollars. null: no subscription.
  price: Record<Interval, number> | null;
  lookupKeys?: Record<Interval, string>;
  trialDays?: number;
  limits: { hosts: number };
  features: { web: boolean; sync: boolean };
  points: string[];
}

export const PLANS: readonly Plan[] = [
  {
    name: "free",
    title: "Free",
    summary: "The desktop app for one computer and one remote machine.",
    price: null,
    limits: { hosts: 1 },
    features: { web: false, sync: false },
    points: ["All agents on this computer", "1 remote machine", "No account needed"],
  },
  {
    name: "pro",
    title: "Pro",
    summary: "For one person with a few servers.",
    price: { month: 19, year: 180 },
    lookupKeys: { month: "opaya_pro_month", year: "opaya_pro_year" },
    trialDays: 14,
    limits: { hosts: 5 },
    features: { web: true, sync: true },
    points: ["5 remote machines", "The web app at app.opaya.dev", "Sync between desktop and web", "14 days free, no card"],
  },
  {
    name: "fleet",
    title: "Fleet",
    summary: "For many servers and agents.",
    price: { month: 49, year: 468 },
    lookupKeys: { month: "opaya_fleet_month", year: "opaya_fleet_year" },
    limits: { hosts: 20 },
    features: { web: true, sync: true },
    points: ["20 remote machines", "The web app at app.opaya.dev", "Sync between desktop and web"],
  },
];

export const FREE = PLANS[0]!;

export function plan(name: string | null | undefined): Plan {
  return PLANS.find(p => p.name === name) ?? FREE;
}

export const paidPlans = () => PLANS.filter(p => p.price);

export function stripePlans(): StripePlan[] {
  return paidPlans().map(p => ({
    name: p.name,
    lookupKey: p.lookupKeys!.month,
    annualDiscountLookupKey: p.lookupKeys!.year,
    limits: { hosts: p.limits.hosts, web: p.features.web, sync: p.features.sync },
    ...(p.trialDays ? { freeTrial: { days: p.trialDays } } : {}),
  }));
}
