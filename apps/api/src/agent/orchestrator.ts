import { query, withTenant } from '../db/pool.js';
import { providerForTenant } from '../ai/registry.js';
import { createDemoProvider } from '../ai/providers/demo.js';
import { ProviderError, type ChatProvider, type HistoryTurn } from '../ai/types.js';
import { loadSearchContext } from '../search/search.js';
import { monthUsage, recordUsage } from '../usage/usage.js';
import { planFor } from '../lib/plans.js';
import { HttpError } from '../lib/errors.js';
import { buildSystemPrompt, type StoreSettings } from './prompt.js';
import { makeToolExecutor, TOOL_SPECS, type TurnState } from './tools.js';

export const MAX_MESSAGES_PER_CONVERSATION = 60;
const HISTORY_TURNS = 12;

export interface ChatRequest {
  tenantId: string;
  conversationId?: string | null;
  visitorId?: string | null;
  message: string;
  emit: (event: string, data: unknown) => void;
  signal?: AbortSignal;
}

export interface ChatOutcome {
  conversationId: string;
  text: string;
  mode: 'ai' | 'fallback' | 'demo';
  overPlanLimit: boolean;
}

interface ConversationState {
  consecutiveQuestions?: number;
  groundedIds?: string[];
}

export async function handleChat(req: ChatRequest): Promise<ChatOutcome> {
  const message = req.message.trim().slice(0, 2000);
  if (!message) throw new HttpError(400, 'Message is empty', 'empty_message');

  const tenant = (await query('SELECT id, name, plan, settings, ai_mode, monthly_budget_usd::float AS budget FROM tenants WHERE id = $1', [req.tenantId])).rows[0];
  if (!tenant) throw new HttpError(404, 'Store not found', 'not_found');
  const plan = planFor(tenant.plan);

  // 1. Conversation bookkeeping (and the plan's monthly conversation allowance).
  const setup = await withTenant(req.tenantId, async (db) => {
    let conv = req.conversationId ? (await db.query('SELECT id, state, message_count FROM conversations WHERE id = $1', [req.conversationId])).rows[0] : null;
    let isNew = false;
    if (!conv) {
      conv = (await db.query(`INSERT INTO conversations (tenant_id, visitor_id) VALUES ($1, $2) RETURNING id, state, message_count`, [req.tenantId, req.visitorId ?? null])).rows[0];
      isNew = true;
      await recordUsage(db, req.tenantId, { conversations: 1 });
    }
    const usage = await monthUsage(db);
    const history = (
      await db.query<HistoryTurn>('SELECT role, content FROM (SELECT id, role, content FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2) m ORDER BY id', [conv.id, HISTORY_TURNS])
    ).rows;
    const policies = (await db.query<{ topic: string }>('SELECT topic FROM policies ORDER BY topic')).rows.map((r) => r.topic);
    return { conv, isNew, usage, history, policies };
  });
  const conversationId: string = setup.conv.id;
  req.emit('conversation', { conversationId });

  if (setup.conv.message_count >= MAX_MESSAGES_PER_CONVERSATION) {
    const text = "We've covered a lot in this chat! Please refresh to start a new conversation, or contact the store team for more help.";
    req.emit('text', { delta: text });
    return { conversationId, text, mode: 'fallback', overPlanLimit: false };
  }

  // Over the plan allowance the widget keeps working; the merchant sees an upgrade prompt in the console.
  const overPlanLimit = setup.usage.conversations > plan.conversationsPerMonth;

  // 2. Pick the provider. Over the monthly AI budget we fall back to keyword-only mode instead of failing.
  let { provider, mode } = await providerForTenant(req.tenantId);
  let outcomeMode: ChatOutcome['mode'] = mode === 'demo' ? 'demo' : 'ai';
  if (mode !== 'demo' && setup.usage.cost_usd >= tenant.budget) {
    provider = createDemoProvider();
    outcomeMode = 'fallback';
  }

  const convState = (setup.conv.state ?? {}) as ConversationState;
  const state: TurnState = {
    groundedIds: new Set(convState.groundedIds ?? []),
    consecutiveQuestions: convState.consecutiveQuestions ?? 0,
    cards: [],
    question: null,
    searches: [],
    guardRejections: [],
  };
  const settings = (tenant.settings ?? {}) as StoreSettings;
  const system = buildSystemPrompt(tenant.name, settings, setup.policies);
  const history: HistoryTurn[] = [...setup.history, { role: 'user', content: message }];

  // 3. Run the agent loop. Each tool call gets its own short tenant-scoped transaction, so no
  //    database connection is held while waiting on the AI provider.
  const ctx = await withTenant(req.tenantId, loadSearchContext);
  const run = (p: ChatProvider) =>
    p.runTurn({
      system,
      history,
      tools: TOOL_SPECS,
      executeTool: (name, input) => withTenant(req.tenantId, (db) => makeToolExecutor({ db, ctx, provider: p, state, emit: req.emit })(name, input)),
      onText: (delta) => req.emit('text', { delta }),
      maxRounds: 6,
      signal: req.signal,
    });

  let result;
  try {
    result = await run(provider);
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    // The merchant's AI provider failed (bad key, quota, outage): answer with keyword search instead.
    await withTenant(req.tenantId, (db) =>
      db.query(`INSERT INTO events (tenant_id, conversation_id, type, meta) VALUES ($1, $2, 'ai_error', $3)`, [req.tenantId, conversationId, { kind: e.kind, message: e.message, provider: provider.id }]),
    );
    req.emit('reset', {});
    state.cards = [];
    state.question = null;
    provider = createDemoProvider();
    outcomeMode = 'fallback';
    result = await run(provider);
  }

  let text = result.text.trim();
  if (!text && state.cards.length) text = 'Here are some options for you.';
  if (!text && state.question) text = state.question.question;
  if (!text) {
    text = "Sorry, I couldn't come up with an answer for that. Could you tell me a bit more about what you're looking for?";
    req.emit('text', { delta: text });
  }

  // 4. Persist the turn, usage and analytics events.
  const nextQuestions = state.question && state.cards.length === 0 ? state.consecutiveQuestions + 1 : 0;
  await withTenant(req.tenantId, async (db) => {
    await db.query(`INSERT INTO messages (tenant_id, conversation_id, role, content) VALUES ($1, $2, 'user', $3)`, [req.tenantId, conversationId, message]);
    await db.query(`INSERT INTO messages (tenant_id, conversation_id, role, content, payload) VALUES ($1, $2, 'assistant', $3, $4)`, [
      req.tenantId,
      conversationId,
      text,
      { products: state.cards, question: state.question, mode: outcomeMode, provider: provider.id, model: provider.model, rejected: state.guardRejections },
    ]);
    const grounded = [...state.groundedIds].slice(-200);
    await db.query(`UPDATE conversations SET state = $2, message_count = message_count + 2, last_message_at = now() WHERE id = $1`, [
      conversationId,
      { consecutiveQuestions: nextQuestions, groundedIds: grounded },
    ]);
    if (result.usage.inputTokens || result.usage.outputTokens) {
      await recordUsage(db, req.tenantId, { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, model: provider.model });
    }
    for (const s of state.searches) {
      await db.query(`INSERT INTO events (tenant_id, conversation_id, type, query, meta) VALUES ($1, $2, $3, $4, $5)`, [
        req.tenantId,
        conversationId,
        s.candidates === 0 ? 'zero_result' : 'search',
        s.query,
        { total: s.total, candidates: s.candidates },
      ]);
    }
    for (const c of state.cards) {
      await db.query(`INSERT INTO events (tenant_id, conversation_id, type, product_external_id) VALUES ($1, $2, 'impression', $3)`, [req.tenantId, conversationId, c.id]);
    }
  });

  return { conversationId, text, mode: outcomeMode, overPlanLimit };
}
