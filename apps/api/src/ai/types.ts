export type ProviderId = 'openai' | 'gemini' | 'anthropic' | 'demo';

/** JSON-schema tool definition shared by every provider adapter. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/** Cross-turn history is plain text: tool calls from earlier turns are not replayed. */
export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface TurnInput {
  system: string;
  history: HistoryTurn[];
  tools: ToolSpec[];
  /** Runs a tool and returns a JSON-serialisable result. Throwing returns an error result to the model. */
  executeTool: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  onText: (delta: string) => void;
  maxRounds: number;
  signal?: AbortSignal;
}

export interface TurnResult {
  text: string;
  usage: Usage;
  rounds: number;
  stopReason: 'done' | 'max_rounds' | 'refusal' | 'length';
}

export interface EmbedResult {
  vectors: number[][];
  tokens: number;
}

export interface ChatProvider {
  id: ProviderId;
  model: string;
  embeddingModel: string;
  runTurn(input: TurnInput): Promise<TurnResult>;
  embed(texts: string[], kind: 'document' | 'query'): Promise<EmbedResult>;
  /** Cheap call that proves the key works. Throws a readable error otherwise. */
  validate(): Promise<void>;
}

export const EMBEDDING_DIMS = 768;

export class ProviderError extends Error {
  constructor(
    message: string,
    public kind: 'auth' | 'rate_limit' | 'unavailable' | 'bad_request' | 'unknown' = 'unknown',
  ) {
    super(message);
  }
}
