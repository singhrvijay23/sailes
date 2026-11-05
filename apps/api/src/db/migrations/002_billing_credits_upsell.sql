-- Billing (Stripe), SAILES AI prepaid credits, and Pro-tier upsell rules.

ALTER TABLE tenants
  ADD COLUMN stripe_customer_id text UNIQUE,
  ADD COLUMN stripe_subscription_id text UNIQUE,
  ADD COLUMN subscription_status text,          -- trialing | active | past_due | canceled | unpaid | incomplete ...
  ADD COLUMN billing_interval text,             -- month | year
  ADD COLUMN current_period_end timestamptz,
  ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false;

-- Webhook idempotency: Stripe retries deliveries, each event is applied once. Global table.
CREATE TABLE stripe_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- SAILES AI credits: an append-only ledger in USD. Balance = sum(delta_usd).
CREATE TABLE credit_ledger (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  delta_usd numeric(12,4) NOT NULL,
  reason text NOT NULL,                         -- purchase | usage | grant | refund
  stripe_session_id text UNIQUE,                -- set for purchases, makes crediting idempotent
  conversation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_tenant ON credit_ledger(tenant_id, created_at);

-- Upsell / cross-sell (Pro and Enterprise).
--   cross_sell: when trigger product/category is shown, suggest the target products
--   bundle:     a named set of products sold together, optionally with a discount the merchant configured
--   discount:   a promo the assistant may mention when its condition matches (never invented by the AI)
CREATE TABLE upsell_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('cross_sell', 'bundle', 'discount')),
  name text NOT NULL,
  trigger_field text CHECK (trigger_field IN ('product', 'category', 'tag', 'any')),
  trigger_value text,
  target_product_ids text[] NOT NULL DEFAULT '{}',
  discount_code text,
  discount_text text,                           -- e.g. "10% off when you buy both"
  min_cart_value numeric(12,2),
  active boolean NOT NULL DEFAULT true,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX upsell_rules_tenant ON upsell_rules(tenant_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['credit_ledger', 'upsell_rules'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
