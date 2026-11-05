# SAILES Shopify app

Connects a Shopify store to SAILES, following [`docs/connector-contract.md`](../../docs/connector-contract.md). A small Node.js (Fastify, TypeScript) service plus a theme app extension.

| Job | How it works here |
| --- | --- |
| Install | Shopify-managed install (scopes in `shopify.app.toml`). On first open, the admin page's session token is exchanged for an **expiring offline token** (1 hour, refreshed with a rotating 90-day refresh token). Public apps must use expiring tokens; non-expiring ones are blocked from new installs from 2027-01-01. |
| Connect to SAILES | Admin page → "Connect to SAILES" opens the SAILES console in a new tab (`/connect?platform=shopify&shop=<primary domain>`). The console sends the merchant to `/connect/callback`, we exchange the one-time code from our server, store the `sk_` key encrypted and send the merchant back to the app in Shopify admin. |
| Catalog sync | Full sync on connect (GraphQL, 25 products per page, upserts in batches of 500), then webhooks: `products/create`, `products/update`, `products/delete`, `inventory_levels/update`. Each webhook re-reads the product from the Admin API, so data is never older than the event. Drafts, archived products and products not on the Online Store are removed from SAILES. A full resync runs every `RESYNC_HOURS` (24) to catch missed webhooks. |
| Policies | Shipping, refund, contact and terms-of-sale policies (`shop.shopPolicies`) are sent as plain text on connect and on every resync. |
| Widget | Theme app extension `extensions/sailes-chat`: an **app embed** (floating chat on every page) and an **inline block** for any section. The widget key and script URL are app metafields (`sailes.widget_key`, `sailes.script_url`) that the app writes when the store connects, so nothing is pasted into the theme. |
| Add to cart | `assets/sailes-cart.js` handles the widget's `sailes:add-to-cart` event: single-variant products go straight into the cart via `/cart/add.js` with the conversation id as a hidden line property and cart attribute; products with several variants open the product page. Merchants choose "stay on page" or "go to cart" in the app embed settings. |
| Orders | `orders/paid` webhook → `POST /orders` with the conversation id when the order came from a chat. |
| AI provider | The admin page lets the merchant pick their own OpenAI, Gemini or Claude key (or SAILES AI credits, or demo mode). The key goes from the browser to this app's server and straight on to SAILES, which validates and stores it; this app never stores it. |
| Uninstall | `app/uninstalled` revokes the SAILES key and drops the Shopify tokens. `shop/redact` deletes the shop record. `customers/data_request` and `customers/redact` need no action: no customer data is stored. |

Everything else (assistant rules, upsell, look, billing) stays in the SAILES console, which the admin page links to.

## Files

```
shopify.app.toml                 app config: scopes, webhooks, compliance webhooks, URLs
extensions/sailes-chat/          theme app extension (app embed, inline block, add-to-cart script)
public/admin.html, admin.js      embedded admin page (App Bridge + Polaris web components)
src/app.ts                       routes: admin page, /api/* (session token), /connect/callback, /webhooks
src/service.ts                   install, token refresh, connect, sync, orders, uninstall
src/mapping.ts                   GraphQL queries and Shopify → SAILES product, policy and order mapping
src/shopify.ts, src/sailes.ts    API clients with retries (throttling, 5xx, 429, token refresh)
src/store.ts                     shop records: Postgres (secrets AES-256-GCM encrypted) or in-memory
```

## Run locally

```bash
pnpm install
cp connectors/shopify/.env.example connectors/shopify/.env   # fill in the Shopify app credentials
pnpm dev:api                 # SAILES API on :4000
pnpm dev:shopify             # this app on :4100
```

To try it in a real development store you need a Shopify Partner account and the Shopify CLI:

1. Create the app in the Partner Dashboard (or `shopify app init` → link), then `shopify app config link` in `connectors/shopify` and set `client_id`.
2. Expose port 4100 over https (for example `cloudflared tunnel --url http://localhost:4100`) and put that URL in `application_url`, `auth.redirect_urls` and `SHOPIFY_APP_URL`.
3. `shopify app deploy` pushes the config, webhooks and the theme extension.
4. Install on a development store, open the app, click Connect to SAILES, then "Open theme editor" and switch on the SAILES app embed.

## Tests

```bash
pnpm --filter @sailes/shopify test
# Also against Postgres and a running SAILES API (Shopify is faked):
SHOPIFY_TEST_DATABASE_URL=postgres://sailes:sailes@localhost:5432/sailes_shopify_test \
SAILES_E2E_API_URL=http://localhost:4000 pnpm --filter @sailes/shopify test
```

The tests fake Shopify (token endpoint and Admin GraphQL) and cover: session-token checks, webhook signatures, token exchange and refresh, the connect flow, paging, every webhook topic, uninstall and redact, the AI settings form, and product mapping. The end-to-end test runs the whole connect → sync → AI settings → order flow against the real SAILES API.

## Deploying

`connectors/shopify/Dockerfile` (build from the repo root). Needs `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SAILES_API_URL`, `SAILES_CONSOLE_URL`, `DATABASE_URL` and `ENCRYPTION_KEY` (`openssl rand -base64 32`). Run one instance: background jobs and the daily resync run in-process (missed work is caught by the next resync).

## App Store submission checklist

* **Protected customer data:** `read_orders` and the `orders/paid` webhook need a "protected customer data" request in the Partner Dashboard (level 1: order data, no names or addresses are read or stored).
* Compliance webhooks are wired (`customers/data_request`, `customers/redact`, `shop/redact`).
* Listing text from the contract: "SAILES syncs your product catalog, stock and store policies, shows the SAILES assistant on your storefront and reports orders for analytics. It does not access customer payment details."
* Privacy policy URL, support email, screenshots and a demo video of install → connect → theme embed → chat.
* **Billing:** apps on the Shopify App Store must charge through Shopify (Billing API or Managed Pricing). SAILES currently bills with Stripe in the console, so this needs a decision before submission.

## Not built yet

* Shopify billing (see above).
* Bulk operations for very large catalogs (over about 25,000 products the paged full sync takes several minutes; it still completes).
* Detecting whether the app embed is switched on (needs the `read_themes` scope), and theme-specific cart drawer refresh beyond the common Online Store 2.0 hooks.
