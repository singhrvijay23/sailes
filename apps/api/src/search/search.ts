import pgvector from 'pgvector';
import type { Db } from '../db/pool.js';
import { HASH_EMBED_MODEL, stem, tokenize } from '../ai/hashEmbed.js';

export interface AttributeFilter {
  equals?: string | number | boolean;
  min?: number;
  max?: number;
}

export interface SearchFilters {
  minPrice?: number;
  maxPrice?: number;
  categories?: string[];
  brands?: string[];
  attributes?: Record<string, string | number | boolean | AttributeFilter>;
  /** Words the product must NOT contain, e.g. "soy" for "no soy". "soy-free" products still pass. */
  excludeTerms?: string[];
  inStockOnly?: boolean;
}

export interface SearchParams {
  query: string;
  filters?: SearchFilters;
  limit?: number;
  queryVector?: number[] | null;
  embeddingModel?: string | null;
}

export interface ProductHit {
  id: string; // external id, the id the AI and widget use
  title: string;
  brand: string | null;
  price: number | null;
  compareAtPrice: number | null;
  currency: string;
  inStock: boolean;
  rating: number | null;
  reviewCount: number | null;
  categories: string[];
  tags: string[];
  attributes: Record<string, unknown>;
  summary: string;
  imageUrl: string | null;
  url: string | null;
  addToCartUrl: string | null;
  score: number;
}

export interface Facet {
  attribute: string;
  values: Array<{ value: string; count: number }>;
}

export interface SearchResult {
  /** Products matching every term of the query (and all filters). */
  total: number;
  /** All candidates found by any search leg, including partial and fuzzy matches. */
  candidates: number;
  items: ProductHit[];
  facets: Facet[];
  expandedTerms: string[];
}

export interface MerchRule {
  action: 'boost' | 'bury' | 'exclude';
  match_field: 'product' | 'category' | 'tag' | 'brand';
  match_value: string;
  weight: number;
}

export interface SearchContext {
  rules: MerchRule[];
  synonyms: Map<string, string[]>;
}

export async function loadSearchContext(db: Db): Promise<SearchContext> {
  // Sequential on purpose: a pg client runs one query at a time.
  const rules = await db.query<MerchRule>('SELECT action, match_field, match_value, weight::float AS weight FROM merch_rules');
  const syn = await db.query<{ term: string; synonyms: string[] }>('SELECT term, synonyms FROM synonyms');
  const synonyms = new Map<string, string[]>();
  for (const r of syn.rows) {
    const group = [r.term, ...r.synonyms].map((s) => s.toLowerCase().trim()).filter(Boolean);
    // Synonyms are two-way: every member of a group expands to the others.
    for (const g of group) synonyms.set(g, [...new Set([...(synonyms.get(g) ?? []), ...group.filter((x) => x !== g)])]);
  }
  return { rules: rules.rows, synonyms };
}

/** Words that describe the request rather than the product; they should not have to match. */
const NOISE = new Set(['want', 'need', 'looking', 'look', 'find', 'show', 'buy', 'get', 'some', 'something', 'any', 'anything', 'good', 'best', 'great', 'nice', 'recommend', 'suggest', 'please', 'under', 'over', 'below', 'above', 'less', 'more', 'than', 'cheap', 'around', 'about', 'like', 'would', 'could', 'can', 'have', 'has', 'gift', 'present', 'usd', 'dollar', 'price', 'budget']);

export function queryTerms(query: string, synonyms: Map<string, string[]>) {
  const raw = query
    .toLowerCase()
    .replace(/\$?\d+(\.\d+)?/g, ' ')
    .split(/[^a-z0-9\-]+/)
    .filter((t) => t.length > 1);
  // Words are left unstemmed here: Postgres applies its own English stemmer in to_tsquery.
  const base = tokenize(raw.join(' '), false).filter((t) => !NOISE.has(t) && !NOISE.has(stem(t)));
  const expanded = new Set<string>(base);
  const lowered = query.toLowerCase();
  for (const [term, syns] of synonyms) {
    if (new RegExp(`\\b${term.replace(/[^a-z0-9 ]/g, '')}`).test(lowered)) for (const s of syns) for (const t of tokenize(s, false)) expanded.add(t);
  }
  return { base, expanded: [...expanded] };
}

function tsquery(terms: string[], op: '|' | '&') {
  // Terms are already stripped to [a-z0-9]; prefix match helps with plurals and partial words.
  return terms.map((t) => `${t.replace(/[^a-z0-9]/g, '')}:*`).filter((t) => t.length > 2).join(` ${op} `);
}

const EXCLUDE_SQL = (i: number) =>
  `NOT (p.search_text ~* ('\\m' || $${i}) AND p.search_text !~* ('(' || $${i} || '[- ]?free|no ' || $${i} || '|without ' || $${i} || ')'))`;

function buildFilters(filters: SearchFilters, rules: MerchRule[], params: unknown[]) {
  const where: string[] = [];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (filters.inStockOnly !== false) where.push('p.in_stock');
  if (filters.minPrice != null) where.push(`p.price >= ${add(filters.minPrice)}`);
  if (filters.maxPrice != null) where.push(`p.price <= ${add(filters.maxPrice)}`);
  if (filters.categories?.length) {
    const ph = add(filters.categories.map((c) => `%${c.toLowerCase()}%`));
    where.push(`EXISTS (SELECT 1 FROM unnest(p.categories || p.tags) c WHERE lower(c) LIKE ANY(${ph}))`);
  }
  if (filters.brands?.length) where.push(`lower(p.brand) = ANY(${add(filters.brands.map((b) => b.toLowerCase()))})`);
  for (const [key, f] of Object.entries(filters.attributes ?? {})) {
    const k = add(key.toLowerCase());
    const spec: AttributeFilter = typeof f === 'object' && f !== null ? f : { equals: f };
    if (spec.equals !== undefined) where.push(`p.attributes->>${k} ILIKE ${add(`%${String(spec.equals)}%`)}`);
    const num = `(CASE WHEN p.attributes->>${k} ~ '^-?[0-9.]+$' THEN (p.attributes->>${k})::numeric END)`;
    if (spec.min !== undefined) where.push(`${num} >= ${add(spec.min)}`);
    if (spec.max !== undefined) where.push(`${num} <= ${add(spec.max)}`);
  }
  for (const term of filters.excludeTerms ?? []) {
    const clean = term.toLowerCase().replace(/[^a-z0-9 \-]/g, '').trim();
    if (!clean) continue;
    params.push(clean);
    where.push(EXCLUDE_SQL(params.length));
  }
  for (const r of rules.filter((r) => r.action === 'exclude')) {
    const v = add(r.match_value.toLowerCase());
    if (r.match_field === 'product') where.push(`lower(p.external_id) <> ${v}`);
    if (r.match_field === 'brand') where.push(`coalesce(lower(p.brand), '') <> ${v}`);
    if (r.match_field === 'category') where.push(`NOT (${v} = ANY(SELECT lower(c) FROM unnest(p.categories) c))`);
    if (r.match_field === 'tag') where.push(`NOT (${v} = ANY(SELECT lower(c) FROM unnest(p.tags) c))`);
  }
  return where.length ? where.join(' AND ') : 'true';
}

function ruleMultiplier(hit: ProductHit, rules: MerchRule[]) {
  let m = 1;
  for (const r of rules) {
    if (r.action === 'exclude') continue;
    const v = r.match_value.toLowerCase();
    const matches =
      (r.match_field === 'product' && hit.id.toLowerCase() === v) ||
      (r.match_field === 'brand' && (hit.brand ?? '').toLowerCase() === v) ||
      (r.match_field === 'category' && hit.categories.some((c) => c.toLowerCase() === v)) ||
      (r.match_field === 'tag' && hit.tags.some((c) => c.toLowerCase() === v));
    if (!matches) continue;
    const w = Math.max(1, Number(r.weight) || 1.5);
    m *= r.action === 'boost' ? w : 1 / w;
  }
  return m;
}

/** Vector distance under which a semantic match counts as a real match (not just "nearest"). */
function vectorThreshold(model?: string | null) {
  return model === HASH_EMBED_MODEL ? 0.8 : 0.62;
}

const RRF_K = 60;

export async function searchProducts(db: Db, params: SearchParams, ctx: SearchContext): Promise<SearchResult> {
  const limit = Math.min(Math.max(params.limit ?? 8, 1), 24);
  const filters = params.filters ?? {};
  const { base, expanded } = queryTerms(params.query ?? '', ctx.synonyms);
  const sqlParams: unknown[] = [];
  const where = buildFilters(filters, ctx.rules, sqlParams);

  const legs: string[] = [];
  let strongCountSql: string;
  let coverageSql = '1.0';
  const hasText = base.length > 0;
  if (hasText) {
    sqlParams.push(tsquery(expanded, '|'));
    const orQ = `$${sqlParams.length}`;
    // A product "strongly" matches when every original term (or one of its synonyms) is present.
    const andGroups = base.map((t) => {
      const syns = [...(ctx.synonyms.get(t) ?? ctx.synonyms.get(stem(t)) ?? [])].flatMap((s) => tokenize(s, false));
      return '(' + tsquery([t, ...syns], '|') + ')';
    });
    sqlParams.push(andGroups.join(' & '));
    const andQ = `$${sqlParams.length}`;
    sqlParams.push(base.join(' '));
    const rawQ = `$${sqlParams.length}`;
    legs.push(`fts AS (SELECT id, row_number() OVER (ORDER BY ts_rank_cd(search_tsv, to_tsquery('english', ${orQ})) DESC) AS r, 1.0::float AS w
               FROM base WHERE search_tsv @@ to_tsquery('english', ${orQ})
               ORDER BY ts_rank_cd(search_tsv, to_tsquery('english', ${orQ})) DESC LIMIT 100)`);
    legs.push(`trg AS (SELECT id, row_number() OVER (ORDER BY word_similarity(${rawQ}, lower(title)) DESC) AS r, 0.6::float AS w
               FROM base WHERE word_similarity(${rawQ}, lower(title)) > 0.45
               ORDER BY word_similarity(${rawQ}, lower(title)) DESC LIMIT 50)`);
    if (params.queryVector) {
      sqlParams.push(pgvector.toSql(params.queryVector));
      const vq = `$${sqlParams.length}`;
      sqlParams.push(vectorThreshold(params.embeddingModel));
      const th = `$${sqlParams.length}`;
      sqlParams.push(params.embeddingModel ?? HASH_EMBED_MODEL);
      const em = `$${sqlParams.length}`;
      // Only compare vectors made by the same embedding model (matters while a re-index is running).
      legs.push(`vec AS (SELECT id, row_number() OVER (ORDER BY embedding <=> ${vq}::vector) AS r, 0.8::float AS w
                 FROM base WHERE embedding IS NOT NULL AND embedding_model = ${em} AND (embedding <=> ${vq}::vector) < ${th}
                 ORDER BY embedding <=> ${vq}::vector LIMIT 50)`);
    }
    strongCountSql = `(SELECT count(*) FROM base WHERE search_tsv @@ to_tsquery('english', ${andQ})
                       OR word_similarity(${rawQ}, lower(title)) > 0.6)`;
    // Share of the shopper's terms each product covers: products that match everything rank first.
    const groupParams = andGroups.map((g) => {
      sqlParams.push(g);
      return `$${sqlParams.length}`;
    });
    coverageSql = `((${groupParams.map((g) => `(CASE WHEN b.search_tsv @@ to_tsquery('english', ${g}) THEN 1 ELSE 0 END)`).join(' + ')})::float / ${groupParams.length})`;
  } else {
    legs.push(`browse AS (SELECT id, row_number() OVER (ORDER BY coalesce(rating, 0) * ln(2 + coalesce(review_count, 0)) DESC, title) AS r, 1.0::float AS w
               FROM base ORDER BY coalesce(rating, 0) * ln(2 + coalesce(review_count, 0)) DESC, title LIMIT 100)`);
    strongCountSql = '(SELECT count(*) FROM base)';
  }
  const legNames = legs.map((l) => l.slice(0, l.indexOf(' ')));
  const sql = `
    WITH base AS (SELECT p.* FROM products p WHERE ${where}),
    ${legs.join(',\n')},
    fused AS (
      SELECT id, sum(w / (${RRF_K} + r)) AS score FROM (${legNames.map((n) => `SELECT id, r, w FROM ${n}`).join(' UNION ALL ')}) u GROUP BY id
    )
    SELECT b.external_id, b.title, b.brand, b.price::float AS price, b.compare_at_price::float AS compare_at_price, b.currency,
           b.in_stock, b.rating::float AS rating, b.review_count, b.categories, b.tags, b.attributes,
           left(b.description, 220) AS summary, b.image_url, b.url, b.add_to_cart_url,
           f.score * (0.25 + ${coverageSql}) AS score,
           ${strongCountSql} AS strong_total
    FROM fused f JOIN base b ON b.id = f.id
    ORDER BY score DESC
    LIMIT 80`;
  const { rows } = await db.query(sql, sqlParams);

  const hits: ProductHit[] = rows.map((r) => ({
    id: r.external_id,
    title: r.title,
    brand: r.brand,
    price: r.price,
    compareAtPrice: r.compare_at_price,
    currency: r.currency,
    inStock: r.in_stock,
    rating: r.rating,
    reviewCount: r.review_count,
    categories: r.categories,
    tags: r.tags,
    attributes: r.attributes,
    summary: r.summary,
    imageUrl: r.image_url,
    url: r.url,
    addToCartUrl: r.add_to_cart_url,
    score: Number(r.score),
  }));
  for (const h of hits) h.score *= ruleMultiplier(h, ctx.rules);
  hits.sort((a, b) => b.score - a.score);
  const strong = rows.length ? Number(rows[0].strong_total) : 0;
  return { total: strong, candidates: hits.length, items: hits.slice(0, limit), facets: computeFacets(hits.slice(0, 60)), expandedTerms: expanded };
}

/** Attributes whose values split the result set best, used to choose a good counter-question. */
export function computeFacets(hits: ProductHit[]): Facet[] {
  if (hits.length < 2) return [];
  const counts = new Map<string, Map<string, number>>();
  const bump = (attr: string, value: string) => {
    if (!value) return;
    const m = counts.get(attr) ?? new Map<string, number>();
    m.set(value, (m.get(value) ?? 0) + 1);
    counts.set(attr, m);
  };
  for (const h of hits) {
    for (const [k, v] of Object.entries(h.attributes)) {
      if (typeof v === 'string' && v.length <= 40) for (const part of v.split(/\s*,\s*/)) bump(k, part.toLowerCase());
      else if (typeof v === 'boolean') bump(k, v ? 'yes' : 'no');
    }
    if (h.brand) bump('brand', h.brand);
    for (const c of h.categories.slice(0, 3)) bump('category', c);
    if (h.price != null) bump('price', h.price < 25 ? 'under $25' : h.price < 50 ? '$25 to $50' : h.price < 100 ? '$50 to $100' : '$100 and up');
  }
  const n = hits.length;
  const facets: Array<Facet & { score: number }> = [];
  for (const [attribute, m] of counts) {
    if (m.size < 2 || m.size > 8) continue;
    const covered = [...m.values()].reduce((a, b) => a + b, 0);
    if (covered < n * 0.5) continue;
    // Entropy rewards attributes whose values divide the results evenly.
    let entropy = 0;
    for (const c of m.values()) {
      const p = c / covered;
      entropy -= p * Math.log2(p);
    }
    const values = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
    facets.push({ attribute, values, score: entropy * (covered / n) });
  }
  return facets
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ attribute, values }) => ({ attribute, values }));
}

export async function getProductsByIds(db: Db, ids: string[]) {
  if (!ids.length) return [];
  const { rows } = await db.query(
    `SELECT external_id, title, brand, price::float AS price, compare_at_price::float AS compare_at_price, currency, in_stock, stock_qty,
            rating::float AS rating, review_count, categories, tags, attributes, description, image_url, url, add_to_cart_url, variants
     FROM products WHERE external_id = ANY($1)`,
    [ids],
  );
  return rows;
}
