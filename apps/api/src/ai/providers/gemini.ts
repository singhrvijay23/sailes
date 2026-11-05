import { ApiError, GoogleGenAI, type Content, type Part } from '@google/genai';
import { EMBEDDING_DIMS, ProviderError, type ChatProvider, type TurnInput, type TurnResult } from '../types.js';

function mapError(e: unknown): never {
  if (e instanceof ApiError) {
    if (e.status === 401 || e.status === 403 || (e.status === 400 && /api key/i.test(e.message))) throw new ProviderError('Gemini rejected the API key', 'auth');
    if (e.status === 429) throw new ProviderError('Gemini rate limit or quota reached', 'rate_limit');
    if (e.status >= 500) throw new ProviderError('Gemini is unavailable', 'unavailable');
    if (e.status === 400) throw new ProviderError(`Gemini bad request: ${e.message}`, 'bad_request');
  }
  throw e;
}

export function createGeminiProvider(apiKey: string, model: string, embeddingModel = 'gemini-embedding-001'): ChatProvider {
  const ai = new GoogleGenAI({ apiKey });

  return {
    id: 'gemini',
    model,
    embeddingModel,

    async validate() {
      try {
        await ai.models.get({ model });
      } catch (e) {
        mapError(e);
      }
    },

    async embed(texts, kind) {
      try {
        const res = await ai.models.embedContent({
          model: embeddingModel,
          contents: texts,
          config: { outputDimensionality: EMBEDDING_DIMS, taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT' },
        });
        const vectors = (res.embeddings ?? []).map((e) => normalize(e.values ?? []));
        // Gemini does not report embedding tokens; estimate ~4 chars per token for spend tracking.
        return { vectors, tokens: Math.ceil(texts.reduce((s, t) => s + t.length, 0) / 4) };
      } catch (e) {
        mapError(e);
      }
    },

    async runTurn(input: TurnInput): Promise<TurnResult> {
      const contents: Content[] = input.history.map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] }));
      const functionDeclarations = input.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }));
      let text = '';
      const usage = { inputTokens: 0, outputTokens: 0 };

      for (let round = 1; round <= input.maxRounds; round++) {
        let stream;
        try {
          stream = await ai.models.generateContentStream({
            model,
            contents,
            config: { systemInstruction: input.system, tools: [{ functionDeclarations }], abortSignal: input.signal },
          });
        } catch (e) {
          mapError(e);
        }
        // Keep every part exactly as returned (including thought signatures) so the next round is valid.
        const modelParts: Part[] = [];
        let finish: string | undefined;
        let lastUsage: { prompt: number; output: number } | null = null;
        for await (const chunk of stream) {
          const cand = chunk.candidates?.[0];
          for (const part of cand?.content?.parts ?? []) {
            modelParts.push(part);
            if (part.text && !part.thought) {
              text += part.text;
              input.onText(part.text);
            }
          }
          if (cand?.finishReason) finish = String(cand.finishReason);
          if (chunk.usageMetadata) {
            lastUsage = {
              prompt: chunk.usageMetadata.promptTokenCount ?? 0,
              output: (chunk.usageMetadata.candidatesTokenCount ?? 0) + (chunk.usageMetadata.thoughtsTokenCount ?? 0),
            };
          }
        }
        if (lastUsage) {
          usage.inputTokens += lastUsage.prompt;
          usage.outputTokens += lastUsage.output;
        }
        const calls = modelParts.filter((p) => p.functionCall);
        if (calls.length === 0) {
          const stopReason = finish === 'MAX_TOKENS' ? 'length' : finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' ? 'refusal' : 'done';
          return { text, usage, rounds: round, stopReason };
        }
        contents.push({ role: 'model', parts: modelParts });
        const responses: Part[] = [];
        for (const p of calls) {
          const fc = p.functionCall!;
          let result: unknown;
          try {
            result = await input.executeTool(fc.name ?? '', (fc.args ?? {}) as Record<string, unknown>);
          } catch (e) {
            result = { error: (e as Error).message };
          }
          responses.push({ functionResponse: { id: fc.id, name: fc.name, response: { result } } });
        }
        contents.push({ role: 'user', parts: responses });
      }
      return { text, usage, rounds: input.maxRounds, stopReason: 'max_rounds' };
    },
  };
}

function normalize(v: number[]) {
  // Truncated (non-3072) Gemini embeddings are not unit length; normalise for cosine search.
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}
