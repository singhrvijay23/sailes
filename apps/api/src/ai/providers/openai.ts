import OpenAI from 'openai';
import { EMBEDDING_DIMS, ProviderError, type ChatProvider, type TurnInput, type TurnResult } from '../types.js';

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function mapError(e: unknown): never {
  if (e instanceof OpenAI.AuthenticationError || e instanceof OpenAI.PermissionDeniedError) throw new ProviderError('OpenAI rejected the API key', 'auth');
  if (e instanceof OpenAI.RateLimitError) throw new ProviderError('OpenAI rate limit or quota reached', 'rate_limit');
  if (e instanceof OpenAI.BadRequestError) throw new ProviderError(`OpenAI bad request: ${e.message}`, 'bad_request');
  if (e instanceof OpenAI.APIConnectionError || e instanceof OpenAI.InternalServerError) throw new ProviderError('OpenAI is unavailable', 'unavailable');
  throw e;
}

export function createOpenAIProvider(apiKey: string, model: string, embeddingModel = 'text-embedding-3-small'): ChatProvider {
  const client = new OpenAI({ apiKey, maxRetries: 2, timeout: 60_000 });

  return {
    id: 'openai',
    model,
    embeddingModel,

    async validate() {
      try {
        await client.models.retrieve(model);
      } catch (e) {
        mapError(e);
      }
    },

    async embed(texts, _kind) {
      try {
        const res = await client.embeddings.create({ model: embeddingModel, input: texts, dimensions: EMBEDDING_DIMS });
        return { vectors: res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding), tokens: res.usage?.total_tokens ?? 0 };
      } catch (e) {
        mapError(e);
      }
    },

    async runTurn(input: TurnInput): Promise<TurnResult> {
      const messages: Msg[] = [{ role: 'system', content: input.system }, ...input.history.map((h) => ({ role: h.role, content: h.content }) as Msg)];
      const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = input.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters as Record<string, unknown> },
      }));
      let text = '';
      const usage = { inputTokens: 0, outputTokens: 0 };

      for (let round = 1; round <= input.maxRounds; round++) {
        let stream;
        try {
          stream = await client.chat.completions.create(
            { model, messages, tools, tool_choice: 'auto', stream: true, stream_options: { include_usage: true } },
            { signal: input.signal },
          );
        } catch (e) {
          mapError(e);
        }
        let roundText = '';
        let finish: string | null = null;
        const calls = new Map<number, { id: string; name: string; args: string }>();
        for await (const chunk of stream) {
          if (chunk.usage) {
            usage.inputTokens += chunk.usage.prompt_tokens ?? 0;
            usage.outputTokens += chunk.usage.completion_tokens ?? 0;
          }
          const choice = chunk.choices[0];
          if (!choice) continue;
          const d = choice.delta;
          if (d?.content) {
            roundText += d.content;
            input.onText(d.content);
          }
          for (const tc of d?.tool_calls ?? []) {
            const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            calls.set(tc.index, cur);
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
        text += roundText;
        if (calls.size === 0) {
          return { text, usage, rounds: round, stopReason: finish === 'length' ? 'length' : finish === 'content_filter' ? 'refusal' : 'done' };
        }
        const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
        messages.push({
          role: 'assistant',
          content: roundText || null,
          tool_calls: ordered.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
        });
        for (const c of ordered) {
          let result: unknown;
          try {
            result = await input.executeTool(c.name, JSON.parse(c.args || '{}'));
          } catch (e) {
            result = { error: (e as Error).message };
          }
          messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) });
        }
      }
      return { text, usage, rounds: input.maxRounds, stopReason: 'max_rounds' };
    },
  };
}
