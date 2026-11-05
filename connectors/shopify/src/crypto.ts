import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, all base64url. */
export function seal(plain: string, keyB64: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function unseal(sealed: string, keyB64: string): string {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Bad sealed value');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Shopify webhook check: X-Shopify-Hmac-Sha256 is base64 HMAC-SHA256 of the raw body. */
export function verifyWebhookHmac(rawBody: Buffer, header: string | undefined, secret: string) {
  if (!header) return false;
  return safeEqual(createHmac('sha256', secret).update(rawBody).digest('base64'), header);
}

/** Valid shop domains: <name>.myshopify.com only. */
export function normalizeShop(shop: unknown): string | null {
  if (typeof shop !== 'string') return null;
  const s = shop.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : null;
}

export interface SessionToken {
  shop: string;
  /** Shopify user id of the staff member using the admin. */
  sub: string;
  token: string;
}

/**
 * Verifies an App Bridge session token (a JWT signed HS256 with the app secret) and returns the shop.
 * Throws on any problem.
 */
export function verifySessionToken(token: string, apiKey: string, secret: string, now = Date.now()): SessionToken {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [h, p, sig] = parts as [string, string, string];
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  if (header.alg !== 'HS256') throw new Error('Unexpected algorithm');
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  if (!safeEqual(expected, sig)) throw new Error('Bad signature');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const t = Math.floor(now / 1000);
  const leeway = 10;
  if (typeof claims.exp !== 'number' || claims.exp + leeway < t) throw new Error('Token expired');
  if (typeof claims.nbf === 'number' && claims.nbf - leeway > t) throw new Error('Token not yet valid');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(apiKey)) throw new Error('Wrong audience');
  const shop = normalizeShop(claims.dest);
  if (!shop) throw new Error('Bad destination');
  if (typeof claims.iss === 'string' && normalizeShop(claims.iss) !== shop) throw new Error('Issuer does not match shop');
  return { shop, sub: String(claims.sub ?? ''), token };
}

/** For tests and local development: signs a token the way Shopify does. */
export function signSessionToken(shop: string, apiKey: string, secret: string, ttlSeconds = 60): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const h = enc({ alg: 'HS256', typ: 'JWT' });
  const p = enc({ iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: apiKey, sub: '42', exp: now + ttlSeconds, nbf: now - 1, iat: now, jti: randomBytes(8).toString('hex') });
  return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
}

export const randomState = () => randomBytes(18).toString('base64url');
