import { z } from 'zod';
import type { Db } from '../db/pool.js';
import type { ChatProvider, ToolSpec } from '../ai/types.js';
import { getProductsByIds, searchProducts, type MerchRule, type ProductHit, type SearchContext } from '../search/search.js';
import { MAX_CONSECUTIVE_QUESTIONS, NARROW_THRESHOLD } from './prompt.js';

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'search_products',
    description:
      "Hybrid keyword and semantic search over this store's catalog. Returns matching in-stock products, how many strongly match, facets (attribute values that split the results) and whether a counter-question is suggested.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the shopper is looking for, in plain words (product type, use, style). Leave out price and exclusions; use the filters for those.' },
        min_price: { type: 'number' },
        max_price: { type: 'number' },
        categories: { type: 'array', items: { type: 'string' }, description: 'Category or collection names to restrict to.' },
        brands: { type: 'array', items: { type: 'string' } },
        attributes: {
          type: 'object',
          description: 'Attribute filters, e.g. {"flavor": "vanilla"} or {"protein_g": {"min": 20}}.',
          additionalProperties: true,
        },
        exclude_terms: { type: 'array', items: { type: 'string' }, description: 'Ingredients or features the product must not have, e.g. ["soy"].' },
        limit: { type: 'number', description: 'Max products to return (default 8).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_product',
    description: 'Full details of one product: description, variants, stock, attributes.',
    parameters: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'] },
  },
  {
    name: 'compare_products',
    description: 'Side-by-side facts for 2 or 3 products, to explain how they differ.',
    parameters: { type: 'object', properties: { product_ids: { type: 'array', items: { type: 'string' } } }, required: ['product_ids'] },
  },
  {
    name: 'get_related',
    description: 'Complements and add-ons that go well with a product (for cross-sell and bundles).',
    parameters: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'] },
  },
  {
    name: 'get_policy',
    description: 'Store policy text for a topic such as shipping, returns or warranty.',
    parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
  },
  {
    name: 'show_products',
    description: 'Show product cards to the shopper (max 3). Each needs a short reason tied to what the shopper asked for. Only ids returned by a tool can be shown.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { product_id: { type: 'string' }, reason: { type: 'string' } },
            required: ['product_id', 'reason'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'ask_question',
    description: 'Ask the shopper one counter-question with 2 to 4 tappable answer options. Also write the question in your reply text.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
      required: ['question', 'options'],
    },
  },
];

const num = z.coerce.number().finite().nonnegative();
const SearchInput = z.object({
  query: z.string().max(300).default(''),
  min_price: num.optional(),
  max_price: num.optional(),
  categories: z.array(z.string().max(80)).max(10).optional(),
  brands: z.array(z.string().max(80)).max(10).optional(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.object({ min: num.optional(), max: num.optional(), equals: z.union([z.string(), z.number()]).optional() })])).optional(),
  exclude_terms: z.array(z.string().max(40)).max(10).optional(),
  limit: z.coerce.number().int().min(1).max(12).optional(),
});
const IdInput = z.object({ product_id: z.string().min(1).max(200) });
const CompareInput = z.object({ product_ids: z.array(z.string()).min(2).max(3) });
const PolicyInput = z.object({ topic: z.string().max(60) });
const ShowInput = z.object({ items: z.array(z.object({ product_id: z.string(), reason: z.string().max(300) })).min(1).max(6) });
const AskInput = z.object({ question: z.string().min(3).max(300), options: z.array(z.string().max(60)).max(6).default([]) });

export interface ProductCard {
  id: string;
  title: string;
  brand: string | null;
  price: number | null;
  compareAtPrice: number | null;
  currency: string;
  inStock: boolean;
  rating: number | null;
  reviewCount: number | null;
  imageUrl: string | null;
  url: string | null;
  addToCartUrl: string | null;
  reason: string;
}

/** Mutable state for one shopper turn; persisted on the conversation afterwards. */
export interface TurnState {
  groundedIds: Set<string>;
  consecutiveQuestions: number;
  cards: ProductCard[];
  question: { question: string; options: string[] } | null;
  searches: Array<{ query: string; total: number; candidates: number }>;
  guardRejections: Array<{ id: string; reason: string }>;
}

function compact(p: ProductHit) {
  return {
    id: p.id,
    title: p.title,
    brand: p.brand,
    price: p.price,
    compare_at_price: p.compareAtPrice,
    in_stock: p.inStock,
    rating: p.rating,
    review_count: p.reviewCount,
    categories: p.categories.slice(0, 4),
    attributes: p.attributes,
    summary: p.summary,
  };
}

export interface ToolDeps {
  db: Db;
  ctx: SearchContext;
  provider: ChatProvider;
  state: TurnState;
  emit: (event: string, data: unknown) => void;
}

function isExcludedByRule(row: { external_id: string; brand: string | null; categories: string[]; tags: string[] }, rules: MerchRule[]) {
  return rules.some((r) => {
    if (r.action !== 'exclude') return false;
    const v = r.match_value.toLowerCase();
    return (
      (r.match_field === 'product' && row.external_id.toLowerCase() === v) ||
      (r.match_field === 'brand' && (row.brand ?? '').toLowerCase() === v) ||
      (r.match_field === 'category' && row.categories.some((c) => c.toLowerCase() === v)) ||
      (r.match_field === 'tag' && row.tags.some((c) => c.toLowerCase() === v))
    );
  });
}

export function makeToolExecutor(deps: ToolDeps) {
  const { db, ctx, provider, state, emit } = deps;

  return async function execute(name: string, rawInput: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'search_products': {
        const input = SearchInput.parse(rawInput);
        let queryVector: number[] | null = null;
        if (input.query.trim()) {
          try {
            queryVector = (await provider.embed([input.query], 'query')).vectors[0] ?? null;
          } catch {
            queryVector = null; // keyword search still works without the vector leg
          }
        }
        const attributes: Record<string, any> = {};
        for (const [k, v] of Object.entries(input.attributes ?? {})) attributes[k] = v;
        const res = await searchProducts(
          db,
          {
            query: input.query,
            limit: input.limit ?? 8,
            queryVector,
            embeddingModel: provider.embeddingModel,
            filters: { minPrice: input.min_price, maxPrice: input.max_price, categories: input.categories, brands: input.brands, attributes, excludeTerms: input.exclude_terms },
          },
          ctx,
        );
        for (const p of res.items) state.groundedIds.add(p.id);
        state.searches.push({ query: input.query, total: res.total, candidates: res.candidates });
        const mustRecommend = state.consecutiveQuestions >= MAX_CONSECUTIVE_QUESTIONS;
        return {
          total_matches: res.total,
          partial_matches: res.candidates,
          products: res.items.map(compact),
          facets: res.facets,
          narrowing_suggested: !mustRecommend && res.total > NARROW_THRESHOLD,
          must_recommend: mustRecommend,
          note: res.items.length === 0 ? 'No products matched. Try fewer filters or other words, and tell the shopper which requirement you relaxed.' : res.total === 0 ? 'No product matches every term; these are partial matches.' : undefined,
        };
      }
      case 'get_product': {
        const { product_id } = IdInput.parse(rawInput);
        const [p] = await getProductsByIds(db, [product_id]);
        if (!p || isExcludedByRule(p, ctx.rules)) return { error: `No product with id ${product_id}` };
        state.groundedIds.add(p.external_id);
        return {
          id: p.external_id,
          title: p.title,
          brand: p.brand,
          price: p.price,
          compare_at_price: p.compare_at_price,
          in_stock: p.in_stock,
          stock_qty: p.stock_qty,
          rating: p.rating,
          review_count: p.review_count,
          categories: p.categories,
          attributes: p.attributes,
          variants: (p.variants ?? []).slice(0, 20),
          description: String(p.description ?? '').slice(0, 1500),
        };
      }
      case 'compare_products': {
        const { product_ids } = CompareInput.parse(rawInput);
        const rows = (await getProductsByIds(db, product_ids)).filter((p) => !isExcludedByRule(p, ctx.rules));
        for (const p of rows) state.groundedIds.add(p.external_id);
        return {
          products: rows.map((p) => ({ id: p.external_id, title: p.title, brand: p.brand, price: p.price, in_stock: p.in_stock, rating: p.rating, review_count: p.review_count, attributes: p.attributes, summary: String(p.description ?? '').slice(0, 300) })),
          missing: product_ids.filter((id) => !rows.some((r) => r.external_id === id)),
        };
      }
      case 'get_related': {
        const { product_id } = IdInput.parse(rawInput);
        const { rows } = await db.query(
          `WITH a AS (SELECT categories, tags FROM products WHERE external_id = $1)
           SELECT p.external_id, p.title, p.brand, p.price::float AS price, p.in_stock, p.rating::float AS rating, p.review_count,
                  p.categories, p.tags, p.attributes, left(p.description, 160) AS summary
           FROM products p, a
           WHERE p.external_id <> $1 AND p.in_stock AND (p.tags && a.tags OR p.categories && a.categories)
           -- Prefer complements: shares a tag but sits in a different primary category (shaker for a protein powder).
           ORDER BY (p.tags && a.tags AND p.categories[1] IS DISTINCT FROM a.categories[1]) DESC,
                    cardinality(ARRAY(SELECT unnest(p.tags) INTERSECT SELECT unnest(a.tags))) DESC,
                    p.rating DESC NULLS LAST
           LIMIT 6`,
          [product_id],
        );
        const products = rows.filter((r) => !isExcludedByRule(r, ctx.rules)).slice(0, 3);
        for (const p of products) state.groundedIds.add(p.external_id);
        return {
          products: products.map((p) => ({ id: p.external_id, title: p.title, brand: p.brand, price: p.price, rating: p.rating, categories: p.categories, summary: p.summary })),
        };
      }
      case 'get_policy': {
        const { topic } = PolicyInput.parse(rawInput);
        const { rows } = await db.query('SELECT topic, content FROM policies WHERE lower(topic) = lower($1) OR lower(topic) LIKE lower($2) LIMIT 1', [topic, `%${topic}%`]);
        return rows[0] ? { topic: rows[0].topic, content: rows[0].content } : { topic, content: null, note: 'No policy on file for this topic.' };
      }
      case 'show_products': {
        const { items } = ShowInput.parse(rawInput);
        const result = await guardProducts(db, ctx, state, items);
        if (result.cards.length) emit('products', { items: result.cards });
        return { shown: result.cards.map((c) => c.id), rejected: result.rejected };
      }
      case 'ask_question': {
        const { question, options } = AskInput.parse(rawInput);
        if (state.consecutiveQuestions >= MAX_CONSECUTIVE_QUESTIONS) {
          return { error: 'Question limit reached. Recommend the best products now with show_products.' };
        }
        if (state.question) return { error: 'Only one question per reply.' };
        state.question = { question, options: options.slice(0, 4) };
        emit('question', state.question);
        return { ok: true };
      }
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  };
}

/**
 * The guard: every product the AI wants to show must exist in this tenant's catalog, have been
 * returned by a tool in this conversation, be in stock, and not be excluded by a merchant rule.
 * Cards are built from the database, never from model text, so prices and names are always real.
 */
export async function guardProducts(db: Db, ctx: SearchContext, state: TurnState, items: Array<{ product_id: string; reason: string }>) {
  const rejected: Array<{ id: string; reason: string }> = [];
  const wanted = items.filter((i, idx) => items.findIndex((j) => j.product_id === i.product_id) === idx);
  const rows = await getProductsByIds(
    db,
    wanted.map((i) => i.product_id),
  );
  const byId = new Map(rows.map((r) => [r.external_id, r]));
  const cards: ProductCard[] = [];
  for (const item of wanted) {
    const p = byId.get(item.product_id);
    let why: string | null = null;
    if (!p) why = 'not in catalog';
    else if (!state.groundedIds.has(item.product_id)) why = 'not returned by a search tool in this conversation';
    else if (!p.in_stock) why = 'out of stock';
    else if (isExcludedByRule(p, ctx.rules)) why = 'excluded by the store';
    else if (state.cards.length + cards.length >= 3) why = 'card limit of 3 reached';
    if (why || !p) {
      rejected.push({ id: item.product_id, reason: why ?? 'unknown' });
      continue;
    }
    cards.push({
      id: p.external_id,
      title: p.title,
      brand: p.brand,
      price: p.price,
      compareAtPrice: p.compare_at_price,
      currency: p.currency,
      inStock: p.in_stock,
      rating: p.rating,
      reviewCount: p.review_count,
      imageUrl: p.image_url,
      url: p.url,
      addToCartUrl: p.add_to_cart_url,
      reason: item.reason.slice(0, 200),
    });
  }
  state.cards.push(...cards);
  state.guardRejections.push(...rejected);
  return { cards, rejected };
}
