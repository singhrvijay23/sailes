/**
 * Answer-quality eval: runs shopper questions against the three sample stores and checks
 * that every recommended product is real, in stock and relevant. Part 1's release gate is
 * 90%+ relevant answers and zero invented products.
 *
 *   pnpm --filter @sailes/api eval                                  # demo (rule-based) mode
 *   EVAL_PROVIDER=openai EVAL_API_KEY=sk-... pnpm --filter @sailes/api eval
 *   EVAL_PROVIDER=anthropic EVAL_API_KEY=... EVAL_MODEL=claude-haiku-5-5 pnpm ... eval
 *
 * Needs the sample stores (pnpm seed). Real-provider runs cost a few cents.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query, withTenant } from '../db/pool.js';
import { handleChat } from '../agent/orchestrator.js';
import { buildProvider, setProviderOverride } from '../ai/registry.js';
import { embedPendingProducts, invalidateEmbeddings } from '../catalog/service.js';
import type { ProductCard } from '../agent/tools.js';

interface Case {
  store: 'wellness' | 'gifts' | 'apparel';
  turns: string[];
  expect: {
    titleAny?: string[];
    category?: string;
    attr?: Record<string, string>;
    attrNot?: Record<string, string>;
    maxPrice?: number;
    asksOrShows?: boolean;
    noProductsOk?: boolean;
    textAny?: string[];
    textNone?: string[];
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const cases: Case[] = JSON.parse(await readFile(path.join(here, '../data/eval-cases.json'), 'utf8'));

const providerId = process.env.EVAL_PROVIDER as 'openai' | 'gemini' | 'anthropic' | undefined;
const tenants: Record<string, string> = {};
for (const s of ['wellness', 'gifts', 'apparel']) {
  const row = (await query('SELECT tenant_id FROM widget_keys WHERE key = $1', [`pk_demo_${s}`])).rows[0];
  if (!row) throw new Error('Sample stores missing: run `pnpm seed` first');
  tenants[s] = row.tenant_id;
}

if (providerId) {
  const provider = buildProvider(providerId, process.env.EVAL_API_KEY ?? '', process.env.EVAL_MODEL);
  setProviderOverride(() => provider);
  for (const t of Object.values(tenants)) {
    await query(`UPDATE tenants SET ai_mode = 'byok' WHERE id = $1`, [t]);
    // Embed the sample catalogs with this provider's embedding model.
    if ((await withTenant(t, (db) => invalidateEmbeddings(db, provider.embeddingModel))) > 0) await embedPendingProducts(t, provider);
  }
}

const detail = async (tenantId: string, ids: string[]) =>
  withTenant(tenantId, async (db) => (await db.query('SELECT external_id, title, categories, attributes, price::float AS price, in_stock FROM products WHERE external_id = ANY($1)', [ids])).rows);

let pass = 0;
let invented = 0;
const failures: string[] = [];
const started = Date.now();
for (const c of cases) {
  let conv: string | null = null;
  let text = '';
  let cards: ProductCard[] = [];
  let asked = false;
  const rejected: string[] = [];
  for (const turn of c.turns) {
    text = '';
    cards = [];
    const out = await handleChat({
      tenantId: tenants[c.store]!,
      conversationId: conv,
      message: turn,
      emit: (e, d: any) => {
        if (e === 'text') text += d.delta;
        if (e === 'products') cards.push(...d.items);
        if (e === 'question') asked = true;
        if (e === 'reset') {
          text = '';
          cards = [];
        }
      },
    });
    conv = out.conversationId;
    const msg = (await withTenant(tenants[c.store]!, (db) => db.query(`SELECT payload FROM messages WHERE conversation_id = $1 AND role = 'assistant' ORDER BY id DESC LIMIT 1`, [conv]))).rows[0];
    for (const r of msg?.payload?.rejected ?? []) if (r.reason === 'not in catalog') rejected.push(r.id);
  }
  invented += rejected.length;
  const rows = await detail(tenants[c.store]!, cards.map((x) => x.id));
  const problems: string[] = [];
  const e = c.expect;
  const lower = text.toLowerCase();
  if (rows.some((r) => !r.in_stock)) problems.push('showed an out-of-stock product');
  if (!cards.length && !(e.noProductsOk || (e.asksOrShows && asked))) problems.push('no products shown');
  if (cards.length) {
    const top = rows;
    if (e.titleAny && !top.some((r) => e.titleAny!.some((t) => r.title.toLowerCase().includes(t.toLowerCase())))) problems.push(`no title with ${e.titleAny.join('/')}`);
    if (e.category && !top.some((r) => r.categories.includes(e.category))) problems.push(`no product in ${e.category}`);
    if (e.maxPrice != null && top.some((r) => r.price > e.maxPrice!)) problems.push(`over budget $${e.maxPrice}`);
    for (const [k, v] of Object.entries(e.attr ?? {})) if (!top.some((r) => String(r.attributes[k] ?? '').toLowerCase().includes(v))) problems.push(`no product with ${k}=${v}`);
    for (const [k, v] of Object.entries(e.attrNot ?? {})) if (top.some((r) => String(r.attributes[k] ?? '').toLowerCase() === v)) problems.push(`showed ${k}=${v}`);
  }
  if (e.textAny && !e.textAny.some((t) => lower.includes(t.toLowerCase()))) problems.push(`text lacks ${e.textAny.join('/')}`);
  if (e.textNone?.some((t) => lower.includes(t))) problems.push('off-topic text');
  if (rejected.length) problems.push(`tried to show invented ids ${rejected.join(', ')}`);
  if (problems.length) failures.push(`[${c.store}] "${c.turns.join(' → ')}": ${problems.join('; ')}\n    reply: ${text.slice(0, 160)}\n    cards: ${rows.map((r) => r.title).join(' | ')}`);
  else pass++;
}

const pct = Math.round((pass / cases.length) * 100);
console.log(`\nSAILES answer-quality eval · ${providerId ? `${providerId} ${process.env.EVAL_MODEL ?? '(default model)'}` : 'demo mode'}`);
console.log(`${pass}/${cases.length} passed (${pct}%) · invented products attempted: ${invented} · ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (failures.length) console.log('\nFailures:\n' + failures.join('\n'));
console.log(`\nGate (90% relevant, 0 invented): ${pct >= 90 && invented === 0 ? 'PASS' : 'NOT YET'}`);

if (providerId) for (const t of Object.values(tenants)) await query(`UPDATE tenants SET ai_mode = 'demo' WHERE id = $1`, [t]);
await pool.end();
