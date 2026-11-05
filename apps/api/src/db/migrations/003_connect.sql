-- Platform connector install flow (WooCommerce plugin, Shopify, Wix, Webflow apps).
-- The console issues a short-lived one-time code after the merchant approves; the connector
-- exchanges it server-to-server for a connector key. Global table: exchange happens before
-- any tenant is known, so it is looked up by code hash only.
CREATE TABLE connect_codes (
  code_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform text NOT NULL,
  shop_url text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

-- Which platform shop a connector key belongs to (one active key per shop).
ALTER TABLE api_keys ADD COLUMN platform text, ADD COLUMN shop_url text;
CREATE INDEX api_keys_shop ON api_keys(tenant_id, shop_url) WHERE revoked_at IS NULL;
