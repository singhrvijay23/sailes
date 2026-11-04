export type PlanId = 'starter' | 'pro' | 'enterprise';

export interface Plan {
  id: PlanId;
  name: string;
  priceMonthlyUsd: number;
  priceAnnualUsd: number;
  conversationsPerMonth: number;
  productsIndexed: number;
  upsellRules: boolean;
  analytics: 'basic' | 'advanced' | 'advanced_export';
  seats: number;
  multiStore: boolean;
}

/** Tiers and limits confirmed on 2026-11-04 (project plan, "Subscription and billing"). */
export const PLANS: Record<PlanId, Plan> = {
  starter: { id: 'starter', name: 'Starter', priceMonthlyUsd: 99, priceAnnualUsd: 990, conversationsPerMonth: 2000, productsIndexed: 2000, upsellRules: false, analytics: 'basic', seats: 1, multiStore: false },
  pro: { id: 'pro', name: 'Pro', priceMonthlyUsd: 199, priceAnnualUsd: 1990, conversationsPerMonth: 10000, productsIndexed: 20000, upsellRules: true, analytics: 'advanced', seats: 3, multiStore: false },
  enterprise: { id: 'enterprise', name: 'Enterprise', priceMonthlyUsd: 399, priceAnnualUsd: 3990, conversationsPerMonth: 50000, productsIndexed: 100000, upsellRules: true, analytics: 'advanced_export', seats: 10, multiStore: true },
};

export function planFor(id: string): Plan {
  return PLANS[id as PlanId] ?? PLANS.starter;
}
