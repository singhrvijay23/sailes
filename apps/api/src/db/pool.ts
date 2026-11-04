import pg from 'pg';
import pgvector from 'pgvector/pg';
import { config } from '../config.js';

export type Db = pg.PoolClient;

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });

pool.on('connect', async (client) => {
  await pgvector.registerTypes(client);
});

/** Run a query outside tenant scope (global tables only: users, tenants, widget_keys, memberships). */
export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) {
  return pool.query<T>(text, params);
}

/**
 * Run `fn` in a transaction where row-level security is scoped to one tenant.
 * Every read and write of tenant data must go through here.
 */
export async function withTenant<T>(tenantId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
