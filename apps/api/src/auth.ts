import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { query } from './db/pool.js';
import { forbidden, unauthorized } from './lib/errors.js';

export interface StoreAuth {
  tenantId: string;
  userId: string | null;
  role: 'owner' | 'admin' | 'viewer' | 'connector';
}

declare module 'fastify' {
  interface FastifyRequest {
    store?: StoreAuth;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

export function hashApiKey(key: string) {
  return createHash('sha256').update(key).digest('hex');
}

/** Signed-in console user. */
export async function requireUser(req: FastifyRequest) {
  try {
    await req.jwtVerify();
  } catch {
    throw unauthorized('Please sign in');
  }
  return req.user.sub;
}

/**
 * Access to /v1/stores/:storeId/*: a console user with a membership, or a connector secret key
 * (sk_...) belonging to that store. `roles` limits which roles may call the route.
 */
export function requireStore(roles: StoreAuth['role'][] = ['owner', 'admin', 'viewer']) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const storeId = (req.params as { storeId?: string }).storeId;
    if (!storeId || !/^[0-9a-f-]{36}$/i.test(storeId)) throw forbidden('Unknown store');
    const auth = req.headers.authorization ?? '';
    if (auth.startsWith('Bearer sk_')) {
      const key = auth.slice(7).trim();
      const row = (await query('UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 AND revoked_at IS NULL RETURNING tenant_id', [hashApiKey(key)])).rows[0];
      if (!row || row.tenant_id !== storeId) throw unauthorized('Invalid API key');
      if (!roles.includes('connector')) throw forbidden('This action needs a signed-in user');
      req.store = { tenantId: storeId, userId: null, role: 'connector' };
      return;
    }
    const userId = await requireUser(req);
    const m = (await query('SELECT role FROM memberships WHERE user_id = $1 AND tenant_id = $2', [userId, storeId])).rows[0];
    if (!m) throw forbidden('You do not have access to this store');
    if (!roles.includes(m.role)) throw forbidden('Your role cannot do this');
    req.store = { tenantId: storeId, userId, role: m.role };
  };
}
