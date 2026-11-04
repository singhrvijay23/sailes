import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, query } from '../db/pool.js';
import { config } from '../config.js';
import { hashApiKey, requireStore } from '../auth.js';
import { randomToken } from '../lib/password.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { planFor } from '../lib/plans.js';
import { isEntitled } from '../billing/billing.js';

export const PLATFORMS = ['woocommerce', 'shopify', 'wix', 'webflow'] as const;
const CODE_TTL_MINUTES = 10;

const httpsUrl = z
  .string()
  .url()
  .max(500)
  .refine((u) => {
    const url = new URL(u);
    // Plain http only for local development shops.
    return url.protocol === 'https:' || (!config.isProd && ['localhost', '127.0.0.1'].includes(url.hostname));
  }, 'Must be an https URL');

const Approve = z.object({ platform: z.enum(PLATFORMS), shopUrl: httpsUrl, redirectUri: httpsUrl, state: z.string().min(8).max(200) });

/** Connector requests authenticate with their secret key alone (no store id in the path). */
async function requireConnector(req: FastifyRequest) {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer sk_')) throw unauthorized('Missing connector key');
  const row = (await query('UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 AND revoked_at IS NULL RETURNING tenant_id, platform, shop_url', [hashApiKey(auth.slice(7).trim())])).rows[0];
  if (!row) throw unauthorized('Invalid API key');
  return row as { tenant_id: string; platform: string | null; shop_url: string | null };
}

export async function connectRoutes(app: FastifyInstance) {
  /**
   * Step 2 of the install flow: the signed-in merchant approved the connection on the console's
   * /connect page. Returns the URL to send the browser back to, carrying a one-time code.
   */
  app.post('/v1/stores/:storeId/connect/approve', { preHandler: requireStore(['owner', 'admin']) }, async (req) => {
    const body = Approve.parse(req.body);
    const { tenantId, userId } = req.store!;
    const code = randomToken('cc_', 24);
    await query(
      `INSERT INTO connect_codes (code_hash, tenant_id, platform, shop_url, created_by, expires_at) VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))`,
      [hashApiKey(code), tenantId, body.platform, new URL(body.shopUrl).origin, userId, CODE_TTL_MINUTES],
    );
    const redirect = new URL(body.redirectUri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', body.state);
    return { redirect: redirect.toString() };
  });

  /**
   * Step 3: the connector's server exchanges the code for its credentials. Single use, expires
   * after 10 minutes. Replaces any earlier key for the same shop, sets the store's platform and
   * allows the shop's origin on the widget key.
   */
  app.post('/v1/connect/exchange', { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req) => {
    const { code } = z.object({ code: z.string().min(10).max(200) }).parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (
        await client.query(`UPDATE connect_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING tenant_id, platform, shop_url`, [hashApiKey(code)])
      ).rows[0];
      if (!row) throw badRequest('This connection code is invalid, used or expired. Start the connection again.', 'invalid_code');
      await client.query('UPDATE api_keys SET revoked_at = now() WHERE tenant_id = $1 AND shop_url = $2 AND revoked_at IS NULL', [row.tenant_id, row.shop_url]);
      const apiKey = randomToken('sk_', 24);
      await client.query('INSERT INTO api_keys (tenant_id, name, key_hash, prefix, platform, shop_url) VALUES ($1, $2, $3, $4, $5, $6)', [
        row.tenant_id,
        `${row.platform} · ${new URL(row.shop_url).host}`,
        hashApiKey(apiKey),
        apiKey.slice(0, 8),
        row.platform,
        row.shop_url,
      ]);
      await client.query(`UPDATE tenants SET platform = $2, site_url = coalesce(site_url, $3) WHERE id = $1`, [row.tenant_id, row.platform, row.shop_url]);
      const wk = (
        await client.query(
          `UPDATE widget_keys SET allowed_origins = CASE WHEN $2 = ANY(allowed_origins) THEN allowed_origins ELSE array_append(allowed_origins, $2) END
           WHERE key = (SELECT key FROM widget_keys WHERE tenant_id = $1 AND revoked_at IS NULL ORDER BY created_at LIMIT 1) RETURNING key`,
          [row.tenant_id, row.shop_url],
        )
      ).rows[0];
      await client.query('COMMIT');
      return { storeId: row.tenant_id, apiKey, widgetKey: wk?.key ?? null, apiUrl: config.publicApiUrl, widgetScriptUrl: `${config.publicApiUrl}/widget/sailes.js` };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  /** Connector health check and the settings it needs to render the widget. */
  app.get('/v1/connector/store', async (req) => {
    const key = await requireConnector(req);
    const t = (await query('SELECT id, name, plan, platform, trial_ends_at, subscription_status FROM tenants WHERE id = $1', [key.tenant_id])).rows[0];
    const wk = (await query('SELECT key FROM widget_keys WHERE tenant_id = $1 AND revoked_at IS NULL ORDER BY created_at LIMIT 1', [key.tenant_id])).rows[0];
    return {
      storeId: t.id,
      storeName: t.name,
      plan: planFor(t.plan).id,
      platform: t.platform,
      shopUrl: key.shop_url,
      active: isEntitled(t),
      widgetKey: wk?.key ?? null,
      widgetScriptUrl: `${config.publicApiUrl}/widget/sailes.js`,
      consoleUrl: config.consoleOrigin,
    };
  });

  /** Uninstall: the connector revokes its own key. */
  app.post('/v1/connector/disconnect', async (req) => {
    const auth = (req.headers.authorization ?? '').slice(7).trim();
    await requireConnector(req);
    await query('UPDATE api_keys SET revoked_at = now() WHERE key_hash = $1', [hashApiKey(auth)]);
    return { ok: true };
  });
}
