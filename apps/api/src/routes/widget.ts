import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { query, withTenant } from '../db/pool.js';
import { config } from '../config.js';
import { forbidden, unauthorized, HttpError } from '../lib/errors.js';
import { handleChat } from '../agent/orchestrator.js';
import { isEntitled } from '../billing/billing.js';

interface WidgetKey {
  tenantId: string;
  key: string;
}

const keyCache = new Map<string, { tenantId: string; origins: string[]; at: number }>();

/** Resolve the public widget key and enforce the store's allowed origins. */
export async function resolveWidgetKey(req: FastifyRequest): Promise<WidgetKey> {
  const key = (req.headers['x-sailes-key'] as string | undefined) ?? (req.query as any)?.key;
  if (!key || !key.startsWith('pk_')) throw unauthorized('Missing widget key');
  let entry = keyCache.get(key);
  if (!entry || Date.now() - entry.at > 60_000) {
    const row = (await query('SELECT tenant_id, allowed_origins FROM widget_keys WHERE key = $1 AND revoked_at IS NULL', [key])).rows[0];
    if (!row) throw unauthorized('Unknown widget key');
    entry = { tenantId: row.tenant_id, origins: row.allowed_origins, at: Date.now() };
    keyCache.set(key, entry);
  }
  const origin = req.headers.origin;
  const trusted = [config.consoleOrigin, config.publicApiUrl].map((u) => new URL(u).origin);
  if (origin && entry.origins.length && !entry.origins.includes(origin) && !trusted.includes(origin)) {
    throw forbidden(`This widget key is not allowed on ${origin}`);
  }
  return { tenantId: entry.tenantId, key };
}

/** A store whose trial ended without a live subscription stops serving the widget (402). */
async function assertEntitled(tenantId: string) {
  const t = (await query('SELECT trial_ends_at, subscription_status FROM tenants WHERE id = $1', [tenantId])).rows[0];
  if (!t || !isEntitled(t)) throw new HttpError(402, 'This store assistant is not active', 'store_inactive');
}

const ChatBody = z.object({
  message: z.string().min(1).max(2000),
  conversationId: z.string().uuid().nullish(),
  visitorId: z.string().max(80).nullish(),
});

const EventBody = z.object({
  type: z.enum(['click', 'add_to_cart', 'widget_open', 'feedback']),
  conversationId: z.string().uuid().nullish(),
  productId: z.string().max(200).nullish(),
  value: z.number().nullish(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export async function widgetRoutes(app: FastifyInstance) {
  app.get('/v1/widget/config', async (req) => {
    const { tenantId } = await resolveWidgetKey(req);
    await assertEntitled(tenantId);
    const t = (await query('SELECT name, settings, platform FROM tenants WHERE id = $1', [tenantId])).rows[0];
    const s = t.settings ?? {};
    return {
      storeName: t.name,
      platform: t.platform,
      assistantName: s.assistantName ?? `${t.name} assistant`,
      greeting: s.greeting ?? 'Hi! What are you shopping for today?',
      primaryColor: s.primaryColor ?? '#1B2A4A',
      logoUrl: s.logoUrl || null,
      placement: s.placement ?? 'bottom-right',
      suggestions: s.suggestions ?? [],
    };
  });

  /** Shopper chat. Streams server-sent events: conversation, text, products, question, reset, done, error. */
  app.post('/v1/chat', { config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => `${req.headers['x-sailes-key']}:${req.ip}` } } }, async (req, reply) => {
    const { tenantId } = await resolveWidgetKey(req);
    await assertEntitled(tenantId);
    const body = ChatBody.parse(req.body);
    const controller = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': req.headers.origin ?? '*',
      vary: 'Origin',
    });
    const emit = (event: string, data: unknown) => {
      if (!reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      const out = await handleChat({ tenantId, conversationId: body.conversationId, visitorId: body.visitorId, message: body.message, emit, signal: controller.signal });
      emit('done', { conversationId: out.conversationId, mode: out.mode });
    } catch (e) {
      req.log.error(e);
      const msg = e instanceof HttpError ? e.message : 'Sorry, something went wrong. Please try again.';
      emit('error', { message: msg });
    } finally {
      reply.raw.end();
    }
  });

  app.post('/v1/events', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const { tenantId } = await resolveWidgetKey(req);
    const e = EventBody.parse(req.body);
    await withTenant(tenantId, (db) =>
      db.query('INSERT INTO events (tenant_id, conversation_id, type, product_external_id, value, meta) VALUES ($1, $2, $3, $4, $5, $6)', [tenantId, e.conversationId ?? null, e.type, e.productId ?? null, e.value ?? null, e.meta ?? {}]),
    );
    return { ok: true };
  });
}
