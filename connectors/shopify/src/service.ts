import type { AppConfig } from './config.js';
import { randomState } from './crypto.js';
import type { FetchFn, SleepFn } from './http.js';
import { realSleep } from './http.js';
import type { Logger } from './jobs.js';
import { JobQueue } from './jobs.js';
import {
  gid,
  htmlToText,
  POLICY_TOPICS,
  PRODUCT_BY_ID,
  PRODUCT_FOR_INVENTORY_ITEM,
  PRODUCTS_PAGE,
  SET_METAFIELDS,
  SHOP_INFO,
  toSailesOrder,
  toSailesProduct,
  type GqlProduct,
  type SailesProduct,
} from './mapping.js';
import { exchangeCode, SailesClient, SailesError, type AiSettings } from './sailes.js';
import { adminGraphql, exchangeSessionToken, refreshAccessToken, ShopifyError } from './shopify.js';
import type { ShopRecord, ShopStore, SyncResult } from './store.js';

const CONNECT_TTL_MS = 15 * 60_000;
/** Refresh a little before expiry so a long full sync does not run out mid-way. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const UPSERT_BATCH = 500;

export class NotConnectedError extends Error {
  constructor() {
    super('This shop is not connected to SAILES yet');
  }
}

interface ShopInfo {
  shop: { name: string; currencyCode: string; myshopifyDomain: string; primaryDomain: { url: string }; shopPolicies: { type: string; body: string }[] };
  currentAppInstallation: { id: string };
}

/** Errors worth retrying in the background (not 4xx from SAILES or Shopify, except 429). */
export const retryable = (e: unknown) => {
  if (e instanceof SailesError) return e.status === 0 || e.status === 429 || e.status >= 500;
  if (e instanceof ShopifyError) return e.status === 429 || e.status >= 500;
  return !(e instanceof NotConnectedError);
};

export class ShopifyConnector {
  readonly jobs: JobQueue;
  private refreshing = new Map<string, Promise<string>>();

  constructor(
    private cfg: AppConfig,
    readonly store: ShopStore,
    private log: Logger,
    private fetchFn: FetchFn = fetch,
    private sleep: SleepFn = realSleep,
  ) {
    this.jobs = new JobQueue(log);
  }

  // ---------- Shopify access tokens ----------

  /** Called on every admin request: makes sure we hold a working offline token for the shop. */
  async ensureToken(shop: string, sessionToken: string): Promise<ShopRecord> {
    const rec = await this.store.get(shop);
    const now = Date.now();
    const usable = rec?.accessToken && !rec.uninstalledAt && (!rec.accessTokenExpiresAt || rec.accessTokenExpiresAt > now + REFRESH_MARGIN_MS || (rec.refreshToken && (rec.refreshTokenExpiresAt ?? Infinity) > now + REFRESH_MARGIN_MS));
    if (usable) return rec!;
    const t = await exchangeSessionToken(shop, sessionToken, this.cfg.apiKey, this.cfg.apiSecret, this.fetchFn);
    const fresh = !rec || rec.uninstalledAt;
    const saved = await this.store.upsert(shop, { ...t, uninstalledAt: null, ...(fresh ? { installedAt: now } : {}) });
    this.log.info({ shop }, fresh ? 'installed' : 'token renewed');
    return saved;
  }

  /** Current offline token, refreshed when close to expiry. One refresh per shop at a time (refresh tokens rotate). */
  async accessToken(shop: string, force = false): Promise<string> {
    const rec = await this.store.get(shop);
    if (!rec?.accessToken || rec.uninstalledAt) throw new ShopifyError(401, 'No Shopify access token for this shop; open the app in Shopify admin', 'reauth_needed');
    const expiring = rec.accessTokenExpiresAt !== null && rec.accessTokenExpiresAt < Date.now() + REFRESH_MARGIN_MS;
    if (!force && !expiring) return rec.accessToken;
    if (!rec.refreshToken) {
      if (!expiring) return rec.accessToken;
      throw new ShopifyError(401, 'Shopify token expired and cannot be refreshed; open the app in Shopify admin', 'reauth_needed');
    }
    const running = this.refreshing.get(shop);
    if (running) return running;
    const p = (async () => {
      const t = await refreshAccessToken(shop, rec.refreshToken!, this.cfg.apiKey, this.cfg.apiSecret, this.fetchFn);
      await this.store.upsert(shop, { ...t, refreshToken: t.refreshToken ?? rec.refreshToken, scope: t.scope ?? rec.scope });
      return t.accessToken;
    })().finally(() => this.refreshing.delete(shop));
    this.refreshing.set(shop, p);
    return p;
  }

  gql<T>(shop: string, query: string, variables: Record<string, unknown> = {}) {
    return adminGraphql<T>({ shop, apiVersion: this.cfg.apiVersion, getToken: (force) => this.accessToken(shop, force), fetchFn: this.fetchFn, sleep: this.sleep }, query, variables);
  }

  private async linked(shop: string) {
    const rec = await this.store.get(shop);
    if (!rec?.sailes) throw new NotConnectedError();
    return { rec, sailes: new SailesClient(rec.sailes, this.fetchFn, this.sleep) };
  }

  // ---------- Connect to SAILES ----------

  /** Step 1 of the install flow: the console URL the merchant opens. */
  async startConnect(shop: string): Promise<string> {
    const info = await this.gql<ShopInfo>(shop, SHOP_INFO);
    const state = randomState();
    await this.store.upsert(shop, { connectState: state, connectStateExpiresAt: Date.now() + CONNECT_TTL_MS });
    const u = new URL(`${this.cfg.sailesConsoleUrl}/connect`);
    u.searchParams.set('platform', 'shopify');
    // The storefront origin shoppers visit: it goes on the widget key's allowed sites.
    u.searchParams.set('shop', new URL(info.shop.primaryDomain.url).origin);
    u.searchParams.set('redirect_uri', `${this.cfg.appUrl}/connect/callback`);
    u.searchParams.set('state', state);
    return u.toString();
  }

  /** Step 3: the console sent the merchant back with a code. Returns the shop. */
  async finishConnect(state: string, code: string): Promise<string> {
    const rec = await this.store.findByConnectState(state);
    if (!rec || !rec.connectStateExpiresAt || rec.connectStateExpiresAt < Date.now()) throw new SailesError(400, 'invalid_state', 'This connection link expired. Open SAILES in Shopify admin and click Connect again.');
    await this.store.upsert(rec.shop, { connectState: null, connectStateExpiresAt: null });
    const ex = await exchangeCode(this.cfg.sailesApiUrl, code, this.fetchFn, this.sleep);
    await this.store.upsert(rec.shop, {
      sailes: { storeId: ex.storeId, apiKey: ex.apiKey, apiUrl: ex.apiUrl.replace(/\/$/, ''), widgetKey: ex.widgetKey, widgetScriptUrl: ex.widgetScriptUrl },
      lastFullSyncAt: null,
      lastSync: null,
    });
    this.log.info({ shop: rec.shop, storeId: ex.storeId }, 'connected to SAILES');
    this.jobs.enqueue(rec.shop, 'widget', () => this.publishWidgetSettings(rec.shop), retryable);
    this.queueFullSync(rec.shop);
    return rec.shop;
  }

  /** Writes the widget key and script URL to app metafields, which the theme app embed reads. */
  async publishWidgetSettings(shop: string) {
    const { rec } = await this.linked(shop);
    const info = await this.gql<ShopInfo>(shop, SHOP_INFO);
    const ownerId = info.currentAppInstallation.id;
    const mf = (key: string, value: string) => ({ ownerId, namespace: 'sailes', key, type: 'single_line_text_field', value });
    const metafields = [mf('script_url', rec.sailes!.widgetScriptUrl)];
    if (rec.sailes!.widgetKey) metafields.push(mf('widget_key', rec.sailes!.widgetKey));
    const r = await this.gql<{ metafieldsSet: { userErrors: { message: string }[] } }>(shop, SET_METAFIELDS, { metafields });
    if (r.metafieldsSet.userErrors.length) throw new ShopifyError(400, r.metafieldsSet.userErrors.map((e) => e.message).join('; '));
  }

  // ---------- Catalog and policies ----------

  queueFullSync(shop: string) {
    this.jobs.enqueue(shop, 'full-sync', () => this.fullSync(shop), retryable);
    this.jobs.enqueue(shop, 'policies', () => this.syncPolicies(shop), retryable);
  }

  async fullSync(shop: string): Promise<SyncResult> {
    const { sailes } = await this.linked(shop);
    const result: SyncResult = { at: new Date().toISOString(), kind: 'full', created: 0, updated: 0, unchanged: 0, rejected: 0, deleted: 0 };
    let batch: SailesProduct[] = [];
    let remove: string[] = [];
    const flush = async () => {
      if (batch.length) {
        const r = await sailes.upsertProducts(batch);
        result.created += r.created;
        result.updated += r.updated;
        result.unchanged += r.unchanged;
        result.rejected += r.rejected;
        batch = [];
      }
      if (remove.length) {
        await sailes.deleteProducts(remove);
        result.deleted += remove.length;
        remove = [];
      }
    };
    try {
      let cursor: string | null = null;
      do {
        const page: { shop: { currencyCode: string }; products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlProduct[] } } = await this.gql(shop, PRODUCTS_PAGE, { cursor });
        for (const p of page.products.nodes) {
          const mapped = toSailesProduct(p, page.shop.currencyCode);
          if (mapped) batch.push(mapped);
          else remove.push(p.legacyResourceId);
        }
        if (batch.length >= UPSERT_BATCH || remove.length >= UPSERT_BATCH) await flush();
        cursor = page.products.pageInfo.hasNextPage ? page.products.pageInfo.endCursor : null;
      } while (cursor);
      await flush();
    } catch (e) {
      result.error = e instanceof SailesError && e.code === 'product_limit' ? e.message : (e as Error).message;
      await this.store.upsert(shop, { lastSync: result });
      throw e;
    }
    await this.store.upsert(shop, { lastSync: result, lastFullSyncAt: Date.now() });
    this.log.info({ shop, ...result }, 'full sync done');
    return result;
  }

  /** One product changed (webhook). Fetches it fresh so the data is never older than the event. */
  async syncProduct(shop: string, productId: string) {
    const { sailes } = await this.linked(shop);
    const r = await this.gql<{ shop: { currencyCode: string }; product: GqlProduct | null }>(shop, PRODUCT_BY_ID, { id: gid('Product', productId) });
    const mapped = r.product ? toSailesProduct(r.product, r.shop.currencyCode) : null;
    if (mapped) await sailes.upsertProducts([mapped]);
    else await sailes.deleteProducts([productId]);
  }

  async deleteProduct(shop: string, productId: string) {
    const { sailes } = await this.linked(shop);
    await sailes.deleteProducts([productId]);
  }

  /** inventory_levels/update names an inventory item; find its product and resync it. */
  async syncInventoryItem(shop: string, inventoryItemId: string) {
    const r = await this.gql<{ inventoryItem: { variant: { product: { id: string } } | null } | null }>(shop, PRODUCT_FOR_INVENTORY_ITEM, { id: gid('InventoryItem', inventoryItemId) });
    const productGid = r.inventoryItem?.variant?.product.id;
    if (productGid) this.queueProduct(shop, productGid.split('/').pop()!);
  }

  queueProduct(shop: string, productId: string) {
    this.jobs.enqueue(shop, `product:${productId}`, () => this.syncProduct(shop, productId), retryable);
  }

  async syncPolicies(shop: string) {
    const { sailes } = await this.linked(shop);
    const info = await this.gql<ShopInfo>(shop, SHOP_INFO);
    let sent = 0;
    for (const p of info.shop.shopPolicies) {
      const topic = POLICY_TOPICS[p.type];
      const content = topic ? htmlToText(p.body ?? '') : '';
      if (!topic || !content) continue;
      await sailes.putPolicy(topic, content);
      sent++;
    }
    return sent;
  }

  async reportOrder(shop: string, order: Parameters<typeof toSailesOrder>[0]) {
    const { sailes } = await this.linked(shop);
    const o = toSailesOrder(order);
    await sailes.reportOrder({ ...o, productIds: o.productIds.slice(0, 200) });
  }

  // ---------- Lifecycle ----------

  /** app/uninstalled: revoke the SAILES key and drop the Shopify tokens (they no longer work). */
  async uninstalled(shop: string) {
    const rec = await this.store.get(shop);
    if (!rec) return;
    if (rec.sailes) {
      try {
        await new SailesClient(rec.sailes, this.fetchFn, this.sleep).disconnect();
      } catch (e) {
        this.log.warn({ shop, err: (e as Error).message }, 'SAILES disconnect failed');
      }
    }
    await this.store.upsert(shop, { accessToken: null, refreshToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null, sailes: null, uninstalledAt: Date.now(), connectState: null });
    this.log.info({ shop }, 'uninstalled');
  }

  /** shop/redact (48 hours after uninstall): erase everything we hold for the shop. */
  async redactShop(shop: string) {
    await this.store.delete(shop);
  }

  /** Periodic full resync for every connected shop (catches missed webhooks). */
  async resyncDue() {
    const due = await this.store.dueForResync(Date.now() - this.cfg.resyncHours * 3_600_000);
    for (const shop of due) this.queueFullSync(shop);
    return due.length;
  }

  // ---------- Admin page ----------

  async status(shop: string) {
    const rec = await this.store.get(shop);
    const base = { shop, connected: Boolean(rec?.sailes), lastSync: rec?.lastSync ?? null, lastFullSyncAt: rec?.lastFullSyncAt ?? null };
    if (!rec?.sailes) return { ...base, store: null };
    try {
      const store = await new SailesClient(rec.sailes, this.fetchFn, this.sleep).getStore();
      // The widget key can change in the console; keep the theme embed in step.
      if (store.widgetKey && store.widgetKey !== rec.sailes.widgetKey) {
        await this.store.upsert(shop, { sailes: { ...rec.sailes, widgetKey: store.widgetKey, widgetScriptUrl: store.widgetScriptUrl } });
        this.jobs.enqueue(shop, 'widget', () => this.publishWidgetSettings(shop), retryable);
      }
      return { ...base, store };
    } catch (e) {
      if (e instanceof SailesError && e.status === 401) {
        // The key was revoked (for example the store was reconnected elsewhere): offer to connect again.
        await this.store.upsert(shop, { sailes: null });
        return { ...base, connected: false, store: null, notice: 'The SAILES connection was removed. Connect again to continue.' };
      }
      throw e;
    }
  }

  async getAi(shop: string) {
    const { sailes } = await this.linked(shop);
    const [current, providers] = await Promise.all([sailes.getAi(), sailes.providers()]);
    return { ...current, ...providers };
  }

  async putAi(shop: string, settings: AiSettings) {
    const { sailes } = await this.linked(shop);
    return sailes.putAi(settings);
  }
}
