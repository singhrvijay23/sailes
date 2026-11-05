import Anthropic from '@anthropic-ai/sdk';
import { hashEmbed, HASH_EMBED_MODEL } from '../hashEmbed.js';
import { ProviderError, type ChatProvider, type TurnInput, type TurnResult } from '../types.js';

function mapError(e: unknown): never {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new ProviderError('Anthropic rejected the API key', 'auth');
  if (e instanceof Anthropic.RateLimitError) throw new ProviderError('Anthropic rate limit reached', 'rate_limit');
  if (e instanceof Anthropic.BadRequestError) throw new ProviderError(`Anthropic bad request: ${e.message}`, 'bad_request');
  if (e instanceof Anthropic.APIConnectionError || e instanceof Anthropic.InternalServerError) throw new ProviderError('Anthropic is unavailable', 'unavailable');
  throw e;
}

/**
 * Claude adapter. Anthropic has no embeddings endpoint, so the vector leg of search uses the
 * local hash embedder for Claude tenants (keyword + fuzzy search still apply).
 */
export function createAnthropicProvider(apiKey: string, model: string): ChatProvider {
  const client = new Anthropic({ apiKey, maxRetries: 2 });

  return {
    id: 'anthropic',
    model,
    embeddingModel: HASH_EMBED_MODEL,

    async validate() {
      try {
        await client.models.retrieve(model);
      } catch (e) {
        mapError(e);
      }
    },

    async embed(texts) {
      return { vectors: texts.map(hashEmbed), tokens: 0 };
    },

    async runTurn(input: TurnInput): Promise<TurnResult> {
      const messages: Anthropic.MessageParam[] = input.history.map((h) => ({ role: h.role, content: h.content }));
      const tools: Anthropic.Tool[] = input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema,
        eager_input_streaming: true,
      }));
      let text = '';
      const usage = { inputTokens: 0, outputTokens: 0 };

      for (let round = 1; round <= input.maxRounds; round++) {
        let message: Anthropic.Message;
        try {
          const stream = client.messages.stream(
            {
              model,
              max_tokens: 8000,
              system: input.system,
              messages,
              tools,
              // Shopping chat is latency-sensitive; low effort keeps time-to-first-token short.
              output_config: { effort: 'low' },
            },
            { signal: input.signal },
          );
          stream.on('text', (delta) => {
            text += delta;
            input.onText(delta);
          });
          message = await stream.finalMessage();
        } catch (e) {
          mapError(e);
        }
        usage.inputTokens += message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0);
        usage.outputTokens += message.usage.output_tokens;

        if (message.stop_reason === 'refusal') return { text, usage, rounds: round, stopReason: 'refusal' };
        const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        if (toolUses.length === 0) {
          return { text, usage, rounds: round, stopReason: message.stop_reason === 'max_tokens' ? 'length' : 'done' };
        }
        if (message.stop_reason === 'max_tokens') return { text, usage, rounds: round, stopReason: 'length' };

        // Append the full assistant content (thinking blocks included) unchanged.
        messages.push({ role: 'assistant', content: message.content });
        const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
          toolUses.map(async (tu) => {
            try {
              const result = await input.executeTool(tu.name, (tu.input ?? {}) as Record<string, unknown>);
              return { type: 'tool_result' as const, tool_use_id: tu.id, content: JSON.stringify(result) };
            } catch (e) {
              return { type: 'tool_result' as const, tool_use_id: tu.id, content: (e as Error).message, is_error: true };
            }
          }),
        );
        messages.push({ role: 'user', content: results });
      }
      return { text, usage, rounds: input.maxRounds, stopReason: 'max_rounds' };
    },
  };
}
