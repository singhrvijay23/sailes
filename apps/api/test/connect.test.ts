import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, query } from '../src/db/pool.js';
import { resetDb } from './helpers.js';

let app: FastifyInstance;
let token: string;
let storeId: string;

beforeAll(async () => {
  await resetDb();
  app = await buildApp({ logger: false });
  const r = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'conn@shop.test', password: 'password123', storeName: 'Conn Shop' } });
  token = r.json().token;
  storeId = r.json().storeId;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const approve = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/v1/stores/${storeId}/connect/approve`, headers: { authorization: `Bearer ${token}` }, payload });

const good = { platform: 'shopify', shopUrl: 'https://conn-shop.myshopify.com/admin', redirectUri: 'https://shopify.sailes.test/callback', state: 'state-12345' };

describe('connector install flow', () => {
  it('needs a signed-in owner and https URLs', async () => {
    expect((await app.inject({ method: 'POST', url: `/v1/stores/${storeId}/connect/approve`, payload: good })).statusCode).toBe(401);
    expect((await approve({ ...good, redirectUri: 'http://evil.test/cb' })).statusCode).toBe(400);
    expect((await approve({ ...good, platform: 'magento' })).statusCode).toBe(400);
  });

  it('exchanges a one-time code for a connector key that can sync the catalog', async () => {
    const r = await approve(good);
    expect(r.statusCode).toBe(200);
    const redirect = new URL(r.json().redirect);
    expect(redirect.origin + redirect.pathname).toBe('https://shopify.sailes.test/callback');
    expect(redirect.searchParams.get('state')).toBe('state-12345');
    const code = redirect.searchParams.get('code')!;

    const ex = await app.inject({ method: 'POST', url: '/v1/connect/exchange', payload: { code } });
    expect(ex.statusCode).toBe(200);
    const creds = ex.json();
    expect(creds).toMatchObject({ storeId, widgetKey: expect.stringMatching(/^pk_/), apiKey: expect.stringMatching(/^sk_/) });

    // Single use.
    expect((await app.inject({ method: 'POST', url: '/v1/connect/exchange', payload: { code } })).json().error).toBe('invalid_code');

    const t = (await query('SELECT platform, site_url FROM tenants WHERE id = $1', [storeId])).rows[0];
    expect(t).toEqual({ platform: 'shopify', site_url: 'https://conn-shop.myshopify.com' });
    const origins = (await query('SELECT allowed_origins FROM widget_keys WHERE tenant_id = $1', [storeId])).rows[0].allowed_origins;
    expect(origins).toContain('https://conn-shop.myshopify.com');

    const auth = { authorization: `Bearer ${creds.apiKey}` };
    const me = await app.inject({ method: 'GET', url: '/v1/connector/store', headers: auth });
    expect(me.json()).toMatchObject({ storeId, platform: 'shopify', shopUrl: 'https://conn-shop.myshopify.com', active: true, widgetKey: creds.widgetKey });
    const sync = await app.inject({ method: 'PUT', url: `/v1/stores/${storeId}/catalog/products`, headers: auth, payload: { products: [{ id: '1', title: 'Blue Mug', price: 12 }] } });
    expect(sync.statusCode).toBe(200);

    // Orders are recorded once even when the platform retries the webhook.
    const order = { orderId: '1001', total: 12, productIds: ['1'] };
    expect((await app.inject({ method: 'POST', url: `/v1/stores/${storeId}/orders`, headers: auth, payload: order })).json()).toEqual({ ok: true, duplicate: false });
    expect((await app.inject({ method: 'POST', url: `/v1/stores/${storeId}/orders`, headers: auth, payload: order })).json()).toEqual({ ok: true, duplicate: true });

    // Reconnecting the same shop replaces the old key.
    const code2 = new URL((await approve(good)).json().redirect).searchParams.get('code')!;
    const creds2 = (await app.inject({ method: 'POST', url: '/v1/connect/exchange', payload: { code: code2 } })).json();
    expect((await app.inject({ method: 'GET', url: '/v1/connector/store', headers: auth })).statusCode).toBe(401);
    const auth2 = { authorization: `Bearer ${creds2.apiKey}` };
    expect((await app.inject({ method: 'GET', url: '/v1/connector/store', headers: auth2 })).statusCode).toBe(200);

    // Uninstall revokes it.
    expect((await app.inject({ method: 'POST', url: '/v1/connector/disconnect', headers: auth2 })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/connector/store', headers: auth2 })).statusCode).toBe(401);
  });

  it('rejects expired codes', async () => {
    const code = new URL((await approve(good)).json().redirect).searchParams.get('code')!;
    await query(`UPDATE connect_codes SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL`);
    expect((await app.inject({ method: 'POST', url: '/v1/connect/exchange', payload: { code } })).statusCode).toBe(400);
  });
});
