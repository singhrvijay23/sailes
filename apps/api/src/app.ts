import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import { accountRoutes } from './routes/account.js';
import { aiRoutes } from './routes/ai.js';
import { catalogRoutes } from './routes/catalog.js';
import { widgetRoutes } from './routes/widget.js';
import { analyticsRoutes } from './routes/analytics.js';
import { billingRoutes } from './routes/billing.js';
import { pool } from './db/pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel, redact: ['req.headers.authorization', 'req.headers["x-sailes-key"]', 'body.apiKey'] },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  // CSV catalogs can be posted as text/csv or text/plain.
  app.addContentTypeParser(['text/csv', 'text/plain'], { parseAs: 'string', bodyLimit: 60 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  await app.register(cors, {
    // The widget runs on merchant sites (origin checked per widget key); the console on its own origin.
    origin: true,
    credentials: false,
    allowedHeaders: ['content-type', 'authorization', 'x-sailes-key'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(jwt, { secret: config.jwtSecret });
  await app.register(multipart);
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'invalid_request', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    }
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    const status = (err as any).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as any).code ?? 'error', message: (err as Error).message });
    req.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Something went wrong' });
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  await app.register(accountRoutes);
  await app.register(aiRoutes);
  await app.register(catalogRoutes);
  await app.register(widgetRoutes);
  await app.register(analyticsRoutes);
  await app.register(billingRoutes);

  // Serve the built widget bundle and the demo storefront page.
  const widgetDist = path.resolve(here, '../../widget/dist');
  if (existsSync(widgetDist)) {
    await app.register(fastifyStatic, { root: widgetDist, prefix: '/widget/', decorateReply: false, maxAge: config.isProd ? '1h' : 0 });
  }
  const demoDir = path.resolve(here, '../public');
  if (existsSync(demoDir)) await app.register(fastifyStatic, { root: demoDir, prefix: '/demo/', decorateReply: false });

  return app;
}
