import type { Db } from '../db/pool.js';

/**
 * Merchant-configured upsell rules (Pro and Enterprise).
 *   cross_sell: when the trigger matches the product being discussed, suggest the target products
 *   bundle:     a named set of products sold together; matches when the product is in the set or the trigger matches
 *   discount:   a promotion the assistant may mention when the trigger matches. The AI never invents one.
 */
export interface UpsellRule {
  id: string;
  kind: 'cross_sell' | 'bundle' | 'discount';
  name: string;
  trigger_field: 'product' | 'category' | 'tag' | 'any' | null;
  trigger_value: string | null;
  target_product_ids: string[];
  discount_code: string | null;
  discount_text: string | null;
  min_cart_value: number | null;
}

export interface UpsellProduct {
  external_id: string;
  categories: string[];
  tags: string[];
}

export async function activeUpsellRules(db: Db): Promise<UpsellRule[]> {
  const { rows } = await db.query<UpsellRule>(
    `SELECT id, kind, name, trigger_field, trigger_value, target_product_ids, discount_code, discount_text, min_cart_value::float AS min_cart_value
     FROM upsell_rules
     WHERE active AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())
     ORDER BY created_at`,
  );
  return rows;
}

const lc = (s: string) => s.trim().toLowerCase();

export function triggerMatches(rule: Pick<UpsellRule, 'trigger_field' | 'trigger_value'>, p: UpsellProduct) {
  const v = rule.trigger_value ? lc(rule.trigger_value) : '';
  switch (rule.trigger_field) {
    case 'any':
      return true;
    case 'product':
      return lc(p.external_id) === v;
    case 'category':
      return p.categories.some((c) => lc(c) === v);
    case 'tag':
      return p.tags.some((t) => lc(t) === v);
    default:
      return false;
  }
}

export interface UpsellMatch {
  /** Target product ids from cross-sell rules, in rule order, with the rule name as the reason. */
  crossSell: Array<{ id: string; rule: string }>;
  bundles: Array<{ name: string; productIds: string[]; discountText: string | null; discountCode: string | null }>;
  offers: Array<{ name: string; text: string; code: string | null; minCartValue: number | null }>;
}

export function matchUpsells(rules: UpsellRule[], p: UpsellProduct): UpsellMatch {
  const out: UpsellMatch = { crossSell: [], bundles: [], offers: [] };
  const seen = new Set<string>([p.external_id]);
  for (const r of rules) {
    if (r.kind === 'cross_sell' && triggerMatches(r, p)) {
      for (const id of r.target_product_ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.crossSell.push({ id, rule: r.name });
      }
    } else if (r.kind === 'bundle' && (r.target_product_ids.includes(p.external_id) || triggerMatches(r, p))) {
      out.bundles.push({ name: r.name, productIds: r.target_product_ids, discountText: r.discount_text, discountCode: r.discount_code });
    } else if (r.kind === 'discount' && r.discount_text && triggerMatches(r, p)) {
      out.offers.push({ name: r.name, text: r.discount_text, code: r.discount_code, minCartValue: r.min_cart_value });
    }
  }
  return out;
}
