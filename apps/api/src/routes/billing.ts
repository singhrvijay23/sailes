import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, withTenant } from '../db/pool.js';
import { config } from '../config.js';
import { requireStore } from '../auth.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { PLANS } from '../lib/plans.js';
import { CREDIT_PACKS, TRIAL_DAYS, creditBalance, handleStripeEvent, isEntitled, priceFor, stripe, type CreditPackId } from '../billing/billing.js';

const Checkout = z.object({ plan: z.enum(['starter', 'pro', 'enterprise']), interval: z.enum(['month', 'year']).default('month') });
const Credits = z.object({ pack: z.enum(Object.keys(CREDIT_PACKS) as [CreditPackId, ...CreditPackId[]]) });

function requireStripe() {
  const s = stripe();
  if (!s) throw badRequest('Billing is not configured on this server', 'billing_not_configured');
  return s;
}

async function ensureCustomer(tenantId: string, userId: string | null) {
  const s = requireStripe();
  const t = (await query('SELECT name, stripe_customer_id FROM tenants WHERE id = $1', [tenantId])).rows[0];
  if (t.stripe_customer_id) return t.stripe_customer_id as string;
  const email = userId ? (await query('SELECT email FROM users WHERE id = $1', [userId])).rows[0]?.email : undefined;
  const customer = await s.customers.create({ name: t.name, email, metadata: { tenantId } }, { idempotencyKey: `customer-${tenantId}` });
  await query('UPDATE tenants SET stripe_customer_id = coalesce(stripe_customer_id, $2) WHERE id = $1', [tenantId, customer.id]);
  return customer.id;
}

const consoleUrl = (p: string) => `${config.consoleOrigin}${p}`;

export async function billingRoutes(app: FastifyInstance) {
  app.get('/v1/stores/:storeId/billing', { preHandler: requireStore() }, async (req) => {
    const { tenantId } = req.store!;
    const t = (
      await query(
        `SELECT plan, billing_interval, subscription_status, trial_ends_at, current_period_end, cancel_at_period_end, ai_mode, stripe_customer_id
         FROM tenants WHERE id = $1`,
        [tenantId],
      )
    ).rows[0];
    const { balance, ledger } = await withTenant(tenantId, async (db) => ({
      balance: await creditBalance(db),
      ledger: (await db.query(`SELECT delta_usd::float AS delta_usd, reason, created_at FROM credit_ledger WHERE reason <> 'usage' ORDER BY id DESC LIMIT 20`)).rows,
    }));
    return {
      configured: Boolean(config.stripe.secretKey),
      planSwitchAllowed: !config.stripe.secretKey && (!config.isProd || config.allowPlanSwitch),
      plan: t.plan,
      interval: t.billing_interval,
      status: t.subscription_status,
      trialEndsAt: t.trial_ends_at,
      currentPeriodEnd: t.current_period_end,
      cancelAtPeriodEnd: t.cancel_at_period_end,
      entitled: isEntitled(t),
      hasCustomer: Boolean(t.stripe_customer_id),
      plans: Object.values(PLANS),
      credits: {
        balanceUsd: Math.round(balance * 100) / 100,
        managedAvailable: Boolean(config.managed.apiKey),
        inUse: t.ai_mode === 'managed',
        packs: Object.values(CREDIT_PACKS),
        purchases: ledger,
      },
    };
  });

  /** Starts (or changes, via a new Checkout) the store's subscription. New subscriptions keep the remaining free trial. */
  app.post('/v1/stores/:storeId/billing/checkout', { preHandler: requireStore(['owner', 'admin']) }, async (req) => {
    const { tenantId, userId } = req.store!;
    const body = Checkout.parse(req.body);
    const s = requireStripe();
    const price = priceFor(body.plan, body.interval);
    if (!price) throw badRequest(`No Stripe price is configured for ${body.plan} (${body.interval})`, 'price_not_configured');
    const t = (await query('SELECT stripe_subscription_id, subscription_status, trial_ends_at FROM tenants WHERE id = $1', [tenantId])).rows[0];
    if (t.stripe_subscription_id && t.subscription_status !== 'canceled') {
      throw new HttpError(409, 'This store already has a subscription. Use "Manage billing" to change plan or payment method.', 'has_subscription');
    }
    const customer = await ensureCustomer(tenantId, userId);
    // Remaining trial days carry over; Stripe needs at least 2 days of trial to apply one.
    const trialLeftDays = t.trial_ends_at ? Math.ceil((new Date(t.trial_ends_at).getTime() - Date.now()) / 86_400_000) : 0;
    const trialDays = Math.min(TRIAL_DAYS, trialLeftDays);
    const session = await s.checkout.sessions.create({
      mode: 'subscription',
      customer,
      client_reference_id: tenantId,
      line_items: [{ price, quantity: 1 }],
      subscription_data: { metadata: { tenantId }, ...(trialDays >= 2 ? { trial_period_days: trialDays } : {}) },
      metadata: { tenantId, kind: 'subscription' },
      allow_promotion_codes: true,
      success_url: consoleUrl('/billing?checkout=success'),
      cancel_url: consoleUrl('/billing?checkout=cancel'),
    });
    return { url: session.url };
  });

  /** Stripe's hosted portal: change plan, update card, see invoices, cancel. */
  app.post('/v1/stores/:storeId/billing/portal', { preHandler: requireStore(['owner', 'admin']) }, async (req) => {
    const { tenantId, userId } = req.store!;
    const s = requireStripe();
    const customer = await ensureCustomer(tenantId, userId);
    const session = await s.billingPortal.sessions.create({ customer, return_url: consoleUrl('/billing') });
    return { url: session.url };
  });

  /** Buy a SAILES AI credit pack (one-time payment). Credits are added by the webhook once Stripe confirms payment. */
  app.post('/v1/stores/:storeId/billing/credits', { preHandler: requireStore(['owner', 'admin']) }, async (req) => {
    const { tenantId, userId } = req.store!;
    const { pack: packId } = Credits.parse(req.body);
    const pack = CREDIT_PACKS[packId];
    const s = requireStripe();
    const customer = await ensureCustomer(tenantId, userId);
    const session = await s.checkout.sessions.create({
      mode: 'payment',
      customer,
      client_reference_id: tenantId,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: pack.priceUsd * 100,
            product_data: { name: `SAILES AI credits: ${pack.name}`, description: `$${pack.creditUsd} of SAILES AI usage` },
          },
        },
      ],
      metadata: { tenantId, kind: 'credits', pack: pack.id },
      payment_intent_data: { metadata: { tenantId, kind: 'credits', pack: pack.id } },
      success_url: consoleUrl('/billing?credits=success'),
      cancel_url: consoleUrl('/billing?credits=cancel'),
    });
    return { url: session.url };
  });

  // Webhook: needs the raw body for signature verification, so it lives in its own encapsulated plugin.
  await app.register(async (hook) => {
    hook.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    hook.post('/v1/billing/webhook', async (req, reply) => {
      const s = stripe();
      if (!s || !config.stripe.webhookSecret) return reply.status(404).send({ error: 'billing_not_configured' });
      const sig = req.headers['stripe-signature'];
      if (typeof sig !== 'string' || !Buffer.isBuffer(req.body)) return reply.status(400).send({ error: 'bad_signature' });
      let event;
      try {
        event = s.webhooks.constructEvent(req.body, sig, config.stripe.webhookSecret);
      } catch {
        return reply.status(400).send({ error: 'bad_signature' });
      }
      const applied = await handleStripeEvent(event);
      return { received: true, duplicate: !applied };
    });
  });
}
