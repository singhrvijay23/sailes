import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query, withTenant } from '../src/db/pool.js';
import { loadSearchContext, searchProducts } from '../src/search/search.js';
import { handleChat } from '../src/agent/orchestrator.js';
import { setProviderOverride } from '../src/ai/registry.js';
import { hashEmbed, HASH_EMBED_MODEL } from '../src/ai/hashEmbed.js';
import { ProviderError, type ChatProvider, type TurnInput } from '../src/ai/types.js';
import { seededDb } from './helpers.js';

let ids: Awaited<ReturnType<typeof seededDb>>;

beforeAll(async () => {
  ids = await seededDb();
});
afterAll(async () => {
  setProviderOverride(null);
  await pool.end();
});

const search = (tenantId: string, q: string, filters = {}) =>
  withTenant(tenantId, async (db) => searchProducts(db, { query: q, filters, queryVector: hashEmbed(q), embeddingModel: HASH_EMBED_MODEL }, await loadSearchContext(db)));

/** A fake LLM that runs a script against the real tools. */
function scripted(script: (input: TurnInput) => Promise<string>): ChatProvider {
  return {
    id: 'openai',
    model: 'gpt-5-mini',
    embeddingModel: HASH_EMBED_MODEL,
    validate: async () => {},
    embed: async (texts) => ({ vectors: texts.map(hashEmbed), tokens: 0 }),
    runTurn: async (input) => {
      const text = await script(input);
      input.onText(text);
      return { text, usage: { inputTokens: 1000, outputTokens: 100 }, rounds: 1, stopReason: 'done' };
    },
  };
}

function collect() {
  const events: Array<[string, any]> = [];
  return { events, emit: (e: string, d: unknown) => events.push([e, d]) };
}

describe('tenant isolation (row-level security)', () => {
  it('sees no tenant data without a tenant scope', async () => {
    const { rows } = await query('SELECT count(*)::int AS n FROM products');
    expect(rows[0].n).toBe(0);
  });

  it('only sees its own products inside a tenant scope', async () => {
    const n = await withTenant(ids.gifts, async (db) => (await db.query('SELECT count(*)::int AS n FROM products')).rows[0].n);
    expect(n).toBe(27);
    const leaked = await withTenant(ids.gifts, async (db) => (await db.query(`SELECT count(*)::int AS n FROM products WHERE external_id LIKE 'WEL-%'`)).rows[0].n);
    expect(leaked).toBe(0);
  });

  it('cannot write rows for another tenant', async () => {
    await expect(withTenant(ids.gifts, (db) => db.query(`INSERT INTO products (tenant_id, external_id, title) VALUES ($1, 'X', 'Sneaky')`, [ids.wellness]))).rejects.toThrow(/row-level security/);
  });
});

describe('hybrid search', () => {
  it('applies price, exclusion and attribute filters', async () => {
    const r = await search(ids.wellness, 'protein powder', { maxPrice: 40, excludeTerms: ['soy'], attributes: { protein_g: { min: 20 } } });
    expect(r.items.length).toBeGreaterThan(0);
    for (const p of r.items) {
      expect(p.price!).toBeLessThanOrEqual(40);
      expect(p.attributes.soy).not.toBe('yes');
      expect(Number(p.attributes.protein_g)).toBeGreaterThanOrEqual(20);
      expect(p.inStock).toBe(true);
    }
  });

  it('keeps "soy-free" products when excluding soy', async () => {
    const r = await search(ids.wellness, 'plant protein', { excludeTerms: ['soy'] });
    expect(r.items.some((p) => p.title.includes('Plant Protein'))).toBe(true);
  });

  it('tolerates typos', async () => {
    const r = await search(ids.wellness, 'protien shaker');
    expect(r.items.slice(0, 3).some((p) => /Shaker/.test(p.title))).toBe(true);
  });

  it('uses merchant synonyms', async () => {
    const r = await search(ids.apparel, 'sneakers');
    expect(r.items[0]!.categories).toContain('Footwear');
  });

  it('suggests facets for a broad query', async () => {
    const r = await search(ids.wellness, 'protein powder');
    expect(r.total).toBeGreaterThan(12);
    expect(r.facets.map((f) => f.attribute)).toEqual(expect.arrayContaining(['flavor']));
  });

  it('honours exclude and boost rules', async () => {
    const top = (await search(ids.apparel, 'jacket')).items[0]!;
    await withTenant(ids.apparel, (db) => db.query(`INSERT INTO merch_rules (tenant_id, action, match_field, match_value) VALUES ($1, 'exclude', 'product', $2)`, [ids.apparel, top.id]));
    const after = await search(ids.apparel, 'jacket');
    expect(after.items.map((p) => p.id)).not.toContain(top.id);
    await withTenant(ids.apparel, (db) => db.query(`DELETE FROM merch_rules`));
  });
});

describe('sales agent orchestration', () => {
  it('demo mode asks a counter-question for a broad request, then recommends', async () => {
    setProviderOverride(null);
    const a = collect();
    const first = await handleChat({ tenantId: ids.wellness, message: 'protein powder', emit: a.emit });
    const q = a.events.find(([e]) => e === 'question')?.[1];
    expect(q.options.length).toBeGreaterThanOrEqual(2);
    const b = collect();
    await handleChat({ tenantId: ids.wellness, conversationId: first.conversationId, message: q.options[0], emit: b.emit });
    expect(b.events.find(([e]) => e === 'products')?.[1].items.length).toBeGreaterThan(0);
  });

  it('blocks invented, ungrounded and out-of-stock products', async () => {
    await query(`UPDATE tenants SET ai_mode = 'byok' WHERE id = $1`, [ids.wellness]);
    const outOfStock = (await withTenant(ids.wellness, (db) => db.query(`SELECT external_id FROM products WHERE NOT in_stock LIMIT 1`))).rows[0]?.external_id ?? 'NONE';
    let toolResult: any;
    setProviderOverride(() =>
      scripted(async (input) => {
        const found: any = await input.executeTool('search_products', { query: 'shaker bottle' });
        toolResult = await input.executeTool('show_products', {
          items: [
            { product_id: found.products[0].id, reason: 'real' },
            { product_id: 'WEL-999', reason: 'invented' },
            { product_id: 'WEL-031', reason: 'real product never returned by a tool' },
            { product_id: outOfStock, reason: 'out of stock' },
          ],
        });
        return 'Here you go.';
      }),
    );
    const c = collect();
    const out = await handleChat({ tenantId: ids.wellness, message: 'shaker', emit: c.emit });
    const cards = c.events.filter(([e]) => e === 'products').flatMap(([, d]) => d.items);
    expect(cards).toHaveLength(1);
    expect(cards[0].price).toBeTypeOf('number'); // price comes from the database, not the model
    expect(toolResult.rejected.map((r: any) => r.reason)).toEqual(expect.arrayContaining(['not in catalog', 'not returned by a search tool in this conversation']));
    expect(out.mode).toBe('ai');
    await query(`UPDATE tenants SET ai_mode = 'demo' WHERE id = $1`, [ids.wellness]);
  });

  it('stops counter-questions after two in a row', async () => {
    const answers: any[] = [];
    setProviderOverride(() =>
      scripted(async (input) => {
        await input.executeTool('search_products', { query: 'gift' });
        answers.push(await input.executeTool('ask_question', { question: 'Who is it for?', options: ['Her', 'Him'] }));
        return 'Who is it for?';
      }),
    );
    let conv: string | null = null;
    for (const m of ['gift', 'not sure', 'still not sure']) conv = (await handleChat({ tenantId: ids.gifts, conversationId: conv, message: m, emit: () => {} })).conversationId;
    expect(answers[0]).toEqual({ ok: true });
    expect(answers[1]).toEqual({ ok: true });
    expect(answers[2].error).toMatch(/limit/);
  });

  it('falls back to keyword mode when the AI provider fails', async () => {
    setProviderOverride(() =>
      scripted(async () => {
        throw new ProviderError('OpenAI rejected the API key', 'auth');
      }),
    );
    const c = collect();
    const out = await handleChat({ tenantId: ids.apparel, message: 'rain jacket', emit: c.emit });
    expect(out.mode).toBe('fallback');
    expect(c.events.some(([e]) => e === 'products')).toBe(true);
    const err = await withTenant(ids.apparel, (db) => db.query(`SELECT meta FROM events WHERE type = 'ai_error'`));
    expect(err.rows[0].meta.kind).toBe('auth');
  });

  it('switches to keyword mode once the monthly AI budget is spent', async () => {
    await query(`UPDATE tenants SET ai_mode = 'byok', monthly_budget_usd = 0 WHERE id = $1`, [ids.gifts]);
    setProviderOverride(() => scripted(async () => 'should not run'));
    const out = await handleChat({ tenantId: ids.gifts, message: 'candle', emit: () => {} });
    expect(out.mode).toBe('fallback');
    await query(`UPDATE tenants SET ai_mode = 'demo', monthly_budget_usd = 50 WHERE id = $1`, [ids.gifts]);
  });

  it('records usage and analytics events', async () => {
    setProviderOverride(null);
    await handleChat({ tenantId: ids.apparel, message: 'unicorn saddle polish', emit: () => {} });
    const ev = await withTenant(ids.apparel, (db) => db.query(`SELECT type, query FROM events WHERE type IN ('zero_result','search','impression')`));
    expect(ev.rows.some((r) => r.type === 'impression')).toBe(true);
    const usage = await withTenant(ids.wellness, (db) => db.query('SELECT conversations, input_tokens::int AS input_tokens FROM usage_monthly'));
    expect(usage.rows[0].conversations).toBeGreaterThan(0);
    expect(usage.rows[0].input_tokens).toBeGreaterThan(0);
  });
});
