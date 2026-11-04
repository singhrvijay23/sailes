import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../db/pool.js';
import { requireStore } from '../auth.js';
import { notFound } from '../lib/errors.js';

const Range = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

export async function analyticsRoutes(app: FastifyInstance) {
  app.get('/v1/stores/:storeId/analytics', { preHandler: requireStore() }, async (req) => {
    const { days } = Range.parse(req.query);
    return withTenant(req.store!.tenantId, async (db) => {
      const since = `now() - interval '${days} days'`;
      const totals = (
        await db.query(
          `SELECT
             (SELECT count(*)::int FROM conversations WHERE created_at > ${since}) AS conversations,
             (SELECT count(*)::int FROM messages WHERE role = 'user' AND created_at > ${since}) AS shopper_messages,
             count(*) FILTER (WHERE type IN ('search','zero_result'))::int AS searches,
             count(*) FILTER (WHERE type = 'zero_result')::int AS zero_results,
             count(*) FILTER (WHERE type = 'impression')::int AS impressions,
             count(*) FILTER (WHERE type = 'click')::int AS clicks,
             count(*) FILTER (WHERE type = 'add_to_cart')::int AS add_to_carts,
             count(*) FILTER (WHERE type = 'order')::int AS orders,
             coalesce(sum(value) FILTER (WHERE type = 'order'), 0)::float AS attributed_revenue,
             count(*) FILTER (WHERE type = 'ai_error')::int AS ai_errors
           FROM events WHERE created_at > ${since}`,
        )
      ).rows[0];
      const daily = (
        await db.query(
          `SELECT to_char(d, 'YYYY-MM-DD') AS day,
                  (SELECT count(*)::int FROM conversations c WHERE c.created_at >= d AND c.created_at < d + interval '1 day') AS conversations,
                  (SELECT count(*)::int FROM events e WHERE e.type = 'add_to_cart' AND e.created_at >= d AND e.created_at < d + interval '1 day') AS add_to_carts
           FROM generate_series(date_trunc('day', ${since}), date_trunc('day', now()), interval '1 day') d ORDER BY d`,
        )
      ).rows;
      const topQueries = (
        await db.query(`SELECT lower(query) AS query, count(*)::int AS n FROM events WHERE type IN ('search','zero_result') AND query <> '' AND created_at > ${since} GROUP BY 1 ORDER BY n DESC LIMIT 15`)
      ).rows;
      const zeroResultQueries = (
        await db.query(`SELECT lower(query) AS query, count(*)::int AS n, max(created_at) AS last_seen FROM events WHERE type = 'zero_result' AND created_at > ${since} GROUP BY 1 ORDER BY n DESC LIMIT 15`)
      ).rows;
      const topProducts = (
        await db.query(
          `SELECT e.product_external_id AS id, p.title,
                  count(*) FILTER (WHERE e.type = 'impression')::int AS impressions,
                  count(*) FILTER (WHERE e.type = 'click')::int AS clicks,
                  count(*) FILTER (WHERE e.type = 'add_to_cart')::int AS add_to_carts
           FROM events e LEFT JOIN products p ON p.external_id = e.product_external_id
           WHERE e.product_external_id IS NOT NULL AND e.created_at > ${since}
           GROUP BY 1, 2 ORDER BY add_to_carts DESC, clicks DESC, impressions DESC LIMIT 10`,
        )
      ).rows;
      return { days, totals, daily, topQueries, zeroResultQueries, topProducts };
    });
  });

  app.get('/v1/stores/:storeId/conversations', { preHandler: requireStore() }, async (req) => {
    const q = z.object({ page: z.coerce.number().int().min(1).default(1) }).parse(req.query);
    return withTenant(req.store!.tenantId, async (db) => ({
      items: (
        await db.query(
          `SELECT c.id, c.created_at, c.last_message_at, c.message_count,
                  (SELECT content FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY id LIMIT 1) AS first_message
           FROM conversations c ORDER BY c.last_message_at DESC LIMIT 25 OFFSET $1`,
          [(q.page - 1) * 25],
        )
      ).rows,
    }));
  });

  app.get('/v1/stores/:storeId/conversations/:id', { preHandler: requireStore() }, async (req) => {
    const id = z.string().uuid().parse((req.params as any).id);
    return withTenant(req.store!.tenantId, async (db) => {
      const conv = (await db.query('SELECT id, created_at, last_message_at FROM conversations WHERE id = $1', [id])).rows[0];
      if (!conv) throw notFound('Conversation not found');
      const messages = (await db.query('SELECT role, content, payload, created_at FROM messages WHERE conversation_id = $1 ORDER BY id', [id])).rows;
      return { conversation: conv, messages };
    });
  });

  /** Connector reports an order so revenue can be attributed to SAILES conversations. */
  app.post('/v1/stores/:storeId/orders', { preHandler: requireStore(['owner', 'admin', 'connector']) }, async (req) => {
    const o = z.object({ orderId: z.string().max(120), total: z.number().nonnegative(), conversationId: z.string().uuid().nullish(), productIds: z.array(z.string()).max(200).default([]) }).parse(req.body);
    const t = req.store!.tenantId;
    // Platform webhooks retry: an order is recorded once.
    const inserted = await withTenant(t, async (db) => {
      const dup = await db.query(`SELECT 1 FROM events WHERE type = 'order' AND meta->>'orderId' = $1 LIMIT 1`, [o.orderId]);
      if (dup.rowCount) return false;
      await db.query(`INSERT INTO events (tenant_id, conversation_id, type, value, meta) VALUES ($1, $2, 'order', $3, $4)`, [t, o.conversationId ?? null, o.total, { orderId: o.orderId, productIds: o.productIds }]);
      return true;
    });
    return { ok: true, duplicate: !inserted };
  });
}
