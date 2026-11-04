import { hashEmbed, HASH_EMBED_MODEL, tokenize } from '../hashEmbed.js';
import type { ChatProvider, TurnInput, TurnResult } from '../types.js';

/**
 * Demo provider: a deterministic, rule-based sales agent that drives the same tools and
 * guard as the real LLM providers. It lets merchants (and our QA) try SAILES end to end
 * before connecting an AI key, and keeps tests free and repeatable.
 */
export function parseShopperFilters(text: string) {
  const t = text.toLowerCase();
  const filters: Record<string, any> = {};
  const money = '\\$?\\s?(\\d+(?:\\.\\d+)?)';
  let m = new RegExp(`between\\s+${money}\\s+(?:and|to|-)\\s+${money}`).exec(t);
  if (m) {
    filters.min_price = Number(m[1]);
    filters.max_price = Number(m[2]);
  }
  m = new RegExp(`(?:under|below|less than|cheaper than|max(?:imum)?|up to|no more than|within)\\s+${money}`).exec(t);
  if (m) filters.max_price = Number(m[1]);
  m = /(?:over|above|more than|at least|min(?:imum)?)\s+\$\s?(\d+(?:\.\d+)?)/.exec(t);
  if (m) filters.min_price = Number(m[1]);
  const exclude = new Set<string>();
  for (const x of t.matchAll(/\b(?:no|without|free of|avoid|not)\s+([a-z]+)/g)) if (!['more', 'than', 'longer', 'idea', 'sure'].includes(x[1]!)) exclude.add(x[1]!);
  for (const x of t.matchAll(/\b([a-z]+)[- ]free\b/g)) exclude.add(x[1]!);
  if (exclude.size) filters.exclude_terms = [...exclude];
  const attributes: Record<string, { min: number }> = {};
  for (const x of t.matchAll(/(?:at least|min(?:imum)?|over)\s+(\d+)\s*g(?:rams?)?\s+(?:of\s+)?([a-z]+)/g)) attributes[`${x[2]}_g`] = { min: Number(x[1]) };
  if (Object.keys(attributes).length) filters.attributes = attributes;
  return filters;
}

const POLICY_WORDS: Record<string, string[]> = {
  shipping: ['shipping', 'ship', 'delivery', 'deliver', 'gift wrap', 'wrap'],
  returns: ['return', 'refund', 'exchange'],
  warranty: ['warranty', 'guarantee'],
};

const GREETING = /^(hi|hello|hey|yo|good (morning|afternoon|evening)|hiya|howdy)\b[!. ]*$/i;

function chunks(s: string) {
  return s.match(/.{1,24}(\s|$)/g) ?? [s];
}

export function createDemoProvider(): ChatProvider {
  return {
    id: 'demo',
    model: 'sailes-demo',
    embeddingModel: HASH_EMBED_MODEL,
    async validate() {},
    async embed(texts) {
      return { vectors: texts.map(hashEmbed), tokens: 0 };
    },

    async runTurn(input: TurnInput): Promise<TurnResult> {
      let text = '';
      const say = async (s: string) => {
        for (const c of chunks(s)) {
          text += c;
          input.onText(c);
        }
      };
      const done = (): TurnResult => ({ text, usage: { inputTokens: 0, outputTokens: 0 }, rounds: 1, stopReason: 'done' });

      const users = input.history.filter((h) => h.role === 'user').map((h) => h.content);
      const last = users.at(-1) ?? '';
      const prevAssistant = input.history.filter((h) => h.role === 'assistant').at(-1)?.content ?? '';

      if (GREETING.test(last.trim())) {
        await say("Hi! I'm here to help you find the right product. What are you shopping for today?");
        return done();
      }

      const lower = last.toLowerCase();
      for (const [topic, words] of Object.entries(POLICY_WORDS)) {
        if (words.some((w) => lower.includes(w)) && tokenize(lower).length <= 8) {
          const res: any = await input.executeTool('get_policy', { topic });
          await say(res?.content ? res.content : `I don't have the ${topic} details yet. The store team can help you with that.`);
          return done();
        }
      }

      // A short reply right after a counter-question is an answer to it: combine with the earlier request.
      const answeringQuestion = prevAssistant.trim().endsWith('?') && last.split(/\s+/).length <= 5 && users.length > 1;
      const query = answeringQuestion ? users.slice(-3).join(' ') : last;
      const filters = parseShopperFilters(query);

      let res: any = await input.executeTool('search_products', { query, ...filters, limit: 6 });
      let relaxedNote = '';
      if (!res?.products?.length && (filters.max_price || filters.exclude_terms || filters.attributes)) {
        const relaxed = { ...filters };
        if (relaxed.max_price) {
          delete relaxed.max_price;
          relaxedNote = "I couldn't find a match in that price range, so here are the closest options at other prices.";
        } else if (relaxed.attributes) {
          delete relaxed.attributes;
          relaxedNote = "Nothing matched every detail, so I loosened one requirement.";
        } else {
          delete relaxed.exclude_terms;
          relaxedNote = 'Nothing matched with that exclusion, so please check the ingredients on these closest options.';
        }
        res = await input.executeTool('search_products', { query, ...relaxed, limit: 6 });
      }
      // The shopper tapped/typed one of the facet values we offered: apply it as a hard filter.
      if (answeringQuestion && res?.facets?.length) {
        const answer = last.trim().toLowerCase();
        const facet = res.facets.find((f: any) => f.attribute !== 'price' && f.values.some((v: any) => String(v.value).toLowerCase() === answer));
        if (facet) {
          const key = facet.attribute === 'brand' ? 'brands' : facet.attribute === 'category' ? 'categories' : null;
          const narrowed = key ? { ...filters, [key]: [answer] } : { ...filters, attributes: { ...(filters.attributes ?? {}), [facet.attribute]: answer } };
          const again: any = await input.executeTool('search_products', { query, ...narrowed, limit: 6 });
          if (again?.products?.length) res = again;
        }
      }
      if (!res?.products?.length) {
        await say("I couldn't find anything matching that in this store. Could you describe it another way, for example the type of product or what you'll use it for?");
        return done();
      }

      if (res.narrowing_suggested && !res.must_recommend && res.facets?.length) {
        const mentioned = query.toLowerCase();
        const facet = res.facets.find((f: any) => f.attribute !== 'price' && !f.values.some((v: any) => mentioned.includes(String(v.value).toLowerCase()))) ?? null;
        if (facet) {
          const label = facet.attribute.replace(/_/g, ' ');
          const options = facet.values.slice(0, 4).map((v: any) => String(v.value));
          const question = `I found ${res.total_matches} good options. To narrow it down, which ${label} do you prefer?`;
          await input.executeTool('ask_question', { question, options });
          await say(question);
          return done();
        }
      }

      const top = res.products.slice(0, 3);
      const terms = tokenize(query);
      const reason = (p: any) => {
        const bits: string[] = [];
        const attrs = Object.entries(p.attributes ?? {}).filter(([k, v]) => !/^(no|false)$/i.test(String(v)) && terms.some((t) => `${k} ${v}`.toLowerCase().includes(t)));
        if (attrs.length) bits.push(attrs.slice(0, 2).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(', '));
        if (p.rating) bits.push(`rated ${p.rating}/5${p.review_count ? ` by ${p.review_count} shoppers` : ''}`);
        if (filters.max_price && p.price != null && p.price <= filters.max_price) bits.push('within your budget');
        return bits.length ? bits.join('; ') : 'A close match for what you described';
      };
      const shown: any = await input.executeTool('show_products', { items: top.map((p: any) => ({ product_id: p.id, reason: reason(p) })) });
      const count = shown?.shown?.length ?? top.length;
      if (relaxedNote) await say(relaxedNote + ' ');
      await say(count === 1 ? 'Here is my top pick for you.' : `Here are my top ${count} picks for you.`);
      const related: any = await input.executeTool('get_related', { product_id: top[0].id });
      const comp = related?.products?.[0];
      const bundle = related?.bundles?.[0];
      const offer = related?.offers?.[0];
      if (bundle) await say(` It's also part of our ${bundle.name} bundle${bundle.discount ? `: ${bundle.discount}` : ''}.`);
      else if (comp?.why === 'store recommendation') await say(` We recommend pairing the ${top[0].title} with the ${comp.title}.`);
      else if (comp) await say(` Shoppers who buy the ${top[0].title} often add the ${comp.title} too.`);
      if (offer) await say(` Good news: ${offer.text}${offer.code ? ` (use code ${offer.code})` : ''}.`);
      await say(' Would you like me to compare any of these?');
      return done();
    },
  };
}
