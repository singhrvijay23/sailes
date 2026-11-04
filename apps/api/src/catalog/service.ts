import pgvector from 'pgvector';
import { withTenant, type Db } from '../db/pool.js';
import { planFor } from '../lib/plans.js';
import { HttpError } from '../lib/errors.js';
import type { NormalizedProduct } from './normalize.js';
import { recordUsage } from '../usage/usage.js';
import type { ChatProvider } from '../ai/types.js';

export interface UpsertSummary {
  created: number;
  updated: number;
  unchanged: number;
  total: number;
}

const BATCH = 500;

export async function upsertProducts(db: Db, tenantId: string, plan: string, products: NormalizedProduct[]): Promise<UpsertSummary> {
  const limit = planFor(plan).productsIndexed;
  const existing = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM products');
  const existingIds = new Set(
    (await db.query<{ external_id: string }>('SELECT external_id FROM products WHERE external_id = ANY($1)', [products.map((p) => p.externalId)])).rows.map((r) => r.external_id),
  );
  const newCount = products.filter((p) => !existingIds.has(p.externalId)).length;
  if (existing.rows[0]!.n + newCount > limit) {
    throw new HttpError(402, `Your ${planFor(plan).name} plan indexes up to ${limit.toLocaleString('en-US')} products. Upgrade to import more.`, 'product_limit');
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (let i = 0; i < products.length; i += BATCH) {
    const chunk = products.slice(i, i + BATCH);
    const { rows } = await db.query<{ inserted: boolean; changed: boolean }>(
      `INSERT INTO products (tenant_id, external_id, title, description, brand, categories, tags, attributes, variants, price, compare_at_price,
                             currency, in_stock, stock_qty, rating, review_count, image_url, url, add_to_cart_url, search_text, content_hash)
       SELECT $1, x.external_id, x.title, x.description, x.brand, x.categories, x.tags, x.attributes, x.variants, x.price, x.compare_at_price,
              x.currency, x.in_stock, x.stock_qty, x.rating, x.review_count, x.image_url, x.url, x.add_to_cart_url, x.search_text, x.content_hash
       FROM jsonb_to_recordset($2::jsonb) AS x(external_id text, title text, description text, brand text, categories text[], tags text[],
            attributes jsonb, variants jsonb, price numeric, compare_at_price numeric, currency text, in_stock boolean, stock_qty int,
            rating numeric, review_count int, image_url text, url text, add_to_cart_url text, search_text text, content_hash text)
       ON CONFLICT (tenant_id, external_id) DO UPDATE SET
         title = EXCLUDED.title, description = EXCLUDED.description, brand = EXCLUDED.brand, categories = EXCLUDED.categories,
         tags = EXCLUDED.tags, attributes = EXCLUDED.attributes, variants = EXCLUDED.variants, price = EXCLUDED.price,
         compare_at_price = EXCLUDED.compare_at_price, currency = EXCLUDED.currency, in_stock = EXCLUDED.in_stock,
         stock_qty = EXCLUDED.stock_qty, rating = EXCLUDED.rating, review_count = EXCLUDED.review_count, image_url = EXCLUDED.image_url,
         url = EXCLUDED.url, add_to_cart_url = EXCLUDED.add_to_cart_url, search_text = EXCLUDED.search_text,
         -- Only re-embed when the searchable text actually changed (price/stock updates are free).
         embedding = CASE WHEN products.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN NULL ELSE products.embedding END,
         content_hash = EXCLUDED.content_hash, updated_at = now()
       RETURNING (xmax = 0) AS inserted, (embedding IS NULL) AS changed`,
      [
        tenantId,
        JSON.stringify(
          chunk.map((p) => ({
            external_id: p.externalId,
            title: p.title,
            description: p.description,
            brand: p.brand,
            categories: p.categories,
            tags: p.tags,
            attributes: p.attributes,
            variants: p.variants,
            price: p.price,
            compare_at_price: p.compareAtPrice,
            currency: p.currency,
            in_stock: p.inStock,
            stock_qty: p.stockQty,
            rating: p.rating,
            review_count: p.reviewCount,
            image_url: p.imageUrl,
            url: p.url,
            add_to_cart_url: p.addToCartUrl,
            search_text: p.searchText,
            content_hash: p.contentHash,
          })),
        ),
      ],
    );
    for (const r of rows) {
      if (r.inserted) created++;
      else if (r.changed) updated++;
      else unchanged++;
    }
  }
  return { created, updated, unchanged, total: existing.rows[0]!.n + created };
}

export async function deleteProducts(db: Db, externalIds: string[]) {
  const { rowCount } = await db.query('DELETE FROM products WHERE external_id = ANY($1)', [externalIds]);
  return rowCount ?? 0;
}

/** Embed every product that has no embedding yet (new, changed, or after a provider switch). */
export async function embedPendingProducts(tenantId: string, provider: ChatProvider, batchSize = 64): Promise<number> {
  let done = 0;
  for (;;) {
    const batch = await withTenant(tenantId, async (db) =>
      (await db.query<{ id: string; search_text: string }>('SELECT id, search_text FROM products WHERE embedding IS NULL ORDER BY id LIMIT $1', [batchSize])).rows,
    );
    if (!batch.length) return done;
    const { vectors, tokens } = await provider.embed(
      batch.map((b) => b.search_text.slice(0, 4000)),
      'document',
    );
    await withTenant(tenantId, async (db) => {
      for (let i = 0; i < batch.length; i++) {
        await db.query('UPDATE products SET embedding = $1, embedding_model = $2 WHERE id = $3', [pgvector.toSql(vectors[i]!), provider.embeddingModel, batch[i]!.id]);
      }
      if (tokens) await recordUsage(db, tenantId, { embeddingTokens: tokens, model: provider.embeddingModel });
    });
    done += batch.length;
  }
}

/** Clear embeddings made with another model so search vectors stay comparable. */
export async function invalidateEmbeddings(db: Db, embeddingModel: string) {
  const { rowCount } = await db.query('UPDATE products SET embedding = NULL WHERE embedding_model IS DISTINCT FROM $1', [embeddingModel]);
  return rowCount ?? 0;
}

export async function catalogStats(db: Db) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS products, count(*) FILTER (WHERE in_stock)::int AS in_stock,
            count(*) FILTER (WHERE embedding IS NULL)::int AS pending_embeddings, max(updated_at) AS last_updated
     FROM products`,
  );
  return rows[0];
}
