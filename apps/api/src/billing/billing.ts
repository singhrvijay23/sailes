import Stripe from 'stripe';
import { config } from '../config.js';
import { query, withTenant, type Db } from '../db/pool.js';
import type { PlanId } from '../lib/plans.js';

/** Prepaid SAILES AI credit packs (USD of AI usage at our marked-up rate). Sold with ad-hoc Checkout prices. */
export const CREDIT_PACKS = {
  small: { id: 'small', name: 'Starter pack', priceUsd: 20, creditUsd: 20 },
  medium: { id: 'medium', name: 'Growth pack', priceUsd: 50, creditUsd: 55 },
  large: { id: 'large', name: 'Scale pack', priceUsd: 100, creditUsd: 120 },
} as const;
export type CreditPackId = keyof typeof CREDIT_PACKS;

export const TRIAL_DAYS = 14;

let client: Stripe | null = null;
export function stripe(): Stripe | null {
  if (!config.stripe.secretKey) return null;
  client ??= new Stripe(config.stripe.secretKey, { maxNetworkRetries: 2 });
  return client;
}
export function setStripeClient(s: Stripe | null) {
  client = s;
}

export function priceFor(plan: PlanId, interval: 'month' | 'year') {
  return config.stripe.prices[`${plan}_${interval}`] || null;
}

export function planForPrice(priceId: string): { plan: PlanId; interval: 'month' | 'year' } | null {
  for (const [k, v] of Object.entries(config.stripe.prices)) {
    if (v && v === priceId) {
      const [plan, interval] = k.split('_') as [PlanId, 'month' | 'year'];
      return { plan, interval };
    }
  }
  return null;
}

/**
 * Whether the store's subscription currently entitles it to service. A store is active while in its
 * free trial or with a subscription Stripe still considers live. past_due keeps working during
 * Stripe's retry window so a failed card never breaks the store immediately.
 */
export function isEntitled(t: { trial_ends_at: Date | string | null; subscription_status: string | null }, now = new Date()) {
  if (t.subscription_status && ['active', 'trialing', 'past_due'].includes(t.subscription_status)) return true;
  if (t.trial_ends_at && new Date(t.trial_ends_at) > now) return true;
  // Billing not configured (development / self-hosted): everyone is entitled.
  return !config.stripe.secretKey;
}

// ---------------------------------------------------------------- credits

export async function creditBalance(db: Db): Promise<number> {
  const { rows } = await db.query<{ b: string | null }>('SELECT coalesce(sum(delta_usd), 0) AS b FROM credit_ledger');
  return Number(rows[0]?.b ?? 0);
}

export async function addCredits(tenantId: string, usd: number, reason: 'purchase' | 'grant' | 'refund', stripeSessionId?: string) {
  return withTenant(tenantId, async (db) => {
    const r = await db.query(
      `INSERT INTO credit_ledger (tenant_id, delta_usd, reason, stripe_session_id) VALUES ($1, $2, $3, $4) ON CONFLICT (stripe_session_id) DO NOTHING RETURNING id`,
      [tenantId, usd, reason, stripeSessionId ?? null],
    );
    return (r.rowCount ?? 0) > 0;
  });
}

/** Deduct managed-AI usage. Charged at estimated provider cost times the markup. */
export async function chargeCredits(db: Db, tenantId: string, providerCostUsd: number, conversationId: string) {
  const charge = Math.round(providerCostUsd * config.creditMarkup * 10000) / 10000;
  if (charge <= 0) return 0;
  await db.query(`INSERT INTO credit_ledger (tenant_id, delta_usd, reason, conversation_id) VALUES ($1, $2, 'usage', $3)`, [tenantId, -charge, conversationId]);
  return charge;
}

// ---------------------------------------------------------------- webhooks

function subscriptionPeriodEnd(sub: Stripe.Subscription): Date | null {
  const end = sub.items?.data?.[0]?.current_period_end ?? (sub as any).current_period_end;
  return end ? new Date(end * 1000) : null;
}

async function tenantForCustomer(customerId: string, fallbackTenantId?: string | null) {
  const row = (await query('SELECT id FROM tenants WHERE stripe_customer_id = $1', [customerId])).rows[0];
  return (row?.id as string | undefined) ?? fallbackTenantId ?? null;
}

export async function applySubscription(sub: Stripe.Subscription, tenantHint?: string | null) {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const tenantId = await tenantForCustomer(customerId, tenantHint ?? (sub.metadata?.tenantId || null));
  if (!tenantId) return;
  const priceId = sub.items.data[0]?.price.id ?? '';
  const mapped = planForPrice(priceId);
  const ended = ['canceled', 'incomplete_expired'].includes(sub.status);
  await query(
    `UPDATE tenants SET stripe_customer_id = $2, stripe_subscription_id = $3, subscription_status = $4,
            plan = coalesce($5, plan), billing_interval = coalesce($6, billing_interval), current_period_end = $7,
            cancel_at_period_end = $8, trial_ends_at = CASE WHEN $9::timestamptz IS NOT NULL THEN $9 ELSE trial_ends_at END
     WHERE id = $1`,
    [
      tenantId,
      customerId,
      ended ? null : sub.id,
      sub.status,
      ended ? 'starter' : (mapped?.plan ?? null),
      mapped?.interval ?? null,
      subscriptionPeriodEnd(sub),
      sub.cancel_at_period_end ?? false,
      sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    ],
  );
}

/** Applies one verified Stripe event. Returns false if it was already processed. */
export async function handleStripeEvent(event: Stripe.Event): Promise<boolean> {
  const fresh = await query('INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING', [event.id, event.type]);
  if (!fresh.rowCount) return false;
  try {
    await applyEvent(event);
  } catch (e) {
    // Let Stripe's retry apply it again.
    await query('DELETE FROM stripe_events WHERE id = $1', [event.id]);
    throw e;
  }
  return true;
}

async function applyEvent(event: Stripe.Event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object as Stripe.Checkout.Session;
      const tenantId = s.client_reference_id ?? s.metadata?.tenantId ?? null;
      if (!tenantId) break;
      const customerId = typeof s.customer === 'string' ? s.customer : s.customer?.id;
      if (customerId) await query('UPDATE tenants SET stripe_customer_id = coalesce(stripe_customer_id, $2) WHERE id = $1', [tenantId, customerId]);
      if (s.mode === 'payment' && s.metadata?.kind === 'credits' && s.payment_status === 'paid') {
        const pack = CREDIT_PACKS[s.metadata.pack as CreditPackId];
        if (pack) await addCredits(tenantId, pack.creditUsd, 'purchase', s.id);
      }
      if (s.mode === 'subscription' && s.subscription) {
        const st = stripe();
        const sub = typeof s.subscription === 'string' ? (st ? await st.subscriptions.retrieve(s.subscription) : null) : s.subscription;
        if (sub) await applySubscription(sub, tenantId);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await applySubscription(event.data.object as Stripe.Subscription);
      break;
    case 'invoice.payment_failed': {
      const inv = event.data.object as Stripe.Invoice;
      const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
      if (customerId) await query(`UPDATE tenants SET subscription_status = 'past_due' WHERE stripe_customer_id = $1 AND subscription_status = 'active'`, [customerId]);
      break;
    }
    default:
      break;
  }
}
