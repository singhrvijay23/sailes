import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { signSessionToken } from '../src/crypto.js';
import { MemoryStore } from '../src/store.js';
import { config, fakeWorld, noSleep, product, SHOP, signWebhook } from './fakes.js';

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

async function setup(products = [product(1), product(2), product(3, { status: 'DRAFT' })]) {
  const world = fakeWorld({ products });
  const store = new MemoryStore();
  app = await buildApp({ config, store, fetchFn: world.fetchFn, sleep: noSleep, logger: false });
  const auth = () => ({ authorization: `Bearer ${signSessionToken(SHOP, config.apiKey, config.apiSecret)}` });
  return { world, store, auth };
}

/** Opens the admin page, clicks Connect, and comes back from the SAILES console with a code. */
async function connect(auth: () => Record<string, string>, code = 'cc_good_code') {
  const r = await app.inject({ method: 'POST', url: '/api/connect', headers: auth() });
  expect(r.statusCode).toBe(200);
  const url = new URL(r.json().url);
  const cb = await app.inject({ method: 'GET', url: `/connect/callback?code=${code}&state=${url.searchParams.get('state')}` });
  await app.connector.jobs.drain();
  return { url, cb };
}

function webhook(topic: string, payload: object, sign = true) {
  const body = JSON.stringify(payload);
  return app.inject({
    method: 'POST',
    url: '/webhooks',
    headers: { 'content-type': 'application/json', 'x-shopify-topic': topic, 'x-shopify-shop-domain': SHOP, 'x-shopify-hmac-sha256': sign ? signWebhook(body) : 'bad' },
    payload: body,
  });
}

describe('admin page', () => {
  it('serves the embedded page only to the shop admin', async () => {
    await setup();
    const r = await app.inject({ method: 'GET', url: `/app?shop=${SHOP}&host=abc&embedded=1` });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<meta name="shopify-api-key" content="test-key" />');
    expect(r.body.indexOf('app-bridge.js')).toBeLessThan(r.body.indexOf('polaris-2.js'));
    expect(r.headers['content-security-policy']).toBe(`frame-ancestors https://${SHOP} https://admin.shopify.com;`);
  });

  it('rejects API calls without a valid session token', async () => {
    await setup();
    expect((await app.inject({ method: 'GET', url: '/api/status' })).statusCode).toBe(401);
    const bad = await app.inject({ method: 'GET', url: '/api/status', headers: { authorization: `Bearer ${signSessionToken(SHOP, config.apiKey, 'wrong')}` } });
    expect(bad.statusCode).toBe(401);
    expect(bad.headers['x-shopify-retry-invalid-session-request']).toBe('1');
  });
});

describe('install and connect', () => {
  it('exchanges the session token for an expiring offline token on first open', async () => {
    const { world, store, auth } = await setup();
    const r = await app.inject({ method: 'GET', url: '/api/status', headers: auth() });
    expect(r.json()).toMatchObject({ shop: SHOP, connected: false, store: null });
    expect(r.json().themeEditorUrl).toBe(`https://${SHOP}/admin/themes/current/editor?context=apps&activateAppId=test-key/sailes-embed`);
    const tokenCall = world.calls.find((c) => c.url.endsWith('/admin/oauth/access_token'))!;
    const p = new URLSearchParams(tokenCall.body);
    expect(p.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(p.get('requested_token_type')).toBe('urn:shopify:params:oauth:token-type:offline-access-token');
    expect(p.get('expiring')).toBe('1');
    const rec = await store.get(SHOP);
    expect(rec).toMatchObject({ accessToken: 'shpat_1', refreshToken: 'shprt_1' });
    // A second request reuses the stored token.
    await app.inject({ method: 'GET', url: '/api/status', headers: auth() });
    expect(world.calls.filter((c) => c.url.endsWith('/admin/oauth/access_token'))).toHaveLength(1);
  });

  it('connects to SAILES, publishes the widget key and runs the first sync', async () => {
    const { world, store, auth } = await setup();
    const { url, cb } = await connect(auth);
    expect(url.origin + url.pathname).toBe('https://app.sailes.test/connect');
    expect(url.searchParams.get('platform')).toBe('shopify');
    expect(url.searchParams.get('shop')).toBe('https://acme.example');
    expect(url.searchParams.get('redirect_uri')).toBe('https://shopify.sailes.test/connect/callback');
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('https://admin.shopify.com/store/acme-test/apps/test-key');

    const rec = (await store.get(SHOP))!;
    expect(rec.sailes).toMatchObject({ storeId: '11111111-1111-1111-1111-111111111111', apiKey: 'sk_secret', widgetKey: 'pk_widget' });
    expect(rec.connectState).toBeNull();
    expect(world.metafields).toEqual({ 'sailes.widget_key': 'pk_widget', 'sailes.script_url': 'https://api.sailes.test/widget/sailes.js' });
    expect([...world.sailesProducts.keys()].sort()).toEqual(['1', '2']);
    expect(rec.lastSync).toMatchObject({ kind: 'full', created: 2, deleted: 1 });
    expect(Object.fromEntries(world.sailesPolicies)).toEqual({ shipping: 'Free shipping over $50.\n- US only', returns: '30 day returns & exchanges.' });

    // The secret key never reaches the browser.
    const status = await app.inject({ method: 'GET', url: '/api/status', headers: auth() });
    expect(status.json()).toMatchObject({ connected: true, store: { storeName: 'Acme', active: true } });
    expect(status.body).not.toContain('sk_secret');

    // The state works once.
    const again = await app.inject({ method: 'GET', url: `/connect/callback?code=cc_good_code&state=${url.searchParams.get('state')}` });
    expect(again.statusCode).toBe(400);
  });

  it('shows the SAILES error when the code is bad', async () => {
    const { store, auth } = await setup();
    const { cb } = await connect(auth, 'cc_bad');
    expect(cb.statusCode).toBe(400);
    expect(cb.body).toContain('This connection code is invalid');
    expect((await store.get(SHOP))!.sailes).toBeNull();
  });

  it('pages through large catalogs', async () => {
    const many = Array.from({ length: 60 }, (_, i) => product(i + 1));
    const { world, auth } = await setup(many);
    await connect(auth);
    expect(world.sailesProducts.size).toBe(60);
    expect(world.calls.filter((c) => c.body?.query?.includes('query SailesProducts'))).toHaveLength(3);
  });

  it('refreshes an expiring Shopify token and stores the rotated refresh token', async () => {
    const { world, store, auth } = await setup();
    await connect(auth);
    await store.upsert(SHOP, { accessTokenExpiresAt: Date.now() - 1000 });
    await app.connector.fullSync(SHOP);
    const refresh = world.calls.find((c) => c.url.endsWith('/admin/oauth/access_token') && new URLSearchParams(c.body).get('grant_type') === 'refresh_token')!;
    expect(new URLSearchParams(refresh.body).get('refresh_token')).toBe('shprt_1');
    expect(await store.get(SHOP)).toMatchObject({ accessToken: 'shpat_2', refreshToken: 'shprt_2' });
  });
});

describe('webhooks', () => {
  it('rejects unsigned webhooks', async () => {
    await setup();
    expect((await webhook('products/update', { id: 1 }, false)).statusCode).toBe(401);
  });

  it('keeps the catalog in step with product, stock and order events', async () => {
    const { world, auth } = await setup();
    await connect(auth);

    world.products.set('4', product(4, { title: 'New mug' }));
    expect((await webhook('products/create', { id: 4 })).statusCode).toBe(200);
    await app.connector.jobs.drain();
    expect(world.sailesProducts.get('4').title).toBe('New mug');

    // Unpublishing removes it from recommendations.
    world.products.set('4', product(4, { onlineStoreUrl: null }));
    await webhook('products/update', { id: 4 });
    await app.connector.jobs.drain();
    expect(world.sailesProducts.has('4')).toBe(false);

    // Stock change: inventory item 20 belongs to product 2.
    world.products.set('2', product(2, { variants: { nodes: [{ ...product(2).variants.nodes[0]!, availableForSale: false }] } }));
    await webhook('inventory_levels/update', { inventory_item_id: 20, available: 0 });
    await app.connector.jobs.drain();
    expect(world.sailesProducts.get('2').in_stock).toBe(false);

    await webhook('products/delete', { id: 1 });
    await app.connector.jobs.drain();
    expect(world.sailesProducts.has('1')).toBe(false);

    const conv = '0b9a4f6e-3a2c-4d5e-9f10-1234567890ab';
    await webhook('orders/paid', { id: 9001, current_total_price: '24.00', note_attributes: [{ name: '_sailes_conversation', value: conv }], line_items: [{ product_id: 2 }] });
    await app.connector.jobs.drain();
    expect(world.orders).toEqual([{ orderId: '9001', total: 24, conversationId: conv, productIds: ['2'] }]);
  });

  it('revokes the SAILES key on uninstall and erases the shop on shop/redact', async () => {
    const { world, store, auth } = await setup();
    await connect(auth);
    await webhook('app/uninstalled', { id: 1, domain: SHOP });
    await app.connector.jobs.drain();
    expect(world.calls.some((c) => c.url.endsWith('/v1/connector/disconnect'))).toBe(true);
    expect(await store.get(SHOP)).toMatchObject({ accessToken: null, sailes: null });
    expect((await store.get(SHOP))!.uninstalledAt).toBeTypeOf('number');
    expect((await webhook('customers/redact', { shop_domain: SHOP })).statusCode).toBe(200);
    await webhook('shop/redact', { shop_domain: SHOP });
    await app.connector.jobs.drain();
    expect(await store.get(SHOP)).toBeNull();
  });

  it('runs the periodic resync only for connected shops that are due', async () => {
    const { auth } = await setup();
    expect(await app.connector.resyncDue()).toBe(0);
    await connect(auth);
    expect(await app.connector.resyncDue()).toBe(0);
    await app.connector.store.upsert(SHOP, { lastFullSyncAt: Date.now() - 25 * 3_600_000 });
    expect(await app.connector.resyncDue()).toBe(1);
  });
});

describe('AI settings from the Shopify admin', () => {
  it('saves the merchant’s own AI key through SAILES without storing it here', async () => {
    const { world, store, auth } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/ai', headers: auth() })).statusCode).toBe(409);
    await connect(auth);
    const before = await app.inject({ method: 'GET', url: '/api/ai', headers: auth() });
    expect(before.json()).toMatchObject({ mode: 'demo', providers: [{ id: 'openai' }] });

    const bad = await app.inject({ method: 'PUT', url: '/api/ai', headers: auth(), payload: { mode: 'byok', provider: 'openai', apiKey: 'bad-key-123' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toBe('Incorrect API key');

    const ok = await app.inject({ method: 'PUT', url: '/api/ai', headers: auth(), payload: { mode: 'byok', provider: 'openai', apiKey: ' sk-proj-abcd1234 ', chatModel: 'gpt-5' } });
    expect(ok.statusCode).toBe(200);
    const sent = world.calls.filter((c) => c.url.endsWith('/ai') && c.method === 'PUT').pop()!;
    expect(sent.body).toEqual({ mode: 'byok', provider: 'openai', apiKey: 'sk-proj-abcd1234', chatModel: 'gpt-5' });
    expect(JSON.stringify(await store.get(SHOP))).not.toContain('sk-proj');
    expect((await app.inject({ method: 'GET', url: '/api/ai', headers: auth() })).json().credential).toMatchObject({ provider: 'openai', key: '••••1234' });

    expect((await app.inject({ method: 'PUT', url: '/api/ai', headers: auth(), payload: { mode: 'magic' } })).statusCode).toBe(400);
  });

  it('asks to reconnect when the SAILES key was revoked elsewhere', async () => {
    const { world, auth } = await setup();
    await connect(auth);
    world.revokeKey();
    const r = await app.inject({ method: 'GET', url: '/api/status', headers: auth() });
    expect(r.json()).toMatchObject({ connected: false, notice: expect.stringContaining('Connect again') });
  });
});
