import type { Db } from '../db/pool.js';
import { estimateCostUsd } from '../ai/pricing.js';

export function currentMonth(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export async function recordUsage(
  db: Db,
  tenantId: string,
  u: { inputTokens?: number; outputTokens?: number; embeddingTokens?: number; conversations?: number; model?: string },
) {
  const cost = u.model ? estimateCostUsd(u.model, (u.inputTokens ?? 0) + (u.embeddingTokens ?? 0), u.outputTokens ?? 0) : 0;
  await db.query(
    `INSERT INTO usage_monthly (tenant_id, month, conversations, input_tokens, output_tokens, embedding_tokens, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, month) DO UPDATE SET
       conversations = usage_monthly.conversations + EXCLUDED.conversations,
       input_tokens = usage_monthly.input_tokens + EXCLUDED.input_tokens,
       output_tokens = usage_monthly.output_tokens + EXCLUDED.output_tokens,
       embedding_tokens = usage_monthly.embedding_tokens + EXCLUDED.embedding_tokens,
       cost_usd = usage_monthly.cost_usd + EXCLUDED.cost_usd`,
    [tenantId, currentMonth(), u.conversations ?? 0, u.inputTokens ?? 0, u.outputTokens ?? 0, u.embeddingTokens ?? 0, cost],
  );
}

export async function monthUsage(db: Db) {
  const { rows } = await db.query(
    `SELECT conversations, input_tokens::float AS input_tokens, output_tokens::float AS output_tokens,
            embedding_tokens::float AS embedding_tokens, cost_usd::float AS cost_usd
     FROM usage_monthly WHERE month = $1`,
    [currentMonth()],
  );
  return rows[0] ?? { conversations: 0, input_tokens: 0, output_tokens: 0, embedding_tokens: 0, cost_usd: 0 };
}
