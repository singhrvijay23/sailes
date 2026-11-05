import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, withTenant } from '../db/pool.js';
import { requireStore } from '../auth.js';
import { normalizeMany, parseCatalogFile } from '../catalog/normalize.js';
import { catalogStats, deleteProducts, upsertProducts } from '../catalog/service.js';
import { enqueueEmbedding } from '../queue.js';
import { badRequest } from '../lib/errors.js';
import { loadSearchContext, searchProducts } from '../search/search.js';
import { providerForTenant } from '../ai/registry.js';

const MAX_ERRORS_RETURNED = 50;

async function importRows(tenantId: string, rows: Array<Record<string, unknown>>) {
  const plan = (await query('SELECT plan FROM tenants WHERE id = $1', [tenantId])).rows[0].plan;
  const { products, errors } = normalizeMany(rows);
  const summary = products.length ? await withTenant(tenantId, (db) => upsertProducts(db, tenantId, plan, products)) : { created: 0, updated: 0, unchanged: 0, total: 0 };
  if (summary.created + summary.updated > 0) await enqueueEmbedding(tenantId);
  return { ...summary, received: rows.length, rejected: errors.length, errors: errors.slice(0, MAX_ERRORS_RETURNED) };
}

export async function catalogRoutes(app: FastifyInstance) {
  const writers = requireStore(['owner', 'admin', 'connector']);
  const readers = requireStore(['owner', 'admin', 'viewer', 'connector']);

  /** Upload a CSV or JSON catalog file (multipart "file" field), or send the file body directly. */
  app.post('/v1/stores/:storeId/catalog/import', { preHandler: writers, bodyLimit: 60 * 1024 * 1024 }, async (req) => {
    let body: string;
    let format: 'csv' | 'json' | 'auto' = 'auto';
    if (req.isMultipart()) {
      const file = await req.file({ limits: { fileSize: 60 * 1024 * 1024 } });
      if (!file) throw badRequest('Attach a file in the "file" field');
      body = (await file.toBuffer()).toString('utf8');
      if (file.filename.toLowerCase().endsWith('.csv')) format = 'csv';
      if (file.filename.toLowerCase().endsWith('.json')) format = 'json';
    } else if (typeof req.body === 'string') {
      body = req.body;
    } else if (req.body && typeof req.body === 'object') {
      body = JSON.stringify(req.body);
      format = 'json';
    } else throw badRequest('Send a CSV or JSON catalog');
    let rows;
    try {
      rows = parseCatalogFile(body, format);
    } catch (e) {
      throw badRequest(`Could not read the file: ${(e as Error).message}`, 'unreadable_file');
    }
    if (!rows.length) throw badRequest('The file has no products');
    return importRows(req.store!.tenantId, rows);
  });

  /** Connector sync: upsert a batch of products (platform webhooks and nightly resync). */
  app.put('/v1/stores/:storeId/catalog/products', { preHandler: writers, bodyLimit: 20 * 1024 * 1024 }, async (req) => {
    const body = z.object({ products: z.array(z.record(z.string(), z.unknown())).min(1).max(5000) }).parse(req.body);
    return importRows(req.store!.tenantId, body.products);
  });

  app.post('/v1/stores/:storeId/catalog/products/delete', { preHandler: writers }, async (req) => {
    const body = z.object({ ids: z.array(z.string()).min(1).max(5000) }).parse(req.body);
    return { deleted: await withTenant(req.store!.tenantId, (db) => deleteProducts(db, body.ids)) };
  });

  app.get('/v1/stores/:storeId/catalog', { preHandler: readers }, async (req) => {
    const q = z.object({ q: z.string().max(200).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query);
    return withTenant(req.store!.tenantId, async (db) => {
      const params: unknown[] = [q.pageSize, (q.page - 1) * q.pageSize];
      let where = 'true';
      if (q.q) {
        params.push(`%${q.q}%`);
        where = `(title ILIKE $3 OR external_id ILIKE $3 OR brand ILIKE $3)`;
      }
      const { rows } = await db.query(
        `SELECT external_id AS id, title, brand, price::float AS price, in_stock, categories, image_url, embedding IS NOT NULL AS indexed, updated_at, count(*) OVER () AS total
         FROM products WHERE ${where} ORDER BY title LIMIT $1 OFFSET $2`,
        params,
      );
      return { stats: await catalogStats(db), total: Number(rows[0]?.total ?? 0), items: rows.map(({ total, ...r }) => r) };
    });
  });

  /** Merchant test search (what the AI's search tool would return). */
  app.get('/v1/stores/:storeId/catalog/search', { preHandler: readers }, async (req) => {
    const q = z.object({ q: z.string().max(200).default(''), maxPrice: z.coerce.number().optional() }).parse(req.query);
    const { provider } = await providerForTenant(req.store!.tenantId);
    let vec: number[] | null = null;
    if (q.q) vec = (await provider.embed([q.q], 'query').catch(() => ({ vectors: [null] }))).vectors[0] ?? null;
    return withTenant(req.store!.tenantId, async (db) => searchProducts(db, { query: q.q, queryVector: vec, embeddingModel: provider.embeddingModel, filters: { maxPrice: q.maxPrice } }, await loadSearchContext(db)));
  });

  // Merchandising rules ----------------------------------------------------------------
  const Rule = z.object({ action: z.enum(['boost', 'bury', 'exclude']), matchField: z.enum(['product', 'category', 'tag', 'brand']), matchValue: z.string().min(1).max(200), weight: z.number().min(1).max(10).default(1.5) });
  app.get('/v1/stores/:storeId/rules', { preHandler: readers }, async (req) =>
    withTenant(req.store!.tenantId, async (db) => ({
      rules: (await db.query('SELECT id, action, match_field, match_value, weight::float AS weight FROM merch_rules ORDER BY created_at')).rows,
      synonyms: (await db.query('SELECT id, term, synonyms FROM synonyms ORDER BY term')).rows,
      policies: (await db.query('SELECT id, topic, content FROM policies ORDER BY topic')).rows,
    })),
  );
  app.post('/v1/stores/:storeId/rules', { preHandler: requireStore(['owner', 'admin']) }, async (req) => {
    const r = Rule.parse(req.body);
    const t = req.store!.tenantId;
    return withTenant(t, async (db) => (await db.query('INSERT INTO merch_rules (tenant_id, action, match_field, match_value, weight) VALUES ($1,$2,$3,$4,$5) RETURNING id', [t, r.action, r.matchField, r.matchValue, r.weight])).rows[0]);
  });
  app.delete('/v1/stores/:storeId/rules/:id', { preHandler: requireStore(['owner', 'admin']) }, async (req) => {
    await withTenant(req.store!.tenantId, (db) => db.query('DELETE FROM merch_rules WHERE id = $1', [(req.params as any).id]));
    return { ok: true };
  });

  app.put('/v1/stores/:storeId/synonyms', { preHandler: requireStore(['owner', 'admin']) }, async (req) => {
    const s = z.object({ term: z.string().min(1).max(80), synonyms: z.array(z.string().min(1).max(80)).min(1).max(20) }).parse(req.body);
    const t = req.store!.tenantId;
    return withTenant(t, async (db) =>
      (await db.query('INSERT INTO synonyms (tenant_id, term, synonyms) VALUES ($1, lower($2), $3) ON CONFLICT (tenant_id, term) DO UPDATE SET synonyms = EXCLUDED.synonyms RETURNING id', [t, s.term, s.synonyms])).rows[0],
    );
  });
  app.delete('/v1/stores/:storeId/synonyms/:id', { preHandler: requireStore(['owner', 'admin']) }, async (req) => {
    await withTenant(req.store!.tenantId, (db) => db.query('DELETE FROM synonyms WHERE id = $1', [(req.params as any).id]));
    return { ok: true };
  });

  app.put('/v1/stores/:storeId/policies', { preHandler: requireStore(['owner', 'admin', 'connector']) }, async (req) => {
    const p = z.object({ topic: z.string().min(1).max(60), content: z.string().min(1).max(4000) }).parse(req.body);
    const t = req.store!.tenantId;
    return withTenant(t, async (db) =>
      (await db.query('INSERT INTO policies (tenant_id, topic, content) VALUES ($1, lower($2), $3) ON CONFLICT (tenant_id, topic) DO UPDATE SET content = EXCLUDED.content RETURNING id', [t, p.topic, p.content])).rows[0],
    );
  });
  app.delete('/v1/stores/:storeId/policies/:id', { preHandler: requireStore(['owner', 'admin']) }, async (req) => {
    await withTenant(req.store!.tenantId, (db) => db.query('DELETE FROM policies WHERE id = $1', [(req.params as any).id]));
    return { ok: true };
  });
}
