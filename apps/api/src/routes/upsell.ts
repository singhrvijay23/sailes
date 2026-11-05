import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { query, withTenant } from '../db/pool.js';
import { requireStore } from '../auth.js';
import { HttpError, badRequest, notFound } from '../lib/errors.js';
import { planFor } from '../lib/plans.js';

const Rule = z
  .object({
    kind: z.enum(['cross_sell', 'bundle', 'discount']),
    name: z.string().trim().min(1).max(120),
    triggerField: z.enum(['product', 'category', 'tag', 'any']).nullish(),
    triggerValue: z.string().trim().max(200).nullish(),
    targetProductIds: z.array(z.string().min(1).max(200)).max(20).default([]),
    discountCode: z.string().trim().max(60).nullish(),
    discountText: z.string().trim().max(200).nullish(),
    minCartValue: z.number().min(0).max(1_000_000).nullish(),
    active: z.boolean().default(true),
    startsAt: z.string().datetime({ offset: true }).nullish(),
    endsAt: z.string().datetime({ offset: true }).nullish(),
  })
  .superRefine((r, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (r.triggerField && r.triggerField !== 'any' && !r.triggerValue) issue('triggerValue', 'Required for this trigger');
    if (r.kind === 'cross_sell') {
      if (!r.triggerField) issue('triggerField', 'Choose when to suggest these products');
      if (!r.targetProductIds.length) issue('targetProductIds', 'Add at least one product to suggest');
    }
    if (r.kind === 'bundle' && r.targetProductIds.length < 2) issue('targetProductIds', 'A bundle needs at least two products');
    if (r.kind === 'discount') {
      if (!r.triggerField) issue('triggerField', 'Choose which products the discount applies to');
      if (!r.discountText) issue('discountText', 'Describe the offer, e.g. "10% off when you buy two"');
    }
    if (r.startsAt && r.endsAt && new Date(r.endsAt) <= new Date(r.startsAt)) issue('endsAt', 'Must be after the start');
  });

async function requireUpsellPlan(req: FastifyRequest) {
  const t = (await query('SELECT plan FROM tenants WHERE id = $1', [req.store!.tenantId])).rows[0];
  if (!planFor(t.plan).upsellRules) throw new HttpError(402, 'Upsell, bundle and discount rules are part of the Pro plan', 'plan_required');
}

const COLUMNS = `id, kind, name, trigger_field, trigger_value, target_product_ids, discount_code, discount_text,
  min_cart_value::float AS min_cart_value, active, starts_at, ends_at, created_at`;

export async function upsellRoutes(app: FastifyInstance) {
  const readers = requireStore(['owner', 'admin', 'viewer']);
  const writers = requireStore(['owner', 'admin']);

  app.get('/v1/stores/:storeId/upsell-rules', { preHandler: readers }, async (req) => {
    const t = (await query('SELECT plan FROM tenants WHERE id = $1', [req.store!.tenantId])).rows[0];
    const rules = await withTenant(req.store!.tenantId, async (db) => (await db.query(`SELECT ${COLUMNS} FROM upsell_rules ORDER BY created_at`)).rows);
    return { available: planFor(t.plan).upsellRules, rules };
  });

  async function save(req: FastifyRequest, id?: string) {
    await requireUpsellPlan(req);
    const r = Rule.parse(req.body);
    const tenantId = req.store!.tenantId;
    return withTenant(tenantId, async (db) => {
      if (r.targetProductIds.length) {
        const found = (await db.query<{ external_id: string }>('SELECT external_id FROM products WHERE external_id = ANY($1)', [r.targetProductIds])).rows.map((x) => x.external_id);
        const missing = r.targetProductIds.filter((x) => !found.includes(x));
        if (missing.length) throw badRequest(`Not in your catalog: ${missing.join(', ')}`, 'unknown_products');
      }
      const values = [
        r.kind,
        r.name,
        r.triggerField ?? null,
        r.triggerField === 'any' ? null : (r.triggerValue ?? null),
        r.targetProductIds,
        r.discountCode || null,
        r.discountText || null,
        r.minCartValue ?? null,
        r.active,
        r.startsAt ?? null,
        r.endsAt ?? null,
      ];
      if (id) {
        const row = (
          await db.query(
            `UPDATE upsell_rules SET kind=$2, name=$3, trigger_field=$4, trigger_value=$5, target_product_ids=$6, discount_code=$7, discount_text=$8,
               min_cart_value=$9, active=$10, starts_at=$11, ends_at=$12 WHERE id = $1 RETURNING ${COLUMNS}`,
            [id, ...values],
          )
        ).rows[0];
        if (!row) throw notFound('Rule not found');
        return row;
      }
      return (
        await db.query(
          `INSERT INTO upsell_rules (tenant_id, kind, name, trigger_field, trigger_value, target_product_ids, discount_code, discount_text, min_cart_value, active, starts_at, ends_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${COLUMNS}`,
          [tenantId, ...values],
        )
      ).rows[0];
    });
  }

  const idParam = (req: FastifyRequest) => {
    const id = (req.params as { id: string }).id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Rule not found');
    return id;
  };

  app.post('/v1/stores/:storeId/upsell-rules', { preHandler: writers }, async (req) => save(req));
  app.put('/v1/stores/:storeId/upsell-rules/:id', { preHandler: writers }, async (req) => save(req, idParam(req)));
  app.delete('/v1/stores/:storeId/upsell-rules/:id', { preHandler: writers }, async (req) => {
    const id = idParam(req);
    await withTenant(req.store!.tenantId, (db) => db.query('DELETE FROM upsell_rules WHERE id = $1', [id]));
    return { ok: true };
  });
}
