import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PgStore } from '../src/store.js';
import { config } from './fakes.js';

// Runs when a database is available: SHOPIFY_TEST_DATABASE_URL=postgres://... pnpm test
const url = process.env.SHOPIFY_TEST_DATABASE_URL;

describe.skipIf(!url)('Postgres shop store', () => {
  const store = url ? new PgStore(url, config.encryptionKey) : null!;
  afterAll(async () => store?.close());

  it('round-trips a shop and keeps secrets encrypted at rest', async () => {
    const shop = `pg-${Date.now()}.myshopify.com`;
    await store.upsert(shop, { accessToken: 'shpat_x', refreshToken: 'shprt_x', connectState: 'state-abc-' + shop });
    await store.upsert(shop, { sailes: { storeId: 's1', apiKey: 'sk_pg_secret', apiUrl: 'https://api', widgetKey: 'pk', widgetScriptUrl: 'https://api/w.js' }, lastFullSyncAt: 1 });
    expect(await store.get(shop)).toMatchObject({ accessToken: 'shpat_x', refreshToken: 'shprt_x', sailes: { apiKey: 'sk_pg_secret', widgetKey: 'pk' }, lastFullSyncAt: 1 });
    expect((await store.findByConnectState('state-abc-' + shop))?.shop).toBe(shop);
    expect(await store.dueForResync(Date.now())).toContain(shop);

    const c = new pg.Client({ connectionString: url });
    await c.connect();
    const raw = JSON.stringify((await c.query('SELECT * FROM shopify_shops WHERE shop = $1', [shop])).rows[0]);
    await c.end();
    expect(raw).not.toContain('sk_pg_secret');
    expect(raw).not.toContain('shpat_x');

    await store.delete(shop);
    expect(await store.get(shop)).toBeNull();
  });
});
