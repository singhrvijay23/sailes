import { config } from '../config.js';
import { withTenant, query } from '../db/pool.js';
import { openSecret } from '../lib/vault.js';
import { DEFAULT_MODELS } from './pricing.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createDemoProvider } from './providers/demo.js';
import { createGeminiProvider } from './providers/gemini.js';
import { createOpenAIProvider } from './providers/openai.js';
import type { ChatProvider, ProviderId } from './types.js';

export function buildProvider(provider: Exclude<ProviderId, 'demo'>, apiKey: string, chatModel?: string, embeddingModel?: string | null): ChatProvider {
  const d = DEFAULT_MODELS[provider];
  switch (provider) {
    case 'openai':
      return createOpenAIProvider(apiKey, chatModel || d.chat, embeddingModel || d.embedding);
    case 'gemini':
      return createGeminiProvider(apiKey, chatModel || d.chat, embeddingModel || d.embedding);
    case 'anthropic':
      return createAnthropicProvider(apiKey, chatModel || d.chat);
  }
}

/** Test hook: lets tests inject a scripted provider for every tenant. */
let override: ((tenantId: string) => ChatProvider | null) | null = null;
export function setProviderOverride(fn: typeof override) {
  override = fn;
}

export async function providerForTenant(tenantId: string): Promise<{ provider: ChatProvider; mode: 'demo' | 'byok' | 'managed' }> {
  const forced = override?.(tenantId);
  const t = (await query<{ ai_mode: 'demo' | 'byok' | 'managed' }>('SELECT ai_mode FROM tenants WHERE id = $1', [tenantId])).rows[0];
  const mode = t?.ai_mode ?? 'demo';
  if (forced) return { provider: forced, mode };
  if (mode === 'byok') {
    const cred = await withTenant(tenantId, async (db) => (await db.query('SELECT provider, chat_model, embedding_model, key_ciphertext FROM ai_credentials')).rows[0]);
    if (cred) {
      const key = await openSecret(cred.key_ciphertext);
      return { provider: buildProvider(cred.provider, key, cred.chat_model, cred.embedding_model), mode };
    }
  }
  if (mode === 'managed' && config.managed.apiKey) {
    return { provider: buildProvider(config.managed.provider, config.managed.apiKey), mode };
  }
  return { provider: createDemoProvider(), mode: 'demo' };
}
