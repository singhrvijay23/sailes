# SAILES

**Your 24/7 digital sales associate.** SAILES is a chat assistant for online stores that finds products through conversation, asks the follow-up questions a good salesperson would, recommends from the store's own catalog and suggests add-ons.

This repository is **Part 1: the SaaS core**. The WordPress/WooCommerce plugin (Part 2) and the Shopify, Wix and Webflow apps (Part 3) are thin connectors on top of it.

Copyright © True North Management Inc. (TNMI), Surrey, British Columbia. All rights reserved. Proprietary and confidential.

## What's in here

| Path | What it is |
| --- | --- |
| `apps/api` | Node.js + Fastify + TypeScript API: accounts, stores, AI key vault, catalog import and sync, hybrid search, the sales-agent orchestrator, chat streaming, analytics |
| `apps/widget` | The shopper chat widget (Preact, Shadow DOM, about 10 KB gzipped), installed with one script tag |
| `apps/console` | Merchant console (Next.js + Tailwind): sign up, connect AI key, import catalog, rules, branding, test chat, transcripts, analytics, install snippet |
| `apps/api/src/data/samples` | Three sample stores (wellness, gifts, apparel) for demos, manual testing and the quality eval |
| `connectors/shopify` | Shopify app (Part 3): embedded admin page, catalog and policy sync, theme app extension for the assistant, add to cart, order reporting. See its [README](connectors/shopify/README.md) |
| `infra` | Database bootstrap SQL |
| `docs/connector-contract.md` | The contract every platform connector (WooCommerce, Shopify, Wix, Webflow) follows: install flow, catalog sync, widget, add to cart, orders |

## Run it locally

You need Node 22+, pnpm 10, and Docker (for Postgres with pgvector, and Redis).

```bash
cp .env.example .env              # then set SAILES_MASTER_KEY: openssl rand -base64 32
docker compose up -d              # Postgres 16 + pgvector, Redis
pnpm install
pnpm --filter @sailes/widget build
pnpm seed                         # creates tables + 3 demo stores
pnpm dev:api                      # http://localhost:4000
pnpm dev:console                  # http://localhost:3000  (in another terminal)
```

Then:

* **Console:** http://localhost:3000, sign in as `demo@sailes.dev` / `sailes-demo-123` (three demo stores, switch in the sidebar), or sign up a new store.
* **Storefront demo:** http://localhost:4000/demo/?key=pk_demo_wellness (also `pk_demo_gifts`, `pk_demo_apparel`). Click the chat bubble.
* **Terminal chat:** `pnpm --filter @sailes/api exec tsx src/scripts/try-chat.ts pk_demo_gifts "gift for my dad under $40"`

Without an AI key the assistant runs in **demo mode**: rule-based, free, same search, guard and widget. Connect a real key under *AI connection* in the console to get full conversations.

## How a conversation works

1. The widget POSTs the shopper's message to `/v1/chat` and reads a server-sent event stream (`text`, `products`, `question`, `done`).
2. The orchestrator gives the store's AI model (OpenAI, Gemini or Claude, using the merchant's own key) a sales-associate system prompt and seven tools: `search_products`, `get_product`, `compare_products`, `get_related`, `get_policy`, `show_products`, `ask_question`.
3. `search_products` runs hybrid search: Postgres full-text + trigram fuzzy match + pgvector embeddings, fused with reciprocal rank fusion, with price/attribute/exclusion filters, synonyms and the merchant's boost/bury/exclude rules. It returns facets and a `narrowing_suggested` flag so the AI asks one good counter-question when results are broad (never more than two in a row).
4. **The guard:** `show_products` only renders products that exist in this store's catalog, were returned by a tool in this conversation, are in stock and are not excluded. Cards are built from the database, so names and prices are always real.
5. If the AI provider fails, or the merchant's monthly AI budget is used up, the turn is answered in keyword mode instead of failing.

## Security notes

* **Tenant isolation:** every tenant table has Postgres row-level security keyed on `app.tenant_id`; the app role is not a superuser, so RLS always applies.
* **AI keys:** envelope encryption (AES-256-GCM per-secret data key, wrapped by a key-encryption key). Locally the KEK is `SAILES_MASTER_KEY`; production swaps in AWS KMS through the `KeyWrapper` interface. Keys are validated with a live call before saving, shown only as the last 4 characters, and redacted from logs.
* **Widget keys** (`pk_…`) are public and scoped to the store's allowed websites. **Connector keys** (`sk_…`) are secret, stored hashed, and can only sync catalog, policies and orders.
* Rate limits on chat, events, signup and login; per-conversation message cap.

## Tests and quality

```bash
pnpm --filter @sailes/api test    # unit + integration + API tests (needs Postgres; uses the sailes_test database)
pnpm --filter @sailes/api eval    # answer-quality eval on the sample stores (demo mode)
EVAL_PROVIDER=openai EVAL_API_KEY=sk-... pnpm --filter @sailes/api eval   # same eval with a real model
```

The Part 1 release gate is 90%+ relevant answers with zero invented products, measured by the eval (40 cases today, growing to 200+).

## API overview

| | Endpoint |
| --- | --- |
| Auth | `POST /v1/auth/signup`, `POST /v1/auth/login`, `GET /v1/me` |
| Store | `GET/PATCH /v1/stores/:id`, `GET /v1/plans` |
| AI | `GET /v1/ai/providers`, `GET/PUT/DELETE /v1/stores/:id/ai` |
| Catalog | `POST /v1/stores/:id/catalog/import` (CSV/JSON file), `PUT /v1/stores/:id/catalog/products` (connector sync), `POST …/catalog/products/delete`, `GET …/catalog`, `GET …/catalog/search` |
| Rules | `GET/POST/DELETE /v1/stores/:id/rules`, `PUT/DELETE …/synonyms`, `PUT/DELETE …/policies` |
| Keys | `PUT …/widget-keys/:key` (allowed sites), `GET/POST/DELETE …/api-keys` |
| Insights | `GET …/analytics`, `GET …/conversations`, `GET …/conversations/:cid`, `POST …/orders` |
| Billing | `GET …/billing`, `POST …/billing/checkout`, `POST …/billing/portal`, `POST …/billing/credits`, `POST /v1/billing/webhook` |
| Upsell (Pro) | `GET/POST …/upsell-rules`, `PUT/DELETE …/upsell-rules/:id` |
| Connectors | `POST …/connect/approve`, `POST /v1/connect/exchange`, `GET /v1/connector/store`, `POST /v1/connector/disconnect` |
| Widget (public) | `GET /v1/widget/config`, `POST /v1/chat` (SSE), `POST /v1/events` |

Connectors listen for the widget's `sailes:add-to-cart` DOM event (call `preventDefault()` to handle it) and add the product to the platform's real cart.

## Billing, credits and upsell

* **Plans and trial:** every new store gets a 14-day free trial. Merchants subscribe from *Billing* in the console (Stripe Checkout, remaining trial days carry over) and manage cards, invoices, plan changes and cancellation in the Stripe customer portal. Stripe webhooks (`POST /v1/billing/webhook`, signed and applied once per event) set the plan and status. When the trial has ended and there is no live subscription, the widget stops loading (HTTP 402). A failed renewal keeps the store working during Stripe's retries.
* **SAILES AI credits:** merchants without their own AI key buy prepaid packs ($20, $50 → $55, $100 → $120). Each AI reply is charged at estimated provider cost × `CREDIT_MARKUP`. At zero balance the assistant answers in keyword mode instead of failing.
* **Upsell rules (Pro and Enterprise):** cross-sells, bundles and discount offers under *Upsell & bundles*. The assistant puts the merchant's cross-sells first, offers a bundle only when every item is in stock, and mentions only discounts the merchant configured.
* Without `STRIPE_SECRET_KEY`, billing is off and plans can be switched directly (development).

## Platform connectors

[`docs/connector-contract.md`](docs/connector-contract.md) is the contract the WooCommerce, Shopify, Wix and Webflow connectors follow: the one-time-code install flow (`/connect` in the console, `POST /v1/connect/exchange`), catalog and policy sync, the widget tag, the add-to-cart event and order reporting.

* Shopify: [`connectors/shopify`](connectors/shopify/README.md)

## Free test site (Render)

`render.yaml` deploys a single-service test copy on Render's free plan: the API also serves the console, so one web service and one Postgres database are enough. In Render: *New → Blueprint*, pick this repository and branch, *Apply*. The demo merchant (`demo@sailes.dev`) is created on first start with the password in the service's `SEED_DEMO_PASSWORD` environment variable. Billing is off, so plans can be switched directly. Not for production: free services sleep after 15 idle minutes and the free database expires after 30 days.

## Hosting

Docker images: `apps/api/Dockerfile`, `apps/console/Dockerfile`. AWS (US) with Terraform: [`infra/terraform`](infra/terraform/README.md) (ECS Fargate, RDS Postgres + pgvector, ElastiCache Redis, KMS for the AI-key vault, ALB, alarms).

## Not built yet (next milestones)

* The platform connectors themselves (Part 2 and 3)
* Team seats and roles UI, 2FA, audit log, transcript retention job
* Sentry/OpenTelemetry, Langfuse tracing, shared (Redis) rate limits
* Live-model eval runs, growing the eval to 200+ cases
