import pg from 'pg';
import { seal, unseal } from './crypto.js';

export interface SailesLink {
  storeId: string;
  /** sk_ key. Server side only, never sent to the browser or logged. */
  apiKey: string;
  apiUrl: string;
  widgetKey: string | null;
  widgetScriptUrl: string;
}

export interface SyncResult {
  at: string;
  kind: 'full' | 'product' | 'policies';
  created: number;
  updated: number;
  unchanged: number;
  rejected: number;
  deleted: number;
  error?: string;
}

export interface ShopRecord {
  shop: string;
  accessToken: string | null;
  refreshToken: string | null;
  /** Epoch ms. Null for tokens that do not expire. */
  accessTokenExpiresAt: number | null;
  refreshTokenExpiresAt: number | null;
  scope: string | null;
  sailes: SailesLink | null;
  connectState: string | null;
  connectStateExpiresAt: number | null;
  installedAt: number;
  uninstalledAt: number | null;
  lastFullSyncAt: number | null;
  lastSync: SyncResult | null;
}

export interface ShopStore {
  get(shop: string): Promise<ShopRecord | null>;
  /** Creates the record when missing. Returns the merged record. */
  upsert(shop: string, patch: Partial<Omit<ShopRecord, 'shop'>>): Promise<ShopRecord>;
  findByConnectState(state: string): Promise<ShopRecord | null>;
  delete(shop: string): Promise<void>;
  /** Installed, connected shops whose last full sync is older than `before` (epoch ms). */
  dueForResync(before: number): Promise<string[]>;
  close(): Promise<void>;
}

const blank = (shop: string): ShopRecord => ({
  shop,
  accessToken: null,
  refreshToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
  scope: null,
  sailes: null,
  connectState: null,
  connectStateExpiresAt: null,
  installedAt: Date.now(),
  uninstalledAt: null,
  lastFullSyncAt: null,
  lastSync: null,
});

export class MemoryStore implements ShopStore {
  private shops = new Map<string, ShopRecord>();
  async get(shop: string) {
    const r = this.shops.get(shop);
    return r ? structuredClone(r) : null;
  }
  async upsert(shop: string, patch: Partial<ShopRecord>) {
    const r = { ...(this.shops.get(shop) ?? blank(shop)), ...patch, shop };
    this.shops.set(shop, r);
    return structuredClone(r);
  }
  async findByConnectState(state: string) {
    for (const r of this.shops.values()) if (r.connectState === state) return structuredClone(r);
    return null;
  }
  async delete(shop: string) {
    this.shops.delete(shop);
  }
  async dueForResync(before: number) {
    return [...this.shops.values()].filter((r) => r.accessToken && r.sailes && !r.uninstalledAt && (r.lastFullSyncAt ?? 0) < before).map((r) => r.shop);
  }
  async close() {}
}

/**
 * Postgres store. Secrets (Shopify tokens and the SAILES key) are sealed with AES-256-GCM in one
 * `secrets` column; everything else is plain JSON so it can be inspected.
 */
export class PgStore implements ShopStore {
  private pool: pg.Pool;
  private ready: Promise<void>;
  constructor(databaseUrl: string, private key: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
    this.ready = this.pool
      .query(
        `CREATE TABLE IF NOT EXISTS shopify_shops (
           shop text PRIMARY KEY,
           secrets text,
           data jsonb NOT NULL,
           connect_state text UNIQUE,
           updated_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      .then(() => undefined);
  }

  private toRow(r: ShopRecord) {
    const { accessToken, refreshToken, sailes, ...rest } = r;
    const secrets = seal(JSON.stringify({ accessToken, refreshToken, sailesApiKey: sailes?.apiKey ?? null }), this.key);
    const data = { ...rest, sailes: sailes ? { ...sailes, apiKey: undefined } : null };
    return { secrets, data };
  }

  private fromRow(row: { shop: string; secrets: string | null; data: Omit<ShopRecord, 'accessToken' | 'refreshToken'> }): ShopRecord {
    const s = row.secrets ? JSON.parse(unseal(row.secrets, this.key)) : {};
    const sailes = row.data.sailes ? { ...row.data.sailes, apiKey: s.sailesApiKey ?? '' } : null;
    return { ...blank(row.shop), ...row.data, shop: row.shop, accessToken: s.accessToken ?? null, refreshToken: s.refreshToken ?? null, sailes };
  }

  async get(shop: string) {
    await this.ready;
    const row = (await this.pool.query('SELECT shop, secrets, data FROM shopify_shops WHERE shop = $1', [shop])).rows[0];
    return row ? this.fromRow(row) : null;
  }

  async upsert(shop: string, patch: Partial<ShopRecord>) {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query('SELECT shop, secrets, data FROM shopify_shops WHERE shop = $1 FOR UPDATE', [shop])).rows[0];
      const merged: ShopRecord = { ...(row ? this.fromRow(row) : blank(shop)), ...patch, shop };
      const { secrets, data } = this.toRow(merged);
      await client.query(
        `INSERT INTO shopify_shops (shop, secrets, data, connect_state) VALUES ($1, $2, $3, $4)
         ON CONFLICT (shop) DO UPDATE SET secrets = $2, data = $3, connect_state = $4, updated_at = now()`,
        [shop, secrets, data, merged.connectState],
      );
      await client.query('COMMIT');
      return merged;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async findByConnectState(state: string) {
    await this.ready;
    const row = (await this.pool.query('SELECT shop, secrets, data FROM shopify_shops WHERE connect_state = $1', [state])).rows[0];
    return row ? this.fromRow(row) : null;
  }

  async delete(shop: string) {
    await this.ready;
    await this.pool.query('DELETE FROM shopify_shops WHERE shop = $1', [shop]);
  }

  async dueForResync(before: number) {
    await this.ready;
    const rows = await this.pool.query(
      `SELECT shop FROM shopify_shops
       WHERE data->'sailes' IS NOT NULL AND data->'sailes' <> 'null'::jsonb
         AND (data->>'uninstalledAt') IS NULL
         AND coalesce((data->>'lastFullSyncAt')::bigint, 0) < $1`,
      [before],
    );
    return rows.rows.map((r) => r.shop as string);
  }

  async close() {
    await this.pool.end();
  }
}
