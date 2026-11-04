-- SAILES core schema.
-- Global tables (users, tenants, widget_keys) are looked up before a tenant is known.
-- Every tenant-owned table carries tenant_id and is protected by row-level security:
-- the app sets `app.tenant_id` per transaction (see db/pool.ts withTenant).

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  site_url text,
  platform text NOT NULL DEFAULT 'custom',          -- custom | woocommerce | shopify | wix | webflow
  plan text NOT NULL DEFAULT 'starter',              -- starter | pro | enterprise
  trial_ends_at timestamptz,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,       -- persona, greeting, colours, placement
  ai_mode text NOT NULL DEFAULT 'demo',              -- demo | byok | managed
  monthly_budget_usd numeric(10,2) NOT NULL DEFAULT 50,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner',                -- owner | admin | viewer
  PRIMARY KEY (user_id, tenant_id)
);

CREATE TABLE widget_keys (
  key text PRIMARY KEY,                              -- public, e.g. pk_live_xxx
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  allowed_origins text[] NOT NULL DEFAULT '{}',      -- empty = any origin (dev only)
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX widget_keys_tenant ON widget_keys(tenant_id);

-- Tenant-owned tables ---------------------------------------------------------

CREATE TABLE ai_credentials (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL,                            -- openai | gemini | anthropic
  chat_model text NOT NULL,
  embedding_model text,
  key_ciphertext text NOT NULL,                      -- envelope-encrypted (lib/vault.ts)
  key_last4 text NOT NULL,
  validated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  brand text,
  categories text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,     -- {"flavour":"vanilla","protein_g":24}
  variants jsonb NOT NULL DEFAULT '[]'::jsonb,
  price numeric(12,2),
  compare_at_price numeric(12,2),
  currency text NOT NULL DEFAULT 'USD',
  in_stock boolean NOT NULL DEFAULT true,
  stock_qty integer,
  rating numeric(3,2),
  review_count integer,
  image_url text,
  url text,
  add_to_cart_url text,
  search_text text NOT NULL DEFAULT '',              -- flattened text used for FTS and embeddings
  search_tsv tsvector,
  embedding vector(768),
  embedding_model text,
  content_hash text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id)
);
CREATE INDEX products_tenant ON products(tenant_id);
CREATE INDEX products_tsv ON products USING gin(search_tsv);
CREATE INDEX products_title_trgm ON products USING gin(title gin_trgm_ops);
CREATE INDEX products_embedding ON products USING hnsw (embedding vector_cosine_ops);
CREATE INDEX products_needs_embedding ON products(tenant_id) WHERE embedding IS NULL;

CREATE OR REPLACE FUNCTION products_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.brand, '') || ' ' || array_to_string(NEW.categories, ' ') || ' ' || array_to_string(NEW.tags, ' ')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.search_text, '')), 'C');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER products_tsv BEFORE INSERT OR UPDATE OF title, brand, categories, tags, search_text ON products
  FOR EACH ROW EXECUTE FUNCTION products_tsv_update();

CREATE TABLE merch_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('boost','bury','exclude')),
  match_field text NOT NULL CHECK (match_field IN ('product','category','tag','brand')),
  match_value text NOT NULL,
  weight numeric(4,2) NOT NULL DEFAULT 1.5,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX merch_rules_tenant ON merch_rules(tenant_id);

CREATE TABLE synonyms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  term text NOT NULL,
  synonyms text[] NOT NULL,
  UNIQUE (tenant_id, term)
);

CREATE TABLE policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  topic text NOT NULL,                               -- shipping | returns | warranty | ...
  content text NOT NULL,
  UNIQUE (tenant_id, topic)
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  visitor_id text,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,          -- consecutiveQuestions, shownProductIds
  message_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_tenant_time ON conversations(tenant_id, created_at);

CREATE TABLE messages (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,        -- products shown, question chips, mode
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation ON messages(conversation_id, id);

CREATE TABLE events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid,
  type text NOT NULL,                                -- search | zero_result | impression | click | add_to_cart | order
  product_external_id text,
  query text,
  value numeric(12,2),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_tenant_type_time ON events(tenant_id, type, created_at);

CREATE TABLE usage_monthly (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  month date NOT NULL,
  conversations integer NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  embedding_tokens bigint NOT NULL DEFAULT 0,
  cost_usd numeric(12,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, month)
);

-- Row-level security ----------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_credentials','products','merch_rules','synonyms','policies',
                           'conversations','messages','events','usage_monthly'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- Server-to-server secret keys for platform connectors (WordPress plugin, Shopify app).
-- Global table: looked up by hash before the tenant is known.
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Connector',
  key_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX api_keys_tenant ON api_keys(tenant_id);
