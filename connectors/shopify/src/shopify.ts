import type { FetchFn, SleepFn } from './http.js';
import { realSleep } from './http.js';

export class ShopifyError extends Error {
  constructor(public status: number, message: string, public code = 'shopify_error') {
    super(message);
  }
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: number | null;
  refreshTokenExpiresAt: number | null;
  scope: string | null;
}

interface TokenResponse {
  access_token: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

function toTokenSet(r: TokenResponse, now = Date.now()): TokenSet {
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token ?? null,
    accessTokenExpiresAt: r.expires_in ? now + r.expires_in * 1000 : null,
    refreshTokenExpiresAt: r.refresh_token_expires_in ? now + r.refresh_token_expires_in * 1000 : null,
    scope: r.scope ?? null,
  };
}

async function tokenRequest(shop: string, params: Record<string, string>, fetchFn: FetchFn): Promise<TokenSet> {
  const res = await fetchFn(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ShopifyError(res.status, `Shopify token request failed (${res.status}) ${text.slice(0, 200)}`, res.status === 401 || res.status === 400 ? 'reauth_needed' : 'token_failed');
  }
  return toTokenSet((await res.json()) as TokenResponse);
}

/**
 * Token exchange: trades an App Bridge session token for an expiring offline access token
 * (1 hour) plus a refresh token (90 days). Public apps must use expiring offline tokens.
 */
export function exchangeSessionToken(shop: string, idToken: string, apiKey: string, apiSecret: string, fetchFn: FetchFn = fetch) {
  return tokenRequest(
    shop,
    {
      client_id: apiKey,
      client_secret: apiSecret,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: idToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: '1',
    },
    fetchFn,
  );
}

/** Refresh rotates both tokens: store the new refresh token. */
export function refreshAccessToken(shop: string, refreshToken: string, apiKey: string, apiSecret: string, fetchFn: FetchFn = fetch) {
  return tokenRequest(shop, { client_id: apiKey, client_secret: apiSecret, grant_type: 'refresh_token', refresh_token: refreshToken }, fetchFn);
}

export interface GraphqlOptions {
  shop: string;
  apiVersion: string;
  getToken: (forceRefresh?: boolean) => Promise<string>;
  fetchFn?: FetchFn;
  sleep?: SleepFn;
}

/** Admin GraphQL with retries on throttling, 5xx and one token refresh on 401. */
export async function adminGraphql<T>(opts: GraphqlOptions, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  let refreshed = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    const token = await opts.getToken();
    let res: Response;
    try {
      res = await fetchFn(`https://${opts.shop}/admin/api/${opts.apiVersion}/graphql.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await opts.getToken(true);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(ra > 0 ? ra * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new ShopifyError(res.status, `Shopify Admin API returned ${res.status}`);
    const body = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[]; extensions?: { cost?: { throttleStatus?: { currentlyAvailable: number; restoreRate: number }; requestedQueryCost?: number } } };
    if (body.errors?.some((e) => e.extensions?.code === 'THROTTLED')) {
      const c = body.extensions?.cost;
      const need = (c?.requestedQueryCost ?? 100) - (c?.throttleStatus?.currentlyAvailable ?? 0);
      await sleep(Math.max(1000, Math.ceil((need / (c?.throttleStatus?.restoreRate ?? 50)) * 1000)));
      continue;
    }
    if (body.errors?.length) throw new ShopifyError(200, body.errors.map((e) => e.message).join('; '), 'graphql_error');
    return body.data as T;
  }
  throw new ShopifyError(503, 'Shopify Admin API kept failing', 'unavailable');
}
