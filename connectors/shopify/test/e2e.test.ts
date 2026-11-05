import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { signSessionToken } from '../src/crypto.js';
import { MemoryStore } from '../src/store.js';
import { config as baseConfig, fakeWorld, noSleep, product, SHOP } from './fakes.js';

// End to end against a running SAILES API (Shopify is faked):
//   SAILES_E2E_API_URL=http://localhost:4000 pnpm test
const api = process.env.SAILES_E2E_API_URL;

describe.skipIf(!api)('Shopify app against the real SAILES API', () => {
  const config = loadConfig({ ...baseConfig, sailesApiUrl: api! });
  const world = fakeWorld({ products: [product(1, { title: 'Blue ceramic mug' }), product(2, { title: 'Green tea sampler', productType: 'Tea' })], sailes: (u, init) => fetch(u, init) });
  let app: Awaited<ReturnType<typeof buildApp>>;
  afterAll(async () => app?.close());

  it('connects, syncs the catalog and policies, saves AI settings and reports an order', async () => {
    app = await buildApp({ config, store: new MemoryStore(), fetchFn: world.fetchFn, sleep: noSleep, logger: false });
    const auth = { authorization: `Bearer ${signSessionToken(SHOP, config.apiKey, config.apiSecret)}` };

    // Merchant signs up in the console.
    const email = `shopify-e2e-${Date.now()}@shop.test`;
    const signup = await (await fetch(`${api}/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'password123', storeName: 'Acme E2E' }) })).json();
    const consoleAuth = { authorization: `Bearer ${signup.token}`, 'content-type': 'application/json' };

    // Connect: the console's Allow button calls approve, which returns our callback URL with a code.
    const connectUrl = new URL((await app.inject({ method: 'POST', url: '/api/connect', headers: auth })).json().url);
    const approve = await (
      await fetch(`${api}/v1/stores/${signup.storeId}/connect/approve`, {
        method: 'POST',
        headers: consoleAuth,
        body: JSON.stringify({ platform: 'shopify', shopUrl: connectUrl.searchParams.get('shop'), redirectUri: connectUrl.searchParams.get('redirect_uri'), state: connectUrl.searchParams.get('state') }),
      })
    ).json();
    const back = new URL(approve.redirect);
    const cb = await app.inject({ method: 'GET', url: back.pathname + back.search });
    expect(cb.statusCode).toBe(302);
    await app.connector.jobs.drain();

    const status = (await app.inject({ method: 'GET', url: '/api/status', headers: auth })).json();
    expect(status).toMatchObject({ connected: true, store: { storeId: signup.storeId, platform: 'shopify', active: true }, lastSync: { created: 2 } });
    expect(world.metafields['sailes.widget_key']).toMatch(/^pk_/);

    // The products and policies are in SAILES.
    const products = await (await fetch(`${api}/v1/stores/${signup.storeId}/catalog`, { headers: consoleAuth })).json();
    expect(JSON.stringify(products)).toContain('Blue ceramic mug');

    const rules = await (await fetch(`${api}/v1/stores/${signup.storeId}/rules`, { headers: consoleAuth })).json();
    expect(rules.policies.map((p: { topic: string }) => p.topic).sort()).toEqual(['returns', 'shipping']);

    // A second full sync is free: nothing changed.
    const again = await app.connector.fullSync(SHOP);
    expect(again).toMatchObject({ created: 0, unchanged: 2 });

    // AI settings from the Shopify admin.
    expect((await app.inject({ method: 'PUT', url: '/api/ai', headers: auth, payload: { mode: 'demo' } })).json()).toMatchObject({ ok: true, mode: 'demo' });
    expect((await app.inject({ method: 'GET', url: '/api/ai', headers: auth })).json()).toMatchObject({ mode: 'demo', providers: expect.any(Array) });

    // Orders.
    await app.connector.reportOrder(SHOP, { id: 4242, current_total_price: '12.00', line_items: [{ product_id: 1 }] });
  });
});
