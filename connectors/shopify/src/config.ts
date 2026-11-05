function env(name: string, fallback?: string): string {
  const v = process.env[name] || fallback;
  if (v === undefined) throw new Error(`Missing environment variable ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === 'production';

export interface AppConfig {
  port: number;
  host: string;
  /** Client id and secret from the Shopify Partner Dashboard (or `shopify app env show`). */
  apiKey: string;
  apiSecret: string;
  /** Public https URL of this app, for example https://shopify.sailes.ai */
  appUrl: string;
  /** Admin API version used for every Shopify call. */
  apiVersion: string;
  /** SAILES API used for the code exchange. Later calls use the apiUrl the exchange returns. */
  sailesApiUrl: string;
  /** SAILES console, where the merchant signs in and approves the connection. */
  sailesConsoleUrl: string;
  /** Postgres for shop records. Empty means in-memory (development and tests only). */
  databaseUrl: string;
  /** 32-byte base64 key that encrypts Shopify tokens and the SAILES secret key at rest. */
  encryptionKey: string;
  /** Theme app extension id for the theme-editor deep link (defaults to the API key). */
  themeExtensionId: string;
  /** Hours between full catalog resyncs (the "nightly" resync). */
  resyncHours: number;
  isProd: boolean;
  logLevel: string;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const c: AppConfig = {
    port: Number(env('PORT', '4100')),
    host: env('HOST', '0.0.0.0'),
    apiKey: env('SHOPIFY_API_KEY', isProd ? undefined : 'dev-api-key'),
    apiSecret: env('SHOPIFY_API_SECRET', isProd ? undefined : 'dev-api-secret'),
    appUrl: env('SHOPIFY_APP_URL', 'http://localhost:4100').replace(/\/$/, ''),
    apiVersion: env('SHOPIFY_API_VERSION', '2026-10'),
    sailesApiUrl: env('SAILES_API_URL', 'http://localhost:4000').replace(/\/$/, ''),
    sailesConsoleUrl: env('SAILES_CONSOLE_URL', 'http://localhost:3000').replace(/\/$/, ''),
    databaseUrl: process.env.DATABASE_URL ?? '',
    encryptionKey: env('ENCRYPTION_KEY', isProd ? undefined : 'ZGV2LW9ubHktc2hvcGlmeS1hcHAta2V5LTMyLWJ5dGU='),
    themeExtensionId: process.env.SHOPIFY_THEME_EXTENSION_ID ?? '',
    resyncHours: Number(env('RESYNC_HOURS', '24')),
    isProd,
    logLevel: env('LOG_LEVEL', 'info'),
    ...overrides,
  };
  if (c.isProd && !c.databaseUrl) throw new Error('DATABASE_URL must be set in production');
  if (Buffer.from(c.encryptionKey, 'base64').length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  return c;
}
