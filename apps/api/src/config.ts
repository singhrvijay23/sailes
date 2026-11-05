function env(name: string, fallback?: string): string {
  const v = process.env[name] || fallback;
  if (v === undefined) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const config = {
  port: Number(env('PORT', '4000')),
  host: env('HOST', '0.0.0.0'),
  databaseUrl: env('DATABASE_URL', 'postgres://sailes:sailes@localhost:5432/sailes'),
  redisUrl: env('REDIS_URL', 'redis://localhost:6379'),
  jwtSecret: env('JWT_SECRET', 'dev-only-change-me-dev-only-change-me'),
  /** 32-byte base64 master key for the local key vault. In production this is replaced by AWS KMS. */
  masterKey: env('SAILES_MASTER_KEY', 'ZGV2LW9ubHktbWFzdGVyLWtleS0zMi1ieXRlcyEhISE='),
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
  logLevel: env('LOG_LEVEL', 'info'),
  isProd: env('NODE_ENV', 'development') === 'production',
};

if (config.isProd && (!process.env.SAILES_MASTER_KEY || !process.env.JWT_SECRET)) {
  throw new Error('SAILES_MASTER_KEY and JWT_SECRET must be set in production');
}
