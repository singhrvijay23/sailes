import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, query, withTenant } from '../src/db/pool.js';
import { setProviderOverride } from '../src/ai/registry.js';
import { HASH_EMBED_MODEL, hashEmbed } from '../src/ai/hashEmbed.js';
import { handleChat } from '../src/agent/orchestrator.js';
import { createDemoProvider } from '../src/ai/providers/demo.js';
import { matchUpsells, type UpsellRule } from '../src/upsell/upsell.js';
import type { ChatProvider } from '../src/ai/types.js';
import { seededDb } from './helpers.js';

let app: FastifyInstance;
let token: string;
let ids: Awaited<ReturnType<typeof seededDb>>;

const path = (p = '') => `/v1/stores/${ids.gifts}/upsell-rules${p}`;
const auth = () => ({ authorization: `Bearer ${token}` });

/** A fake LLM that calls one tool and records the result. */
function caller(tool: string, input: Record<string, unknown>, sink: { result?: any }): ChatProvider {
  return {
    id: 'openai',
    model: 'gpt-5-mini',
    embeddingModel: HASH_EMBED_MODEL,
    validate: async () => {},
    embed: async (texts) => ({ vectors: texts.map(hashEmbed), tokens: 0 }),
    runTurn: async (t) => {
      sink.result = await t.executeTool(tool, input);
      return { text: 'ok', usage: { inputTokens: 0, outputTokens: 0 }, rounds: 1, stopReason: 'done' };
    },
  };
}

async function related(productId: string) {
  const sink: { result?: any } = {};
  setProviderOverride(() => caller('get_related', { product_id: productId }, sink));
  await handleChat({ tenantId: ids.gifts, message: 'what goes with this?', emit: () => {} });
  setProviderOverride(null);
  return sink.result;
}

beforeAll(async () => {
  ids = await seededDb();
  app = await buildApp({ logger: false });
  token = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'demo@sailes.dev', password: 'sailes-demo-123' } })).json().token;
});

afterAll(async () => {
  setProviderOverride(null);
  await app.close();
  await pool.end();
});

describe('upsell rule matching', () => {
  const rule = (over: Partial<UpsellRule>): UpsellRule => ({ id: 'r', kind: 'cross_sell', name: 'R', trigger_field: 'any', trigger_value: null, target_product_ids: [], discount_code: null, discount_text: null, min_cart_value: null, ...over });
  const mug = { external_id: 'M1', categories: ['Mugs', 'Gifts'], tags: ['gift', 'mugs'] };

  it('matches product, category (case-insensitive), tag and any', () => {
    const rules = [
      rule({ name: 'a', trigger_field: 'product', trigger_value: 'M1', target_product_ids: ['X'] }),
      rule({ name: 'b', trigger_field: 'category', trigger_value: 'mugs', target_product_ids: ['Y', 'X'] }),
      rule({ name: 'c', trigger_field: 'tag', trigger_value: 'candles', target_product_ids: ['Z'] }),
      rule({ name: 'd', kind: 'discount', trigger_field: 'any', discount_text: 'Free gift wrap' }),
      rule({ name: 'e', kind: 'bundle', trigger_field: null, target_product_ids: ['M1', 'Q'] }),
    ];
    const m = matchUpsells(rules, mug);
    expect(m.crossSell).toEqual([
      { id: 'X', rule: 'a' },
      { id: 'Y', rule: 'b' },
    ]);
    expect(m.offers.map((o) => o.text)).toEqual(['Free gift wrap']);
    expect(m.bundles.map((b) => b.name)).toEqual(['e']);
  });
});

describe('upsell rules API and agent', () => {
  it('validates rules and checks products exist in the catalog', async () => {
    expect((await app.inject({ method: 'POST', url: path(), headers: auth(), payload: { kind: 'bundle', name: 'Solo', targetProductIds: ['GFT-001'] } })).statusCode).toBe(400);
    const unknown = await app.inject({ method: 'POST', url: path(), headers: auth(), payload: { kind: 'cross_sell', name: 'X', triggerField: 'any', targetProductIds: ['NOPE-1'] } });
    expect(unknown.json().error).toBe('unknown_products');
    const noText = await app.inject({ method: 'POST', url: path(), headers: auth(), payload: { kind: 'discount', name: 'D', triggerField: 'category', triggerValue: 'Mugs' } });
    expect(noText.statusCode).toBe(400);
  });

  it('puts merchant cross-sells first in get_related and returns configured offers only', async () => {
    const before = await related('GFT-006');
    expect(before.offers).toBeUndefined();
    expect(before.bundles).toBeUndefined();

    const cs = await app.inject({ method: 'POST', url: path(), headers: auth(), payload: { kind: 'cross_sell', name: 'Mug + coffee', triggerField: 'category', triggerValue: 'Mugs', targetProductIds: ['GFT-012'] } });
    expect(cs.statusCode).toBe(200);
    await app.inject({ method: 'POST', url: path(), headers: auth(), payload: { kind: 'discount', name: 'Mug promo', triggerField: 'tag', triggerValue: 'mugs', discountText: '15% off a second mug', discountCode: 'MUG15' } });
    await app.inject({ method: 'POST', url: path(), headers: auth(), payload: { kind: 'bundle', name: 'Dad gift set', targetProductIds: ['GFT-006', 'GFT-012'], discountText: 'Save $5 on the set' } });
    // Expired discount never shows.
    await app.inject({ method: 'POST', url: path(), headers: auth(), payload: { kind: 'discount', name: 'Old', triggerField: 'any', discountText: 'Old promo', endsAt: '2020-01-01T00:00:00Z' } });

    const after = await related('GFT-006');
    expect(after.products[0]).toMatchObject({ id: 'GFT-012', why: 'store recommendation' });
    expect(after.offers).toEqual([{ text: '15% off a second mug', code: 'MUG15', min_cart_value: null }]);
    expect(after.bundles).toEqual([
      { name: 'Dad gift set', products: [expect.objectContaining({ id: 'GFT-006' }), expect.objectContaining({ id: 'GFT-012' })], total_price: 50, discount: 'Save $5 on the set', code: null },
    ]);

    // Out-of-stock bundle items hide the bundle and the cross-sell.
    await withTenant(ids.gifts, (db) => db.query(`UPDATE products SET in_stock = false WHERE external_id = 'GFT-012'`));
    const oos = await related('GFT-006');
    expect(oos.bundles).toEqual([]);
    expect(oos.products.map((p: any) => p.id)).not.toContain('GFT-012');
    await withTenant(ids.gifts, (db) => db.query(`UPDATE products SET in_stock = true WHERE external_id = 'GFT-012'`));
  });

  it('lets demo mode mention the bundle and offer', async () => {
    setProviderOverride(() => createDemoProvider());
    let text = '';
    await handleChat({ tenantId: ids.gifts, message: 'best dad ever mug', emit: (e, d: any) => (e === 'text' ? (text += d.delta) : undefined) });
    setProviderOverride(null);
    expect(text).toContain('Dad gift set');
    expect(text).toContain('MUG15');
  });

  it('updates and deletes rules; Starter stores cannot use them', async () => {
    const list = (await app.inject({ method: 'GET', url: path(), headers: auth() })).json();
    expect(list.available).toBe(true);
    const rule = list.rules.find((r: any) => r.name === 'Mug promo');
    const upd = await app.inject({ method: 'PUT', url: path(`/${rule.id}`), headers: auth(), payload: { kind: 'discount', name: 'Mug promo', triggerField: 'tag', triggerValue: 'mugs', discountText: '20% off', active: false } });
    expect(upd.json()).toMatchObject({ discount_text: '20% off', active: false });
    expect((await related('GFT-006')).offers).toBeUndefined();
    expect((await app.inject({ method: 'DELETE', url: path(`/${rule.id}`), headers: auth() })).statusCode).toBe(200);

    await query(`UPDATE tenants SET plan = 'starter' WHERE id = $1`, [ids.gifts]);
    const r = await app.inject({ method: 'POST', url: path(), headers: auth(), payload: { kind: 'discount', name: 'D', triggerField: 'any', discountText: 'x' } });
    expect(r.statusCode).toBe(402);
    // Existing rules stop applying on Starter.
    const res = await related('GFT-006');
    expect(res.bundles).toBeUndefined();
    expect(res.products[0]?.why).not.toBe('store recommendation');
  });
});
