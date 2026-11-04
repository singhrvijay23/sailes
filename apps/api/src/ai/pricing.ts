import type { ProviderId } from './types.js';

/**
 * Estimated list prices in USD per 1M tokens, used for merchant spend caps and the
 * usage dashboard. They are estimates: the provider's own bill is the source of truth.
 * Update when providers change prices.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  // OpenAI
  'gpt-5-mini': { input: 0.25, output: 2.0 },
  'gpt-5': { input: 1.25, output: 10.0 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  // Google
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
  'gemini-embedding-001': { input: 0.15, output: 0 },
  // Anthropic
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2.0, output: 10.0 },
  'claude-opus-5-5': { input: 4.0, output: 20.0 },
};

const FALLBACK = { input: 1.0, output: 5.0 };

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number) {
  const p = PRICES[model] ?? FALLBACK;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export const DEFAULT_MODELS: Record<Exclude<ProviderId, 'demo'>, { chat: string; embedding: string; choices: string[] }> = {
  openai: { chat: 'gpt-5-mini', embedding: 'text-embedding-3-small', choices: ['gpt-5-mini', 'gpt-5', 'gpt-5-nano', 'gpt-4.1-mini'] },
  gemini: { chat: 'gemini-2.5-flash', embedding: 'gemini-embedding-001', choices: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'] },
  // Anthropic has no embeddings API; Claude tenants use the built-in local embedder (see ai/hashEmbed.ts).
  anthropic: { chat: 'claude-haiku-5-5', embedding: 'sailes-hash-v1', choices: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] },
};
