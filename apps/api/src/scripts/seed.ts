/**
 * Creates a demo merchant account with three sample stores (wellness, gifts, apparel),
 * imports their catalogs and policies, and prints the widget keys for manual testing.
 *
 *   pnpm seed            -> demo@sailes.dev / sailes-demo-123
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query, withTenant } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../lib/password.js';
import { normalizeMany } from '../catalog/normalize.js';
import { upsertProducts, embedPendingProducts } from '../catalog/service.js';
import { createDemoProvider } from '../ai/providers/demo.js';
import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLE_STORES = ['wellness', 'gifts', 'apparel'] as const;

const SYNONYMS: Record<string, Array<[string, string[]]>> = {
  wellness: [['shake', ['protein powder']], ['vegan', ['plant']], ['tub', ['protein powder']]],
  gifts: [['mom', ['women', 'mother']], ['dad', ['men', 'father']], ['wife', ['women']], ['husband', ['men']], ['girlfriend', ['women']], ['boyfriend', ['men']], ['her', ['women']], ['him', ['men']]],
  apparel: [['sneakers', ['running shoe', 'trainer']], ['trainers', ['running shoe']], ['raincoat', ['rain jacket']], ['sweatshirt', ['hoodie']], ['t-shirt', ['tee']], ['shirt', ['tee']]],
};

const SUGGESTIONS: Record<string, string[]> = {
  wellness: ['Protein powder under $40', 'Something for better sleep', 'Home workout gear'],
  gifts: ['Birthday gift for my mom', 'Gift for him under $40', 'Housewarming ideas'],
  apparel: ['Waterproof trail shoes', 'Running gear for men', 'Warm jacket'],
};

export async function seedStore(ownerId: string, key: (typeof SAMPLE_STORES)[number]) {
  const data = JSON.parse(await readFile(path.join(here, '../data/samples', `${key}.json`), 'utf8'));
  const existing = (await query('SELECT t.id FROM tenants t JOIN memberships m ON m.tenant_id = t.id WHERE m.user_id = $1 AND t.name = $2', [ownerId, data.store.name])).rows[0];
  const tenantId: string =
    existing?.id ??
    (
      await query(`INSERT INTO tenants (name, site_url, plan, trial_ends_at, settings) VALUES ($1, $2, 'pro', now() + interval '14 days', $3) RETURNING id`, [
        data.store.name,
        `https://demo-${key}.example`,
        {
          assistantName: 'Sage',
          tone: 'friendly',
          storeDescription: data.store.description,
          greeting: `Hi, I'm Sage! Tell me what you're looking for and I'll find the best match at ${data.store.name.replace(' (demo)', '')}.`,
          primaryColor: '#1B2A4A',
          placement: 'bottom-right',
          suggestions: SUGGESTIONS[key],
        },
      ])
    ).rows[0].id;
  if (!existing) {
    await query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`, [ownerId, tenantId]);
    await query('INSERT INTO widget_keys (key, tenant_id) VALUES ($1, $2)', [`pk_demo_${key}`, tenantId]);
  }
  const { products, errors } = normalizeMany(data.products);
  if (errors.length) console.warn(key, errors);
  const summary = await withTenant(tenantId, async (db) => {
    for (const [topic, content] of Object.entries(data.policies)) {
      await db.query('INSERT INTO policies (tenant_id, topic, content) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, topic) DO UPDATE SET content = EXCLUDED.content', [tenantId, topic, content]);
    }
    for (const [term, syns] of SYNONYMS[key] ?? []) {
      await db.query('INSERT INTO synonyms (tenant_id, term, synonyms) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, term) DO UPDATE SET synonyms = EXCLUDED.synonyms', [tenantId, term, syns]);
    }
    return upsertProducts(db, tenantId, 'pro', products);
  });
  await embedPendingProducts(tenantId, createDemoProvider());
  return { tenantId, key: `pk_demo_${key}`, name: data.store.name, ...summary };
}

export async function seedDemo(email = 'demo@sailes.dev', password = 'sailes-demo-123') {
  await migrate(() => {});
  let user = (await query('SELECT id FROM users WHERE email = $1', [email])).rows[0];
  if (!user) user = (await query('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id', [email, 'Demo Merchant', await hashPassword(password)])).rows[0];
  const stores = [];
  for (const k of SAMPLE_STORES) stores.push(await seedStore(user.id, k));
  return { email, password, stores };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seedDemo()
    .then((r) => {
      console.log(`\nDemo login: ${r.email} / ${r.password}`);
      for (const s of r.stores) {
        console.log(`\n${s.name}: ${s.created + s.updated + s.unchanged} products`);
        console.log(`  widget key: ${s.key}`);
        console.log(`  try it:     ${config.publicApiUrl}/demo/?key=${s.key}`);
      }
      return pool.end();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
