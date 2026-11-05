import { createHash } from 'node:crypto';
import { parse as parseCsv } from 'csv-parse/sync';

/** The one product shape every platform connector and importer maps into. */
export interface NormalizedProduct {
  externalId: string;
  title: string;
  description: string;
  brand: string | null;
  categories: string[];
  tags: string[];
  attributes: Record<string, string | number | boolean>;
  variants: Array<Record<string, unknown>>;
  price: number | null;
  compareAtPrice: number | null;
  currency: string;
  inStock: boolean;
  stockQty: number | null;
  rating: number | null;
  reviewCount: number | null;
  imageUrl: string | null;
  url: string | null;
  addToCartUrl: string | null;
  searchText: string;
  contentHash: string;
}

export interface NormalizeResult {
  products: NormalizedProduct[];
  errors: Array<{ row: number; message: string }>;
}

const ALIASES: Record<string, string[]> = {
  externalId: ['external_id', 'id', 'sku', 'product_id', 'handle'],
  title: ['title', 'name', 'product_name'],
  description: ['description', 'body_html', 'short_description', 'body'],
  brand: ['brand', 'vendor', 'manufacturer'],
  categories: ['categories', 'category', 'product_type', 'type', 'collections'],
  tags: ['tags', 'keywords'],
  price: ['price', 'sale_price', 'variant_price'],
  compareAtPrice: ['compare_at_price', 'regular_price', 'list_price', 'msrp'],
  currency: ['currency'],
  inStock: ['in_stock', 'stock_status', 'available', 'availability'],
  stockQty: ['stock_qty', 'stock_quantity', 'inventory_quantity', 'quantity', 'stock'],
  rating: ['rating', 'average_rating'],
  reviewCount: ['review_count', 'rating_count', 'reviews'],
  imageUrl: ['image_url', 'image', 'image_src', 'thumbnail'],
  url: ['url', 'permalink', 'link', 'product_url'],
  addToCartUrl: ['add_to_cart_url'],
  attributes: ['attributes'],
  variants: ['variants'],
};

const KNOWN = new Set(Object.values(ALIASES).flat());

function pick(raw: Record<string, unknown>, field: keyof typeof ALIASES): unknown {
  for (const k of ALIASES[field]!) {
    const v = raw[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

export function stripHtml(s: string) {
  return s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function toList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' && x && 'name' in x ? String((x as any).name) : String(x))).map((s) => s.trim()).filter(Boolean);
  return String(v)
    .split(/[|,;>]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toNumber(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function toBool(v: unknown, fallback = true): boolean {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase().trim();
  if (['true', '1', 'yes', 'y', 'instock', 'in stock', 'in_stock', 'available'].includes(s)) return true;
  if (['false', '0', 'no', 'n', 'outofstock', 'out of stock', 'out_of_stock', 'unavailable', 'sold out'].includes(s)) return false;
  return fallback;
}

function attrValue(v: unknown): string | number | boolean {
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = String(v).trim();
  const n = Number(s);
  return s !== '' && Number.isFinite(n) ? n : s;
}

export function normalizeOne(raw: Record<string, unknown>): NormalizedProduct {
  const externalId = pick(raw, 'externalId');
  const title = pick(raw, 'title');
  if (!externalId) throw new Error('missing id/sku');
  if (!title) throw new Error('missing title/name');

  const attributes: Record<string, string | number | boolean> = {};
  const rawAttrs = pick(raw, 'attributes');
  if (rawAttrs && typeof rawAttrs === 'object' && !Array.isArray(rawAttrs)) {
    for (const [k, v] of Object.entries(rawAttrs)) if (v !== null && v !== '') attributes[k.toLowerCase()] = attrValue(v);
  } else if (Array.isArray(rawAttrs)) {
    // WooCommerce style: [{name, options:[...]}] or [{name, value}]
    for (const a of rawAttrs as any[]) {
      if (!a?.name) continue;
      const v = a.value ?? (Array.isArray(a.options) ? a.options.join(', ') : a.option);
      if (v !== undefined) attributes[String(a.name).toLowerCase()] = attrValue(v);
    }
  }
  // CSV style: attr:flavor, attribute_flavor, attribute:flavor
  for (const [k, v] of Object.entries(raw)) {
    const m = /^(?:attr|attribute)[:_](.+)$/i.exec(k);
    if (m && v !== '' && v !== null && v !== undefined) attributes[m[1]!.toLowerCase().trim()] = attrValue(v);
  }

  const description = stripHtml(String(pick(raw, 'description') ?? ''));
  const brand = pick(raw, 'brand');
  const categories = toList(pick(raw, 'categories'));
  const tags = toList(pick(raw, 'tags'));
  const stockQty = toNumber(pick(raw, 'stockQty'));
  const inStockRaw = pick(raw, 'inStock');
  const inStock = toBool(inStockRaw, stockQty === null ? true : stockQty > 0);
  const variantsRaw = pick(raw, 'variants');

  const p: Omit<NormalizedProduct, 'searchText' | 'contentHash'> = {
    externalId: String(externalId).trim(),
    title: stripHtml(String(title)),
    description,
    brand: brand ? String(brand).trim() : null,
    categories,
    tags,
    attributes,
    variants: Array.isArray(variantsRaw) ? (variantsRaw as Array<Record<string, unknown>>) : [],
    price: toNumber(pick(raw, 'price')),
    compareAtPrice: toNumber(pick(raw, 'compareAtPrice')),
    currency: String(pick(raw, 'currency') ?? 'USD').toUpperCase(),
    inStock,
    stockQty: stockQty === null ? null : Math.round(stockQty),
    rating: toNumber(pick(raw, 'rating')),
    reviewCount: toNumber(pick(raw, 'reviewCount')),
    imageUrl: (pick(raw, 'imageUrl') as string | undefined) ?? null,
    url: (pick(raw, 'url') as string | undefined) ?? null,
    addToCartUrl: (pick(raw, 'addToCartUrl') as string | undefined) ?? null,
  };
  if (Array.isArray(raw.images) && !p.imageUrl) {
    const first = (raw.images as any[])[0];
    p.imageUrl = typeof first === 'string' ? first : (first?.src ?? null);
  }
  // "waterproof: no" must not match a search for "waterproof", so negative values stay out of the text.
  const attrText = Object.entries(attributes)
    .filter(([, v]) => v !== false && !/^(no|false|none|n\/a)$/i.test(String(v)))
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
    .join('. ');
  const searchText = [p.title, p.brand, p.categories.join(', '), p.tags.join(', '), attrText, p.description].filter(Boolean).join('\n').slice(0, 8000);
  const contentHash = createHash('sha256').update(searchText).digest('hex').slice(0, 32);
  // Unknown extra columns are kept as attributes only when they look like simple values.
  for (const [k, v] of Object.entries(raw)) {
    if (KNOWN.has(k) || /^(?:attr|attribute)[:_]/i.test(k) || k === 'images') continue;
    if ((typeof v === 'string' && v.length > 0 && v.length < 60) || typeof v === 'number' || typeof v === 'boolean') {
      if (!(k.toLowerCase() in attributes)) attributes[k.toLowerCase()] = attrValue(v);
    }
  }
  return { ...p, attributes, searchText, contentHash };
}

export function normalizeMany(rows: Array<Record<string, unknown>>): NormalizeResult {
  const products: NormalizedProduct[] = [];
  const errors: NormalizeResult['errors'] = [];
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    try {
      const p = normalizeOne(row);
      if (seen.has(p.externalId)) throw new Error(`duplicate id ${p.externalId}`);
      seen.add(p.externalId);
      products.push(p);
    } catch (e) {
      errors.push({ row: i + 1, message: (e as Error).message });
    }
  });
  return { products, errors };
}

/** Parse an uploaded file body (CSV or JSON) into raw rows. */
export function parseCatalogFile(body: string, format: 'csv' | 'json' | 'auto' = 'auto'): Array<Record<string, unknown>> {
  const trimmed = body.trimStart();
  const fmt = format === 'auto' ? (trimmed.startsWith('[') || trimmed.startsWith('{') ? 'json' : 'csv') : format;
  if (fmt === 'json') {
    const data = JSON.parse(body);
    const rows = Array.isArray(data) ? data : Array.isArray(data?.products) ? data.products : null;
    if (!rows) throw new Error('JSON must be an array of products or {"products": [...]}');
    return rows;
  }
  return parseCsv(body, { columns: (h: string[]) => h.map((c) => c.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
}
