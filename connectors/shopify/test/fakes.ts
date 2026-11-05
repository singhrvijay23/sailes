import { createHmac } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import type { GqlProduct } from '../src/mapping.js';

export const SHOP = 'acme-test.myshopify.com';
export const config = loadConfig({
  apiKey: 'test-key',
  apiSecret: 'test-secret',
  appUrl: 'https://shopify.sailes.test',
  sailesApiUrl: 'https://api.sailes.test',
  sailesConsoleUrl: 'https://app.sailes.test',
  databaseUrl: '',
});

export function product(id: number, over: Partial<GqlProduct> = {}): GqlProduct {
  return {
    id: `gid://shopify/Product/${id}`,
    legacyResourceId: String(id),
    title: `Product ${id}`,
    handle: `product-${id}`,
    descriptionHtml: '<p>Nice <b>thing</b></p>',
    vendor: 'Acme',
    productType: 'Mugs',
    tags: ['gift'],
    status: 'ACTIVE',
    onlineStoreUrl: `https://acme.example/products/product-${id}`,
    totalInventory: 5,
    tracksInventory: true,
    category: { name: 'Drinkware' },
    featuredMedia: { preview: { image: { url: `https://cdn.shopify.com/p${id}.jpg` } } },
    collections: { nodes: [{ title: 'Kitchen' }] },
    variants: { nodes: [{ legacyResourceId: String(id * 10), title: 'Default Title', price: '12.00', compareAtPrice: '15.00', availableForSale: true, inventoryQuantity: 5, selectedOptions: [{ name: 'Title', value: 'Default Title' }] }] },
    ...over,
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

/** One fetch() that plays both Shopify (Admin API + token endpoint) and the SAILES API. */
export function fakeWorld(opts: { products?: GqlProduct[]; sailes?: 'fake' | ((url: string, init: RequestInit) => Promise<Response>) } = {}) {
  const products = new Map((opts.products ?? []).map((p) => [p.legacyResourceId, p]));
  const calls: Call[] = [];
  const sailesProducts = new Map<string, any>();
  const sailesPolicies = new Map<string, string>();
  const orders: any[] = [];
  const metafields: Record<string, string> = {};
  let ai: any = { mode: 'demo', credential: null };
  let tokenCounter = 0;
  let keyRevoked = false;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const raw = typeof init.body === 'string' ? init.body : '';
    const body = headers['content-type']?.includes('json') && raw ? JSON.parse(raw) : raw;
    calls.push({ url, method: init.method ?? 'GET', headers, body });

    if (url === `https://${SHOP}/admin/oauth/access_token`) {
      const p = new URLSearchParams(raw);
      if (p.get('client_secret') !== config.apiSecret) return json(401, { error: 'invalid_client' });
      tokenCounter++;
      return json(200, { access_token: `shpat_${tokenCounter}`, scope: 'read_products', expires_in: 3600, refresh_token: `shprt_${tokenCounter}`, refresh_token_expires_in: 7776000 });
    }

    if (url === `https://${SHOP}/admin/api/${config.apiVersion}/graphql.json`) {
      if (!headers['x-shopify-access-token']?.startsWith('shpat_')) return json(401, {});
      const q: string = body.query;
      const v = body.variables ?? {};
      if (q.includes('query SailesProducts')) {
        const all = [...products.values()];
        const start = v.cursor ? Number(v.cursor) : 0;
        const page = all.slice(start, start + 25);
        const more = start + 25 < all.length;
        return json(200, { data: { shop: { currencyCode: 'USD' }, products: { pageInfo: { hasNextPage: more, endCursor: more ? String(start + 25) : null }, nodes: page } } });
      }
      if (q.includes('query SailesProduct(')) return json(200, { data: { shop: { currencyCode: 'USD' }, product: products.get(String(v.id).split('/').pop()!) ?? null } });
      if (q.includes('query SailesInventoryItem')) {
        const item = String(v.id).split('/').pop();
        return json(200, { data: { inventoryItem: { variant: { product: { id: `gid://shopify/Product/${Number(item) / 10}` } } } } });
      }
      if (q.includes('query SailesShop'))
        return json(200, {
          data: {
            shop: {
              name: 'Acme',
              currencyCode: 'USD',
              myshopifyDomain: SHOP,
              primaryDomain: { url: 'https://acme.example' },
              shopPolicies: [
                { type: 'SHIPPING_POLICY', body: '<p>Free shipping over $50.</p><ul><li>US only</li></ul>' },
                { type: 'REFUND_POLICY', body: '<p>30 day returns &amp; exchanges.</p>' },
                { type: 'PRIVACY_POLICY', body: '<p>Private.</p>' },
              ],
            },
            currentAppInstallation: { id: 'gid://shopify/AppInstallation/1' },
          },
        });
      if (q.includes('mutation SailesMetafields')) {
        for (const m of v.metafields) metafields[`${m.namespace}.${m.key}`] = m.value;
        return json(200, { data: { metafieldsSet: { userErrors: [] } } });
      }
      return json(200, { errors: [{ message: 'unknown query' }] });
    }

    if (typeof opts.sailes === 'function') return opts.sailes(url, init);
    if (url.startsWith('https://api.sailes.test')) {
      const path = url.slice('https://api.sailes.test'.length);
      if (path === '/v1/connect/exchange') {
        if (body.code !== 'cc_good_code') return json(400, { error: 'invalid_code', message: 'This connection code is invalid' });
        return json(200, { storeId: '11111111-1111-1111-1111-111111111111', apiKey: 'sk_secret', widgetKey: 'pk_widget', apiUrl: 'https://api.sailes.test', widgetScriptUrl: 'https://api.sailes.test/widget/sailes.js' });
      }
      if (headers.authorization !== 'Bearer sk_secret' || keyRevoked) return json(401, { error: 'unauthorized', message: 'Invalid API key' });
      const base = '/v1/stores/11111111-1111-1111-1111-111111111111';
      if (path === '/v1/connector/store') return json(200, { storeId: '11111111-1111-1111-1111-111111111111', storeName: 'Acme', plan: 'starter', platform: 'shopify', shopUrl: 'https://acme.example', active: true, widgetKey: 'pk_widget', widgetScriptUrl: 'https://api.sailes.test/widget/sailes.js', consoleUrl: 'https://app.sailes.test' });
      if (path === '/v1/connector/disconnect') {
        keyRevoked = true;
        return json(200, { ok: true });
      }
      if (path === `${base}/catalog/products` && init.method === 'PUT') {
        let created = 0;
        for (const p of body.products) {
          if (!sailesProducts.has(p.id)) created++;
          sailesProducts.set(p.id, p);
        }
        return json(200, { created, updated: body.products.length - created, unchanged: 0, rejected: 0, errors: [] });
      }
      if (path === `${base}/catalog/products/delete`) {
        for (const id of body.ids) sailesProducts.delete(id);
        return json(200, { deleted: body.ids.length });
      }
      if (path === `${base}/policies`) {
        sailesPolicies.set(body.topic, body.content);
        return json(200, { id: 'x' });
      }
      if (path === `${base}/orders`) {
        orders.push(body);
        return json(200, { ok: true, duplicate: false });
      }
      if (path === `${base}/ai` && init.method === 'PUT') {
        if (body.mode === 'byok' && body.apiKey === 'bad-key-123') return json(400, { error: 'invalid_ai_key', message: 'Incorrect API key' });
        ai = body.mode === 'byok' ? { mode: 'byok', credential: { provider: body.provider, chat_model: body.chatModel, key: '••••' + String(body.apiKey).slice(-4) } } : { mode: body.mode, credential: null };
        return json(200, { ok: true, mode: body.mode, reindexing: 0 });
      }
      if (path === `${base}/ai`) return json(200, ai);
      if (path === '/v1/ai/providers') return json(200, { providers: [{ id: 'openai', defaultModel: 'gpt-5-mini', models: ['gpt-5-mini', 'gpt-5'] }], managedAvailable: false });
      return json(404, { error: 'not_found', message: path });
    }
    throw new Error(`Unexpected fetch ${url}`);
  }) as typeof fetch;

  return { fetchFn, calls, products, sailesProducts, sailesPolicies, orders, metafields, revokeKey: () => (keyRevoked = true) };
}

export function signWebhook(body: string) {
  return createHmac('sha256', config.apiSecret).update(body).digest('base64');
}

export const noSleep = async () => {};
