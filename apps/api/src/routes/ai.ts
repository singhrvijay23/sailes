import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, withTenant } from '../db/pool.js';
import { requireStore } from '../auth.js';
import { buildProvider } from '../ai/registry.js';
import { DEFAULT_MODELS } from '../ai/pricing.js';
import { HASH_EMBED_MODEL } from '../ai/hashEmbed.js';
import { ProviderError } from '../ai/types.js';
import { last4, sealSecret } from '../lib/vault.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { invalidateEmbeddings } from '../catalog/service.js';
import { enqueueEmbedding } from '../queue.js';
import { config } from '../config.js';

const AiBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('demo') }),
  z.object({ mode: z.literal('managed') }),
  z.object({
    mode: z.literal('byok'),
    provider: z.enum(['openai', 'gemini', 'anthropic']),
    /** Omit to keep the stored key and only change the model. */
    apiKey: z.string().min(10).max(400).optional(),
    chatModel: z.string().max(80).optional(),
  }),
]);

export async function aiRoutes(app: FastifyInstance) {
  app.get('/v1/ai/providers', async () => ({
    providers: Object.entries(DEFAULT_MODELS).map(([id, d]) => ({ id, defaultModel: d.chat, models: d.choices, embeddingModel: d.embedding })),
    managedAvailable: Boolean(config.managed.apiKey),
  }));

  app.get('/v1/stores/:storeId/ai', { preHandler: requireStore() }, async (req) => {
    const { tenantId } = req.store!;
    const t = (await query('SELECT ai_mode FROM tenants WHERE id = $1', [tenantId])).rows[0];
    const cred = await withTenant(tenantId, async (db) => (await db.query('SELECT provider, chat_model, embedding_model, key_last4, validated_at, updated_at FROM ai_credentials')).rows[0] ?? null);
    return { mode: t.ai_mode, credential: cred ? { ...cred, key: `••••${cred.key_last4}` } : null };
  });

  /** Connect or change the AI provider. The key is validated with a live call, then sealed in the vault. */
  app.put('/v1/stores/:storeId/ai', { preHandler: requireStore(['owner', 'admin']), config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    const body = AiBody.parse(req.body);
    const { tenantId } = req.store!;
    let embeddingModel = HASH_EMBED_MODEL;

    if (body.mode === 'managed') {
      if (!config.managed.apiKey) throw badRequest('SAILES AI credits are not available yet on this server', 'managed_unavailable');
      embeddingModel = DEFAULT_MODELS[config.managed.provider].embedding;
    }

    if (body.mode === 'byok') {
      const existing = await withTenant(tenantId, async (db) => (await db.query('SELECT provider, key_ciphertext FROM ai_credentials')).rows[0]);
      if (!body.apiKey && (!existing || existing.provider !== body.provider)) throw badRequest('Enter an API key for this provider');
      const chatModel = body.chatModel || DEFAULT_MODELS[body.provider].chat;
      embeddingModel = DEFAULT_MODELS[body.provider].embedding;
      let sealed = existing?.key_ciphertext as string | undefined;
      let tail: string | undefined;
      if (body.apiKey) {
        const key = body.apiKey.trim();
        try {
          await buildProvider(body.provider, key, chatModel, embeddingModel).validate();
        } catch (e) {
          if (e instanceof ProviderError) throw new HttpError(400, `${e.message}. Check the key and that it can use ${chatModel}.`, 'invalid_ai_key');
          throw e;
        }
        sealed = await sealSecret(key);
        tail = last4(key);
      }
      await withTenant(tenantId, (db) =>
        db.query(
          `INSERT INTO ai_credentials (tenant_id, provider, chat_model, embedding_model, key_ciphertext, key_last4, validated_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (tenant_id) DO UPDATE SET provider = EXCLUDED.provider, chat_model = EXCLUDED.chat_model,
             embedding_model = EXCLUDED.embedding_model, key_ciphertext = EXCLUDED.key_ciphertext,
             key_last4 = coalesce($6, ai_credentials.key_last4), validated_at = now(), updated_at = now()`,
          [tenantId, body.provider, chatModel, embeddingModel, sealed, tail ?? null],
        ),
      );
    }

    await query('UPDATE tenants SET ai_mode = $2 WHERE id = $1', [tenantId, body.mode]);
    // Embeddings from different providers are not comparable: re-index in the background.
    const reindex = await withTenant(tenantId, (db) => invalidateEmbeddings(db, embeddingModel));
    if (reindex > 0) await enqueueEmbedding(tenantId);
    return { ok: true, mode: body.mode, reindexing: reindex };
  });

  /** Remove the stored key. The widget keeps working in demo (keyword) mode. */
  app.delete('/v1/stores/:storeId/ai', { preHandler: requireStore(['owner', 'admin']) }, async (req) => {
    const { tenantId } = req.store!;
    await withTenant(tenantId, (db) => db.query('DELETE FROM ai_credentials'));
    await query(`UPDATE tenants SET ai_mode = 'demo' WHERE id = $1`, [tenantId]);
    const reindex = await withTenant(tenantId, (db) => invalidateEmbeddings(db, HASH_EMBED_MODEL));
    if (reindex > 0) await enqueueEmbedding(tenantId);
    return { ok: true };
  });
}
