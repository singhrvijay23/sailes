import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, query, withTenant } from '../db/pool.js';
import { hashPassword, randomToken, verifyPassword } from '../lib/password.js';
import { conflict, unauthorized, badRequest } from '../lib/errors.js';
import { PLANS, planFor } from '../lib/plans.js';
import { hashApiKey, requireStore, requireUser } from '../auth.js';
import { catalogStats } from '../catalog/service.js';
import { monthUsage } from '../usage/usage.js';
import { config } from '../config.js';
import { TRIAL_DAYS } from '../billing/billing.js';

const Signup = z.object({
  email: z.string().email().max(200).transform((s) => s.toLowerCase().trim()),
  password: z.string().min(8).max(200),
  name: z.string().max(120).optional(),
  storeName: z.string().min(1).max(120),
  siteUrl: z.string().url().max(300).optional(),
  platform: z.enum(['custom', 'woocommerce', 'shopify', 'wix', 'webflow']).default('custom'),
});

const Login = z.object({ email: z.string().email().transform((s) => s.toLowerCase().trim()), password: z.string() });

const Settings = z
  .object({
    assistantName: z.string().max(60),
    tone: z.enum(['friendly', 'professional', 'playful', 'luxury']),
    greeting: z.string().max(300),
    storeDescription: z.string().max(300),
    extraInstructions: z.string().max(1500),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    logoUrl: z.string().url().max(500).or(z.literal('')),
    placement: z.enum(['bottom-right', 'bottom-left', 'inline']),
    transcriptRetentionDays: z.number().int().min(1).max(365),
    /** Starter prompts shown as chips when the chat opens. */
    suggestions: z.array(z.string().min(1).max(60)).max(4),
  })
  .partial();

const StorePatch = z.object({
  name: z.string().min(1).max(120).optional(),
  siteUrl: z.string().url().max(300).nullable().optional(),
  settings: Settings.optional(),
  monthlyBudgetUsd: z.number().min(0).max(100000).optional(),
  // Plan changes come from billing (Stripe) in production; allowed directly in development for testing.
  plan: z.enum(['starter', 'pro', 'enterprise']).optional(),
});

function originOf(url?: string | null) {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

export async function accountRoutes(app: FastifyInstance) {
  app.post('/v1/auth/signup', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req) => {
    const body = Signup.parse(req.body);
    if ((await query('SELECT 1 FROM users WHERE email = $1', [body.email])).rowCount) throw conflict('An account with this email already exists');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const user = (await client.query('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name', [body.email, body.name ?? null, await hashPassword(body.password)])).rows[0];
      const tenant = (
        await client.query(
          `INSERT INTO tenants (name, site_url, platform, trial_ends_at, settings) VALUES ($1, $2, $3, now() + make_interval(days => $5), $4) RETURNING id`,
          [body.storeName, body.siteUrl ?? null, body.platform, { assistantName: `${body.storeName} assistant`, tone: 'friendly', greeting: `Hi! Looking for something at ${body.storeName}? Tell me what you need and I'll find it.`, primaryColor: '#1B2A4A', placement: 'bottom-right' }, TRIAL_DAYS],
        )
      ).rows[0];
      await client.query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`, [user.id, tenant.id]);
      const origin = originOf(body.siteUrl);
      await client.query('INSERT INTO widget_keys (key, tenant_id, allowed_origins) VALUES ($1, $2, $3)', [randomToken('pk_'), tenant.id, origin ? [origin] : []]);
      await client.query('COMMIT');
      return { token: app.jwt.sign({ sub: user.id }, { expiresIn: '7d' }), user, storeId: tenant.id };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  app.post('/v1/auth/login', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req) => {
    const body = Login.parse(req.body);
    const user = (await query('SELECT id, email, name, password_hash FROM users WHERE email = $1', [body.email])).rows[0];
    if (!user || !(await verifyPassword(body.password, user.password_hash))) throw unauthorized('Wrong email or password');
    return { token: app.jwt.sign({ sub: user.id }, { expiresIn: '7d' }), user: { id: user.id, email: user.email, name: user.name } };
  });

  app.get('/v1/me', async (req) => {
    const userId = await requireUser(req);
    const user = (await query('SELECT id, email, name FROM users WHERE id = $1', [userId])).rows[0];
    if (!user) throw unauthorized();
    const stores = (await query('SELECT t.id, t.name, t.plan, m.role FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = $1 ORDER BY t.created_at', [userId])).rows;
    return { user, stores };
  });

  app.get('/v1/plans', async () => ({ plans: Object.values(PLANS) }));

  app.get('/v1/stores/:storeId', { preHandler: requireStore() }, async (req) => {
    const { tenantId } = req.store!;
    const t = (await query('SELECT id, name, site_url, platform, plan, trial_ends_at, settings, ai_mode, monthly_budget_usd::float AS monthly_budget_usd, created_at FROM tenants WHERE id = $1', [tenantId])).rows[0];
    const keys = (await query('SELECT key, allowed_origins, created_at FROM widget_keys WHERE tenant_id = $1 AND revoked_at IS NULL ORDER BY created_at', [tenantId])).rows;
    const { stats, usage, ai } = await withTenant(tenantId, async (db) => ({
      stats: await catalogStats(db),
      usage: await monthUsage(db),
      ai: (await db.query('SELECT provider, chat_model, embedding_model, key_last4, validated_at FROM ai_credentials')).rows[0] ?? null,
    }));
    const plan = planFor(t.plan);
    return {
      store: t,
      plan,
      catalog: stats,
      usage: { ...usage, conversationLimit: plan.conversationsPerMonth, overConversationLimit: usage.conversations > plan.conversationsPerMonth, budgetUsd: t.monthly_budget_usd, overBudget: usage.cost_usd >= t.monthly_budget_usd && t.ai_mode !== 'demo' },
      ai: ai ? { ...ai, key: `••••${ai.key_last4}` } : null,
      widgetKeys: keys,
      embedSnippet: keys[0] ? `<script src="${config.publicApiUrl}/widget/sailes.js" data-sailes-key="${keys[0].key}" async></script>` : null,
    };
  });

  app.patch('/v1/stores/:storeId', { preHandler: requireStore(['owner', 'admin']) }, async (req) => {
    const body = StorePatch.parse(req.body);
    const { tenantId } = req.store!;
    if (body.plan && (config.stripe.secretKey || (config.isProd && !config.allowPlanSwitch))) throw badRequest('Change your plan from the billing page');
    const cur = (await query('SELECT settings FROM tenants WHERE id = $1', [tenantId])).rows[0];
    await query(
      `UPDATE tenants SET name = coalesce($2, name), site_url = CASE WHEN $3::boolean THEN $4 ELSE site_url END,
              settings = $5, monthly_budget_usd = coalesce($6, monthly_budget_usd), plan = coalesce($7, plan) WHERE id = $1`,
      [tenantId, body.name ?? null, body.siteUrl !== undefined, body.siteUrl ?? null, { ...(cur?.settings ?? {}), ...(body.settings ?? {}) }, body.monthlyBudgetUsd ?? null, body.plan ?? null],
    );
    return { ok: true };
  });

  // Widget keys (public, used in the script tag) ---------------------------------------
  app.put('/v1/stores/:storeId/widget-keys/:key', { preHandler: requireStore(['owner', 'admin']) }, async (req) => {
    const body = z.object({ allowedOrigins: z.array(z.string().url()).max(20) }).parse(req.body);
    const origins = body.allowedOrigins.map((o) => new URL(o).origin);
    const r = await query('UPDATE widget_keys SET allowed_origins = $3 WHERE key = $1 AND tenant_id = $2 RETURNING key', [(req.params as any).key, req.store!.tenantId, origins]);
    return { ok: (r.rowCount ?? 0) > 0, allowedOrigins: origins };
  });

  // Connector secret keys (server to server, shown once) --------------------------------
  app.get('/v1/stores/:storeId/api-keys', { preHandler: requireStore(['owner', 'admin']) }, async (req) => {
    return { keys: (await query('SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE tenant_id = $1 AND revoked_at IS NULL ORDER BY created_at', [req.store!.tenantId])).rows };
  });
  app.post('/v1/stores/:storeId/api-keys', { preHandler: requireStore(['owner', 'admin']) }, async (req) => {
    const body = z.object({ name: z.string().max(60).default('Connector') }).parse(req.body ?? {});
    const key = randomToken('sk_', 24);
    const row = (await query('INSERT INTO api_keys (tenant_id, name, key_hash, prefix) VALUES ($1, $2, $3, $4) RETURNING id, name, prefix, created_at', [req.store!.tenantId, body.name, hashApiKey(key), key.slice(0, 8)])).rows[0];
    return { ...row, key };
  });
  app.delete('/v1/stores/:storeId/api-keys/:id', { preHandler: requireStore(['owner', 'admin']) }, async (req) => {
    await query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND tenant_id = $2', [(req.params as any).id, req.store!.tenantId]);
    return { ok: true };
  });
}
