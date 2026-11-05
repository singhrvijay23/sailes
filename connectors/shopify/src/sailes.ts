import type { FetchFn, SleepFn } from './http.js';
import { realSleep } from './http.js';
import type { SailesLink } from './store.js';

export class SailesError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface ExchangeResult {
  storeId: string;
  apiKey: string;
  widgetKey: string | null;
  apiUrl: string;
  widgetScriptUrl: string;
}

export interface ConnectorStore {
  storeId: string;
  storeName: string;
  plan: string;
  platform: string | null;
  shopUrl: string | null;
  active: boolean;
  widgetKey: string | null;
  widgetScriptUrl: string;
  consoleUrl: string;
}

export interface UpsertResult {
  created: number;
  updated: number;
  unchanged: number;
  rejected: number;
  errors: unknown[];
}

export type AiSettings =
  | { mode: 'demo' }
  | { mode: 'managed' }
  | { mode: 'byok'; provider: 'openai' | 'gemini' | 'anthropic'; apiKey?: string; chatModel?: string };

/** Backoff for 5xx and network errors, per the connector contract. */
const BACKOFF = [1000, 2000, 4000, 8000, 16000];
/** About 10 requests per second per store. */
const MIN_GAP_MS = 100;
const lastCall = new Map<string, number>();

async function call<T>(fetchFn: FetchFn, sleep: SleepFn, url: string, init: RequestInit, throttleKey: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = (lastCall.get(throttleKey) ?? 0) + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall.set(throttleKey, Date.now());
    let res: Response;
    try {
      res = await fetchFn(url, init);
    } catch (e) {
      if (attempt < BACKOFF.length) {
        await sleep(BACKOFF[attempt]!);
        continue;
      }
      throw new SailesError(0, 'network', `Could not reach SAILES: ${(e as Error).message}`);
    }
    if (res.ok) return (await res.json()) as T;
    if ((res.status >= 500 || res.status === 429) && attempt < BACKOFF.length) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(res.status === 429 && retryAfter > 0 ? retryAfter * 1000 : BACKOFF[attempt]!);
      continue;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new SailesError(res.status, body.error ?? 'http_error', body.message ?? `SAILES returned ${res.status}`);
  }
}

/** Step 3 of the install flow, from our server. The code works once and expires after 10 minutes. */
export function exchangeCode(sailesApiUrl: string, code: string, fetchFn: FetchFn = fetch, sleep: SleepFn = realSleep) {
  return call<ExchangeResult>(
    fetchFn,
    sleep,
    `${sailesApiUrl}/v1/connect/exchange`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) },
    'exchange',
  );
}

export class SailesClient {
  constructor(private link: Pick<SailesLink, 'storeId' | 'apiKey' | 'apiUrl'>, private fetchFn: FetchFn = fetch, private sleep: SleepFn = realSleep) {}

  private req<T>(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { authorization: `Bearer ${this.link.apiKey}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return call<T>(this.fetchFn, this.sleep, `${this.link.apiUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, this.link.storeId);
  }

  private get store() {
    return `/v1/stores/${this.link.storeId}`;
  }

  getStore() {
    return this.req<ConnectorStore>('GET', '/v1/connector/store');
  }

  disconnect() {
    return this.req<{ ok: boolean }>('POST', '/v1/connector/disconnect', {});
  }

  /** Upserts in pages of 1,000 (the API takes up to 5,000). Returns summed counts. */
  async upsertProducts(products: unknown[]): Promise<UpsertResult> {
    const total: UpsertResult = { created: 0, updated: 0, unchanged: 0, rejected: 0, errors: [] };
    for (let i = 0; i < products.length; i += 1000) {
      const r = await this.req<UpsertResult>('PUT', `${this.store}/catalog/products`, { products: products.slice(i, i + 1000) });
      total.created += r.created;
      total.updated += r.updated;
      total.unchanged += r.unchanged;
      total.rejected += r.rejected;
      total.errors.push(...(r.errors ?? []));
    }
    return total;
  }

  async deleteProducts(ids: string[]) {
    if (ids.length) await this.req('POST', `${this.store}/catalog/products/delete`, { ids });
  }

  putPolicy(topic: string, content: string) {
    return this.req('PUT', `${this.store}/policies`, { topic, content });
  }

  reportOrder(order: { orderId: string; total: number; conversationId: string | null; productIds: string[] }) {
    return this.req<{ ok: boolean; duplicate: boolean }>('POST', `${this.store}/orders`, order);
  }

  getAi() {
    return this.req<{ mode: string; credential: { provider: string; chat_model: string; key: string; validated_at: string } | null }>('GET', `${this.store}/ai`);
  }

  putAi(settings: AiSettings) {
    return this.req<{ ok: boolean; mode: string; reindexing: number }>('PUT', `${this.store}/ai`, settings);
  }

  providers() {
    return this.req<{ providers: { id: string; defaultModel: string; models: string[] }[]; managedAvailable: boolean }>('GET', '/v1/ai/providers');
  }
}
