/** Shopify Admin GraphQL shapes → SAILES product and policy payloads (see docs/connector-contract.md). */

export const PRODUCT_FIELDS = `
  fragment SailesProduct on Product {
    id
    legacyResourceId
    title
    handle
    descriptionHtml
    vendor
    productType
    tags
    status
    onlineStoreUrl
    totalInventory
    tracksInventory
    category { name }
    featuredMedia { preview { image { url } } }
    collections(first: 5) { nodes { title } }
    variants(first: 20) {
      nodes { legacyResourceId title price compareAtPrice availableForSale inventoryQuantity selectedOptions { name value } }
    }
  }`;

/** 25 products per page keeps the query under Shopify's 1,000-point cost limit. */
export const PRODUCTS_PAGE = `
  query SailesProducts($cursor: String) {
    shop { currencyCode }
    products(first: 25, after: $cursor, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes { ...SailesProduct }
    }
  }
  ${PRODUCT_FIELDS}`;

export const PRODUCT_BY_ID = `
  query SailesProduct($id: ID!) {
    shop { currencyCode }
    product(id: $id) { ...SailesProduct }
  }
  ${PRODUCT_FIELDS}`;

export const PRODUCT_FOR_INVENTORY_ITEM = `
  query SailesInventoryItem($id: ID!) {
    inventoryItem(id: $id) { variant { product { id } } }
  }`;

export const SHOP_INFO = `
  query SailesShop {
    shop { name currencyCode myshopifyDomain primaryDomain { url } shopPolicies { type body } }
    currentAppInstallation { id }
  }`;

export const SET_METAFIELDS = `
  mutation SailesMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }`;

export interface GqlVariant {
  legacyResourceId: string;
  title: string;
  price: string;
  compareAtPrice: string | null;
  availableForSale: boolean;
  inventoryQuantity: number | null;
  selectedOptions: { name: string; value: string }[];
}

export interface GqlProduct {
  id: string;
  legacyResourceId: string;
  title: string;
  handle: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  status: 'ACTIVE' | 'ARCHIVED' | 'DRAFT' | 'UNLISTED' | string;
  onlineStoreUrl: string | null;
  totalInventory: number | null;
  tracksInventory: boolean;
  category: { name: string } | null;
  featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  collections: { nodes: { title: string }[] };
  variants: { nodes: GqlVariant[] };
}

export interface SailesProduct {
  id: string;
  title: string;
  description: string;
  price: number;
  compare_at_price?: number;
  currency: string;
  in_stock: boolean;
  stock_qty?: number;
  brand?: string;
  categories: string[];
  tags: string[];
  attributes: Record<string, string>;
  variants: { id: string; title: string; price: number; in_stock: boolean; attributes: Record<string, string> }[];
  image_url?: string;
  url: string;
  add_to_cart_url?: string;
}

export const gid = (type: string, id: string | number) => `gid://shopify/${type}/${id}`;

const isDefaultOption = (o: { name: string; value: string }) => o.name === 'Title' && o.value === 'Default Title';

/**
 * Returns null when the product must not be recommended: not active, or not published to the
 * Online Store (no storefront URL). The caller deletes it from SAILES.
 */
export function toSailesProduct(p: GqlProduct, currency: string): SailesProduct | null {
  if (p.status !== 'ACTIVE' || !p.onlineStoreUrl) return null;
  const variants = p.variants.nodes;
  if (!variants.length) return null;
  const available = variants.filter((v) => v.availableForSale);
  const pool = available.length ? available : variants;
  const cheapest = pool.reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a));
  const price = Number(cheapest.price);
  const compare = cheapest.compareAtPrice ? Number(cheapest.compareAtPrice) : 0;

  const attributes: Record<string, string> = {};
  const values = new Map<string, Set<string>>();
  for (const v of variants) for (const o of v.selectedOptions) if (!isDefaultOption(o)) (values.get(o.name) ?? values.set(o.name, new Set()).get(o.name)!).add(o.value);
  for (const [name, set] of values) attributes[name.toLowerCase()] = [...set].join(', ');

  const categories = [...new Set([p.category?.name, p.productType, ...p.collections.nodes.map((c) => c.title)].filter((c): c is string => Boolean(c)))];
  const url = p.onlineStoreUrl;
  const out: SailesProduct = {
    id: p.legacyResourceId,
    title: p.title,
    description: p.descriptionHtml ?? '',
    price,
    currency,
    in_stock: available.length > 0,
    categories,
    tags: p.tags,
    attributes,
    variants: variants.map((v) => ({
      id: v.legacyResourceId,
      title: v.title,
      price: Number(v.price),
      in_stock: v.availableForSale,
      attributes: Object.fromEntries(v.selectedOptions.filter((o) => !isDefaultOption(o)).map((o) => [o.name.toLowerCase(), o.value])),
    })),
    url,
  };
  if (compare > price) out.compare_at_price = compare;
  if (p.tracksInventory && typeof p.totalInventory === 'number') out.stock_qty = Math.max(0, p.totalInventory);
  if (p.vendor) out.brand = p.vendor;
  const image = p.featuredMedia?.preview?.image?.url;
  if (image) out.image_url = image;
  // One-click add only when there is exactly one buyable variant; otherwise the shopper picks on the product page.
  if (variants.length === 1 && available.length === 1) out.add_to_cart_url = `${new URL(url).origin}/cart/add?id=${variants[0]!.legacyResourceId}&quantity=1`;
  return out;
}

/** Shopify policy types → SAILES policy topics. */
export const POLICY_TOPICS: Record<string, string> = {
  SHIPPING_POLICY: 'shipping',
  REFUND_POLICY: 'returns',
  CONTACT_INFORMATION: 'contact',
  TERMS_OF_SALE: 'payment',
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Policy HTML → plain text, at most 4,000 characters. */
export function htmlToText(html: string, max = 4000): string {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e] ?? (e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1)) || 32) : m))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** orders/paid webhook payload (REST shape) → SAILES order report. */
export function toSailesOrder(o: {
  id: number | string;
  total_price?: string;
  current_total_price?: string;
  note_attributes?: { name: string; value: string }[];
  line_items?: { product_id: number | null; properties?: { name: string; value: string }[] }[];
}) {
  const fromAttrs = o.note_attributes?.find((a) => a.name === '_sailes_conversation' || a.name === 'sailes_conversation')?.value;
  const fromLines = o.line_items?.flatMap((l) => l.properties ?? []).find((p) => p.name === '_sailes_conversation')?.value;
  const conv = fromAttrs || fromLines || null;
  return {
    orderId: String(o.id),
    total: Number(o.current_total_price ?? o.total_price ?? 0),
    conversationId: conv && /^[0-9a-f-]{36}$/i.test(conv) ? conv : null,
    productIds: [...new Set((o.line_items ?? []).map((l) => l.product_id).filter((id): id is number => id != null).map(String))],
  };
}
