import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';
import { normalizeShop, verifySessionToken, verifyWebhookHmac } from './crypto.js';
import type { FetchFn, SleepFn } from './http.js';
import { SailesError, type AiSettings } from './sailes.js';
import { NotConnectedError, ShopifyConnector } from './service.js';
import { ShopifyError } from './shopify.js';
import { MemoryStore, PgStore, type ShopStore } from './store.js';

// src/app.ts in development, dist/src/app.js when built: public/ sits next to package.json either way.
const here = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(here, here.includes(`${sep}dist${sep}`) ? '../../public' : '../public');
const read = (f: string) => readFileSync(join(publicDir, f), 'utf8');

declare module 'fastify' {
  interface FastifyRequest {
    shop?: string;
  }
}

export interface BuildOptions {
  config: AppConfig;
  store?: ShopStore;
  fetchFn?: FetchFn;
  sleep?: SleepFn;
  logger?: boolean;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function messagePage(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f1f1f1;color:#303030;margin:0;padding:48px 16px}main{max-width:480px;margin:auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 2px rgba(0,0,0,.1)}h1{font-size:18px;margin:0 0 8px}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${body}</p></main></body></html>`;
}

export async function buildApp(opts: BuildOptions) {
  const cfg = opts.config;
  const app = Fastify({ logger: opts.logger === false ? false : { level: cfg.logLevel, redact: ['req.headers.authorization', 'req.headers["x-shopify-access-token"]'] }, trustProxy: true });
  const store = opts.store ?? (cfg.databaseUrl ? new PgStore(cfg.databaseUrl, cfg.encryptionKey) : new MemoryStore());
  const log = app.log as unknown as ConstructorParameters<typeof ShopifyConnector>[2];
  const svc = new ShopifyConnector(cfg, store, log, opts.fetchFn, opts.sleep);
  app.decorate('connector', svc);
  app.addHook('onClose', async () => {
    await svc.jobs.drain();
    await store.close();
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof NotConnectedError) return reply.code(409).send({ error: 'not_connected', message: err.message });
    if (err instanceof SailesError) return reply.code(err.status >= 400 && err.status < 500 ? err.status : 502).send({ error: err.code, message: err.message });
    if (err instanceof ShopifyError) return reply.code(err.code === 'reauth_needed' ? 401 : 502).send({ error: err.code, message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong. Please try again.' });
  });

  app.get('/health', async () => ({ ok: true }));

  // ---------- Embedded admin page ----------

  const adminHtml = read('admin.html').replaceAll('%SHOPIFY_API_KEY%', escapeHtml(cfg.apiKey));
  const adminJs = read('admin.js');

  const sendAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    const shop = normalizeShop((req.query as Record<string, string>).shop);
    // Embedded apps must only be framed by the shop's admin.
    reply.header('content-security-policy', `frame-ancestors ${shop ? `https://${shop} ` : ''}https://admin.shopify.com;`);
    return reply.type('text/html; charset=utf-8').send(adminHtml);
  };
  app.get('/', sendAdmin);
  app.get('/app', sendAdmin);
  app.get('/admin.js', async (_req, reply) => reply.type('application/javascript; charset=utf-8').header('cache-control', 'no-cache').send(adminJs));

  // ---------- Admin API (App Bridge session token) ----------

  app.register(async (api) => {
    api.addHook('preHandler', async (req, reply) => {
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ')) return reply.code(401).send({ error: 'unauthorized', message: 'Open SAILES from your Shopify admin' });
      let session;
      try {
        session = verifySessionToken(auth.slice(7).trim(), cfg.apiKey, cfg.apiSecret);
      } catch {
        // App Bridge retries with a fresh token when it sees this header.
        return reply.code(401).header('x-shopify-retry-invalid-session-request', '1').send({ error: 'invalid_session', message: 'Session expired' });
      }
      await svc.ensureToken(session.shop, session.token);
      req.shop = session.shop;
    });

    api.get('/api/status', async (req) => {
      const s = await svc.status(req.shop!);
      return {
        ...s,
        themeEditorUrl: `https://${req.shop}/admin/themes/current/editor?context=apps&activateAppId=${encodeURIComponent(cfg.themeExtensionId || cfg.apiKey)}/sailes-embed`,
      };
    });

    api.post('/api/connect', async (req) => ({ url: await svc.startConnect(req.shop!) }));

    api.post('/api/sync', async (req) => {
      const rec = await store.get(req.shop!);
      if (!rec?.sailes) throw new NotConnectedError();
      svc.queueFullSync(req.shop!);
      return { ok: true };
    });

    api.get('/api/ai', async (req) => svc.getAi(req.shop!));

    api.put('/api/ai', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      let settings: AiSettings;
      if (b.mode === 'demo' || b.mode === 'managed') settings = { mode: b.mode };
      else if (b.mode === 'byok' && (b.provider === 'openai' || b.provider === 'gemini' || b.provider === 'anthropic')) {
        settings = { mode: 'byok', provider: b.provider };
        if (typeof b.apiKey === 'string' && b.apiKey.trim()) settings.apiKey = b.apiKey.trim().slice(0, 400);
        if (typeof b.chatModel === 'string' && b.chatModel) settings.chatModel = b.chatModel.slice(0, 80);
      } else throw Object.assign(new Error('Choose an AI option'), { statusCode: 400 });
      return svc.putAi(req.shop!, settings);
    });
  });

  // ---------- Return from the SAILES console ----------

  app.get('/connect/callback', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!q.code || !q.state) return reply.code(400).type('text/html').send(messagePage('Connection not finished', 'The link is missing its code. Open SAILES in your Shopify admin and click Connect again.'));
    try {
      const shop = await svc.finishConnect(q.state, q.code);
      const handle = shop.replace(/\.myshopify\.com$/, '');
      return reply.redirect(`https://admin.shopify.com/store/${handle}/apps/${encodeURIComponent(cfg.apiKey)}`);
    } catch (e) {
      if (e instanceof SailesError && e.status < 500) return reply.code(400).type('text/html').send(messagePage('Connection not finished', escapeHtml(e.message)));
      throw e;
    }
  });

  // ---------- Webhooks ----------

  app.register(async (hooks) => {
    hooks.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    hooks.post('/webhooks', async (req, reply) => {
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw) || !verifyWebhookHmac(raw, req.headers['x-shopify-hmac-sha256'] as string | undefined, cfg.apiSecret)) {
        return reply.code(401).send({ error: 'invalid_hmac' });
      }
      const topic = String(req.headers['x-shopify-topic'] ?? '');
      const shop = normalizeShop(req.headers['x-shopify-shop-domain']);
      if (!shop) return reply.code(400).send({ error: 'unknown_shop' });
      let payload: Record<string, any>;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply.code(400).send({ error: 'bad_json' });
      }
      handleWebhook(svc, shop, topic, payload);
      // Answer within Shopify's 5 second limit; the work runs in the background.
      return { ok: true };
    });
  });

  return app;
}

export function handleWebhook(svc: ShopifyConnector, shop: string, topic: string, p: Record<string, any>) {
  switch (topic) {
    case 'products/create':
    case 'products/update':
      if (p.id) svc.queueProduct(shop, String(p.id));
      break;
    case 'products/delete':
      if (p.id) svc.jobs.enqueue(shop, `product:${p.id}`, () => svc.deleteProduct(shop, String(p.id)));
      break;
    case 'inventory_levels/update':
      if (p.inventory_item_id) svc.jobs.enqueue(shop, `inventory:${p.inventory_item_id}`, () => svc.syncInventoryItem(shop, String(p.inventory_item_id)));
      break;
    case 'orders/paid':
      if (p.id) svc.jobs.enqueue(shop, `order:${p.id}`, () => svc.reportOrder(shop, p as Parameters<ShopifyConnector['reportOrder']>[1]));
      break;
    case 'app/uninstalled':
      svc.jobs.enqueue(shop, 'uninstall', () => svc.uninstalled(shop));
      break;
    case 'shop/redact':
      svc.jobs.enqueue(shop, 'redact', () => svc.redactShop(shop));
      break;
    // We store no customer data, so these compliance requests need no action.
    case 'customers/data_request':
    case 'customers/redact':
    default:
      break;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    connector: ShopifyConnector;
  }
}
