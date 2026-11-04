import { migrate } from '../src/db/migrate.js';
import { query } from '../src/db/pool.js';
import { seedDemo } from '../src/scripts/seed.js';

export async function resetDb() {
  await migrate(() => {});
  await query('TRUNCATE users, tenants CASCADE');
}

/** Fresh database with the three sample stores. Returns tenant ids by store key. */
export async function seededDb() {
  await resetDb();
  const r = await seedDemo();
  const ids: Record<string, string> = {};
  for (const s of r.stores) ids[s.key.replace('pk_demo_', '')] = s.tenantId;
  return ids as { wellness: string; gifts: string; apparel: string };
}
