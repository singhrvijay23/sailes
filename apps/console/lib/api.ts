'use client';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export const session = {
  get token() {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('sailes_token');
  },
  set token(v: string | null) {
    if (v) localStorage.setItem('sailes_token', v);
    else localStorage.removeItem('sailes_token');
  },
  get storeId() {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('sailes_store');
  },
  set storeId(v: string | null) {
    if (v) localStorage.setItem('sailes_store', v);
    else localStorage.removeItem('sailes_store');
  },
};

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  let body = init.body;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${API_URL}${path}`, { ...init, headers, body });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/v1/auth')) {
      session.token = null;
      window.location.href = '/login';
    }
    throw new ApiError(res.status, (data as any)?.message ?? 'Request failed', (data as any)?.error);
  }
  return data as T;
}

/** Path helper for the current store. */
export const storePath = (p = '') => `/v1/stores/${session.storeId}${p}`;
