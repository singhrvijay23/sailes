import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, query } from '../src/db/pool.js';
import { resetDb } from './helpers.js';

let app: FastifyInstance;
let token: string;
let storeId: string;
let widgetKey: string;

const CSV = `sku,name,price,categories,tags,attr:color,description,in_stock
M1,Classic Mug,14,Mugs,kitchen,white,Ceramic mug,true
M2,Travel Mug,24,Mugs,kitchen,black,Insulated travel mug keeps coffee hot,true
T1,Tea Sampler,19,Tea,kitchen,,Six loose-leaf teas,true
`;

function parseSse(body: string) {
  return body
    .split('\n\n')
    .filter(Boolean)
    .map((chunk) => {
      const event = /event: (.+)/.exec(chunk)?.[1];
      const data = /data: (.+)/.exec(chunk)?.[1];
      return [event, data ? JSON.parse(data) : null] as const;
    });
}

beforeAll(async () => {
  await resetDb();
  app = await buildApp({ logger: false });
  const r = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'owner@shop.test', password: 'password123', storeName: 'Mug Shop', siteUrl: 'https://mugshop.test' } });
  expect(r.statusCode).toBe(200);
  token = r.json().token;
  storeId = r.json().storeId;
  widgetKey = (await query('SELECT key FROM widget_keys WHERE tenant_id = $1', [storeId])).rows[0].key;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const auth = () => ({ authorization: `Bearer ${token}` });

describe('merchant API', () => {
  it('rejects duplicate signups and bad logins', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'owner@shop.test', password: 'password123', storeName: 'X' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'owner@shop.test', password: 'nope' } })).statusCode).toBe(401);
  });

  it('imports a CSV catalog', async () => {
    const r = await app.inject({ method: 'POST', url: `/v1/stores/${storeId}/catalog/import`, headers: { ...auth(), 'content-type': 'text/csv' }, payload: CSV });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ created: 3, rejected: 0 });
    const again = await app.inject({ method: 'POST', url: `/v1/stores/${storeId}/catalog/import`, headers: { ...auth(), 'content-type': 'text/csv' }, payload: CSV });
    expect(again.json()).toMatchObject({ created: 0, unchanged: 3 });
  });

  it('enforces the plan product limit', async () => {
    const products = Array.from({ length: 2001 }, (_, i) => ({ id: `B${i}`, title: `Bulk ${i}` }));
    const r = await app.inject({ method: 'PUT', url: `/v1/stores/${storeId}/catalog/products`, headers: auth(), payload: { products } });
    expect(r.statusCode).toBe(402);
    expect(r.json().error).toBe('product_limit');
  });

  it('blocks other users from the store', async () => {
    const other = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'intruder@shop.test', password: 'password123', storeName: 'Other' } });
    const r = await app.inject({ method: 'GET', url: `/v1/stores/${storeId}`, headers: { authorization: `Bearer ${other.json().token}` } });
    expect(r.statusCode).toBe(403);
  });

  it('lets a connector key sync products but not change settings', async () => {
    const k = await app.inject({ method: 'POST', url: `/v1/stores/${storeId}/api-keys`, headers: auth(), payload: {} });
    const sk = k.json().key;
    expect(sk).toMatch(/^sk_/);
    const sync = await app.inject({ method: 'PUT', url: `/v1/stores/${storeId}/catalog/products`, headers: { authorization: `Bearer ${sk}` }, payload: { products: [{ id: 'M3', title: 'Espresso Cup', price: 9 }] } });
    expect(sync.json().created).toBe(1);
    const patch = await app.inject({ method: 'PATCH', url: `/v1/stores/${storeId}`, headers: { authorization: `Bearer ${sk}` }, payload: { name: 'hacked' } });
    expect(patch.statusCode).toBe(403);
  });

  it('refuses an AI key that fails validation without storing it', async () => {
    const r = await app.inject({ method: 'PUT', url: `/v1/stores/${storeId}/ai`, headers: auth(), payload: { mode: 'byok', provider: 'openai', apiKey: 'sk-obviously-not-a-real-key' } });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    const s = await app.inject({ method: 'GET', url: `/v1/stores/${storeId}`, headers: auth() });
    expect(s.json().ai).toBeNull();
  });

  it('updates assistant settings', async () => {
    const r = await app.inject({ method: 'PATCH', url: `/v1/stores/${storeId}`, headers: auth(), payload: { settings: { assistantName: 'Milo', primaryColor: '#E63946', suggestions: ['Travel mugs'] } } });
    expect(r.statusCode).toBe(200);
    const cfg = await app.inject({ method: 'GET', url: '/v1/widget/config', headers: { 'x-sailes-key': widgetKey } });
    expect(cfg.json()).toMatchObject({ assistantName: 'Milo', primaryColor: '#E63946', suggestions: ['Travel mugs'] });
  });
});

describe('widget API', () => {
  it('streams a chat answer with product cards', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/chat', headers: { 'x-sailes-key': widgetKey, origin: 'https://mugshop.test' }, payload: { message: 'travel mug for coffee' } });
    expect(r.headers['content-type']).toContain('text/event-stream');
    const events = parseSse(r.body);
    const cards = events.find(([e]) => e === 'products')?.[1].items;
    expect(cards[0].title).toBe('Travel Mug');
    expect(events.at(-1)![0]).toBe('done');
  });

  it('rejects the widget key on a site that is not allowed', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/widget/config', headers: { 'x-sailes-key': widgetKey, origin: 'https://evil.test' } });
    expect(r.statusCode).toBe(403);
  });

  it('records add-to-cart events and shows them in analytics', async () => {
    await app.inject({ method: 'POST', url: '/v1/events', headers: { 'x-sailes-key': widgetKey }, payload: { type: 'add_to_cart', productId: 'M2', value: 24 } });
    const a = await app.inject({ method: 'GET', url: `/v1/stores/${storeId}/analytics?days=7`, headers: auth() });
    expect(a.json().totals).toMatchObject({ conversations: 1, add_to_carts: 1 });
    expect(a.json().topQueries.length).toBeGreaterThan(0);
  });
});
