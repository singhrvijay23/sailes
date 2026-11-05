import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pool, query, withTenant } from '../src/db/pool.js';
import { setStripeClient, creditBalance, isEntitled } from '../src/billing/billing.js';
import { setProviderOverride } from '../src/ai/registry.js';
import { HASH_EMBED_MODEL, hashEmbed } from '../src/ai/hashEmbed.js';
import { handleChat } from '../src/agent/orchestrator.js';
import type { ChatProvider } from '../src/ai/types.js';
import { resetDb } from './helpers.js';

const WEBHOOK_SECRET = 'whsec_test_secret';
const real = new Stripe('sk_test_fake');

let app: FastifyInstance;
let token: string;
let storeId: string;
let widgetKey: string;
const calls: Array<[string, any]> = [];
const saved = { ...config.stripe, prices: { ...config.stripe.prices } };
const savedManaged = { ...config.managed };

/** A Stripe stand-in: records API calls, keeps the real webhook signature code. */
const fakeStripe = {
  webhooks: real.webhooks,
  customers: { create: async (p: any) => (calls.push(['customers.create', p]), { id: 'cus_123' }) },
  checkout: { sessions: { create: async (p: any) => (calls.push(['checkout.create', p]), { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' }) } },
  billingPortal: { sessions: { create: async (p: any) => (calls.push(['portal.create', p]), { url: 'https://billing.stripe.test/p' }) } },
  subscriptions: { retrieve: async (id: string) => subscription({ id }) },
} as unknown as Stripe;

function subscription(over: Partial<Record<string, any>> = {}) {
  return {
    id: 'sub_1',
    object: 'subscription',
    customer: 'cus_123',
    status: 'active',
    cancel_at_period_end: false,
    trial_end: null,
    metadata: { tenantId: storeId },
    items: { data: [{ price: { id: 'price_pro_m' }, current_period_end: 1893456000 }] },
    ...over,
  };
}

let n = 0;
async function deliver(type: string, object: any) {
  const payload = JSON.stringify({ id: `evt_${++n}`, object: 'event', type, data: { object } });
  const sig = real.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return app.inject({ method: 'POST', url: '/v1/billing/webhook', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, payload });
}

const auth = () => ({ authorization: `Bearer ${token}` });
const tenant = async () => (await query('SELECT * FROM tenants WHERE id = $1', [storeId])).rows[0];

beforeAll(async () => {
  await resetDb();
  Object.assign(config.stripe, { secretKey: 'sk_test_fake', webhookSecret: WEBHOOK_SECRET });
  Object.assign(config.stripe.prices, { pro_month: 'price_pro_m', starter_month: 'price_starter_m' });
  setStripeClient(fakeStripe);
  app = await buildApp({ logger: false });
  const r = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'bill@shop.test', password: 'password123', storeName: 'Bill Shop' } });
  token = r.json().token;
  storeId = r.json().storeId;
  widgetKey = (await query('SELECT key FROM widget_keys WHERE tenant_id = $1', [storeId])).rows[0].key;
});

beforeEach(() => {
  calls.length = 0;
});

afterAll(async () => {
  Object.assign(config.stripe, saved);
  Object.assign(config.managed, savedManaged);
  setStripeClient(null);
  setProviderOverride(null);
  await app.close();
  await pool.end();
});

describe('billing', () => {
  it('reports trial status and blocks direct plan edits once Stripe is configured', async () => {
    const r = await app.inject({ method: 'GET', url: `/v1/stores/${storeId}/billing`, headers: auth() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ configured: true, plan: 'starter', status: null, entitled: true, credits: { balanceUsd: 0 } });
    const days = (new Date(r.json().trialEndsAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    const p = await app.inject({ method: 'PATCH', url: `/v1/stores/${storeId}`, headers: auth(), payload: { plan: 'pro' } });
    expect(p.statusCode).toBe(400);
  });

  it('creates a subscription checkout that keeps the remaining trial', async () => {
    const r = await app.inject({ method: 'POST', url: `/v1/stores/${storeId}/billing/checkout`, headers: auth(), payload: { plan: 'pro', interval: 'month' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().url).toContain('checkout.stripe.test');
    const create = calls.find((c) => c[0] === 'checkout.create')![1];
    expect(create).toMatchObject({ mode: 'subscription', customer: 'cus_123', client_reference_id: storeId, line_items: [{ price: 'price_pro_m', quantity: 1 }] });
    expect(create.subscription_data.trial_period_days).toBe(14);
    expect(calls.find((c) => c[0] === 'customers.create')![1]).toMatchObject({ email: 'bill@shop.test' });
    expect((await tenant()).stripe_customer_id).toBe('cus_123');
    // Unconfigured prices are a clear error, not a Stripe failure.
    const bad = await app.inject({ method: 'POST', url: `/v1/stores/${storeId}/billing/checkout`, headers: auth(), payload: { plan: 'enterprise', interval: 'year' } });
    expect(bad.json().error).toBe('price_not_configured');
  });

  it('rejects webhooks with a bad signature', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/billing/webhook', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bad' }, payload: '{}' });
    expect(r.statusCode).toBe(400);
  });

  it('applies the subscription from checkout and later updates, once per event', async () => {
    const r = await deliver('checkout.session.completed', { id: 'cs_1', object: 'checkout.session', mode: 'subscription', client_reference_id: storeId, customer: 'cus_123', subscription: 'sub_1', metadata: {} });
    expect(r.statusCode).toBe(200);
    let t = await tenant();
    expect(t).toMatchObject({ plan: 'pro', subscription_status: 'active', stripe_subscription_id: 'sub_1', billing_interval: 'month' });
    expect(new Date(t.current_period_end).getUTCFullYear()).toBe(2030);

    // Second checkout while subscribed is refused (use the portal instead).
    const again = await app.inject({ method: 'POST', url: `/v1/stores/${storeId}/billing/checkout`, headers: auth(), payload: { plan: 'starter' } });
    expect(again.statusCode).toBe(409);
    const portal = await app.inject({ method: 'POST', url: `/v1/stores/${storeId}/billing/portal`, headers: auth() });
    expect(portal.json().url).toContain('billing.stripe.test');

    // Downgrade in the portal.
    await deliver('customer.subscription.updated', subscription({ items: { data: [{ price: { id: 'price_starter_m' }, current_period_end: 1893456000 }] }, cancel_at_period_end: true }));
    t = await tenant();
    expect(t).toMatchObject({ plan: 'starter', cancel_at_period_end: true });

    // A failed renewal keeps service during Stripe's retries.
    await deliver('invoice.payment_failed', { id: 'in_1', object: 'invoice', customer: 'cus_123' });
    t = await tenant();
    expect(t.subscription_status).toBe('past_due');
    expect(isEntitled(t)).toBe(true);
  });

  it('stops the widget when the subscription ends after the trial', async () => {
    await deliver('customer.subscription.deleted', subscription({ status: 'canceled' }));
    let t = await tenant();
    expect(t).toMatchObject({ plan: 'starter', subscription_status: 'canceled', stripe_subscription_id: null });
    // Still inside the free trial: works.
    expect((await app.inject({ method: 'GET', url: '/v1/widget/config', headers: { 'x-sailes-key': widgetKey } })).statusCode).toBe(200);
    await query(`UPDATE tenants SET trial_ends_at = now() - interval '1 day' WHERE id = $1`, [storeId]);
    const cfg = await app.inject({ method: 'GET', url: '/v1/widget/config', headers: { 'x-sailes-key': widgetKey } });
    expect(cfg.statusCode).toBe(402);
    const chat = await app.inject({ method: 'POST', url: '/v1/chat', headers: { 'x-sailes-key': widgetKey }, payload: { message: 'hi' } });
    expect(chat.statusCode).toBe(402);
    // Resubscribing is allowed again, with no trial left.
    const r = await app.inject({ method: 'POST', url: `/v1/stores/${storeId}/billing/checkout`, headers: auth(), payload: { plan: 'pro' } });
    expect(r.statusCode).toBe(200);
    expect(calls.find((c) => c[0] === 'checkout.create')![1].subscription_data.trial_period_days).toBeUndefined();
    t = await tenant();
    expect(isEntitled(t)).toBe(false);
  });
});

describe('SAILES AI credits', () => {
  it('sells a credit pack and credits it exactly once', async () => {
    const r = await app.inject({ method: 'POST', url: `/v1/stores/${storeId}/billing/credits`, headers: auth(), payload: { pack: 'medium' } });
    expect(r.statusCode).toBe(200);
    const create = calls.find((c) => c[0] === 'checkout.create')![1];
    expect(create).toMatchObject({ mode: 'payment', metadata: { kind: 'credits', pack: 'medium' } });
    expect(create.line_items[0].price_data.unit_amount).toBe(5000);

    const session = { id: 'cs_credit_1', object: 'checkout.session', mode: 'payment', payment_status: 'paid', client_reference_id: storeId, customer: 'cus_123', metadata: { kind: 'credits', pack: 'medium' } };
    await deliver('checkout.session.completed', session);
    await deliver('checkout.session.completed', session); // different event id, same session: no double credit
    const b = await app.inject({ method: 'GET', url: `/v1/stores/${storeId}/billing`, headers: auth() });
    expect(b.json().credits.balanceUsd).toBe(55);
  });

  it('charges managed-AI usage at the markup and falls back to keyword mode at zero', async () => {
    await query(`UPDATE tenants SET ai_mode = 'managed', trial_ends_at = now() + interval '1 day' WHERE id = $1`, [storeId]);
    let ran = 0;
    const fake: ChatProvider = {
      id: 'openai',
      model: 'gpt-5-mini',
      embeddingModel: HASH_EMBED_MODEL,
      validate: async () => {},
      embed: async (texts) => ({ vectors: texts.map(hashEmbed), tokens: 0 }),
      runTurn: async (input) => {
        ran++;
        input.onText('Hello!');
        return { text: 'Hello!', usage: { inputTokens: 100_000, outputTokens: 10_000 }, rounds: 1, stopReason: 'done' };
      },
    };
    setProviderOverride(() => fake);
    const emit = () => {};
    // gpt-5-mini: 100k in * $0.25/M + 10k out * $2/M = $0.045, times markup 2 = $0.09
    const out = await handleChat({ tenantId: storeId, message: 'hello', emit });
    expect(out.mode).toBe('ai');
    expect(await withTenant(storeId, creditBalance)).toBeCloseTo(54.91, 4);

    await withTenant(storeId, (db) => db.query(`INSERT INTO credit_ledger (tenant_id, delta_usd, reason) VALUES ($1, -54.91, 'usage')`, [storeId]));
    const broke = await handleChat({ tenantId: storeId, message: 'hello again', emit });
    expect(broke.mode).toBe('fallback');
    expect(ran).toBe(1);
    expect(await withTenant(storeId, creditBalance)).toBeCloseTo(0, 4);
  });
});
