function env(name: string, fallback?: string): string {
  const v = process.env[name] || fallback;
  if (v === undefined) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const config = {
  port: Number(env('PORT', '4000')),
  host: env('HOST', '0.0.0.0'),
  databaseUrl: env('DATABASE_URL', 'postgres://sailes:sailes@localhost:5432/sailes'),
  /** PEM bundle for verifying the database's TLS certificate (the RDS CA bundle in production). */
  databaseCaFile: process.env.DATABASE_CA_FILE ?? '',
  redisUrl: env('REDIS_URL', 'redis://localhost:6379'),
  jwtSecret: env('JWT_SECRET', 'dev-only-change-me-dev-only-change-me'),
  /** 32-byte base64 master key for the local key vault. In production this is replaced by AWS KMS. */
  masterKey: env('SAILES_MASTER_KEY', 'ZGV2LW9ubHktbWFzdGVyLWtleS0zMi1ieXRlcyEhISE='),
  /** AWS KMS key (id, ARN or alias) that wraps AI-key data keys in production. */
  kmsKeyId: process.env.KMS_KEY_ID ?? '',
  /** Run BullMQ workers inside the API process (simple local setup). */
  runWorkers: env('RUN_WORKERS', 'true') === 'true',
  /** Disable Redis entirely (tests): jobs run inline. */
  inlineJobs: env('INLINE_JOBS', 'false') === 'true',
  publicApiUrl: env('PUBLIC_API_URL', 'http://localhost:4000'),
  consoleOrigin: env('CONSOLE_ORIGIN', 'http://localhost:3000'),
  /** Managed "SAILES AI" provider keys (our own keys, used when a tenant buys credits). */
  managed: {
    provider: env('MANAGED_AI_PROVIDER', 'openai') as 'openai' | 'gemini' | 'anthropic',
    apiKey: process.env.MANAGED_AI_API_KEY ?? '',
  },
  /** Stripe. Billing is disabled (plans changeable directly in development) when no secret key is set. */
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    prices: {
      starter_month: process.env.STRIPE_PRICE_STARTER_MONTHLY ?? '',
      starter_year: process.env.STRIPE_PRICE_STARTER_ANNUAL ?? '',
      pro_month: process.env.STRIPE_PRICE_PRO_MONTHLY ?? '',
      pro_year: process.env.STRIPE_PRICE_PRO_ANNUAL ?? '',
      enterprise_month: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY ?? '',
      enterprise_year: process.env.STRIPE_PRICE_ENTERPRISE_ANNUAL ?? '',
    } as Record<string, string>,
  },
  /** SAILES AI credits are charged at estimated provider cost times this markup. */
  creditMarkup: Number(env('CREDIT_MARKUP', '2')),
  logLevel: env('LOG_LEVEL', 'info'),
  isProd: env('NODE_ENV', 'development') === 'production',
};

if (config.isProd && (!(process.env.SAILES_MASTER_KEY || process.env.KMS_KEY_ID) || !process.env.JWT_SECRET)) {
  throw new Error('JWT_SECRET and KMS_KEY_ID (or SAILES_MASTER_KEY) must be set in production');
}
