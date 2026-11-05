# SAILES connector contract

Every platform integration (WooCommerce plugin, Shopify app, Wix app, Webflow app) is a thin connector on top of the SAILES API. They all do the same five jobs the same way, so the four builds can run in parallel. This document is the contract between them and the SAILES core.

| Job | How |
| --- | --- |
| 1. Connect | One-time code install flow, gives the connector a secret key |
| 2. Sync the catalog | Full sync on install, then push changes as the platform reports them, plus a nightly resync |
| 3. Sync policies | Push shipping, returns and similar pages as plain text |
| 4. Show the widget | Inject one script tag on the storefront |
| 5. Add to cart and orders | Listen for the widget's add-to-cart event, report orders |

Base URL: the `apiUrl` returned by the exchange; never hard-code it. The production domains in this document (`api.sailes.ai`, `app.sailes.ai`) are placeholders until the domain is confirmed. All requests and responses are JSON. Errors look like `{ "error": "code", "message": "Readable text" }`.

## 1. Connect (install flow)

```
Merchant installs app ──► connector backend ──► browser to SAILES console /connect
                                                  merchant signs in or signs up, clicks Allow
connector redirect_uri ◄── ?code=cc_...&state=... ◄┘
connector backend ── POST /v1/connect/exchange {code} ──► { storeId, apiKey, widgetKey, apiUrl, widgetScriptUrl }
```

**Step 1.** Send the merchant's browser to:

```
https://app.sailes.ai/connect?platform=shopify&shop=https://acme.myshopify.com&redirect_uri=https://shopify.sailes.ai/callback&state=<random>
```

* `platform`: `woocommerce`, `shopify`, `wix` or `webflow`
* `shop`: the storefront origin shoppers visit (it is added to the widget key's allowed sites)
* `redirect_uri`: your callback, https only
* `state`: at least 8 random characters; store it in the merchant's session and check it on return (CSRF protection)

**Step 2.** The console handles sign-in or signup (new merchants get the 14-day trial), store choice and consent, then redirects to `redirect_uri?code=cc_...&state=...`.

**Step 3.** From your server (never the browser), exchange the code within 10 minutes. It works once.

```http
POST /v1/connect/exchange
{ "code": "cc_..." }

200 { "storeId": "uuid", "apiKey": "sk_...", "widgetKey": "pk_...", "apiUrl": "https://api.sailes.ai", "widgetScriptUrl": "https://api.sailes.ai/widget/sailes.js" }
```

Store `apiKey` encrypted on your side (WordPress: in an option encrypted with the site's salts; apps: in your database). It is shown once. Reconnecting the same shop revokes the old key and returns a new one.

**Health and settings:** `GET /v1/connector/store` with `Authorization: Bearer sk_...` returns `{ storeId, storeName, plan, platform, shopUrl, active, widgetKey, widgetScriptUrl, consoleUrl }`. Call it when the merchant opens your app's settings page. `active: false` means the trial ended without a subscription: show a "Choose a plan" link to `consoleUrl + "/billing"`, and the widget will not appear.

**Uninstall:** `POST /v1/connector/disconnect` with the key revokes it. Call it from the platform's uninstall hook. Catalog data stays in SAILES until the merchant deletes the store.

## 2. Catalog sync

All catalog calls use `Authorization: Bearer sk_...` and the `storeId` from the exchange.

```http
PUT /v1/stores/{storeId}/catalog/products
{ "products": [ { ...product }, ... ] }          // up to 5,000 per request

200 { "created": 10, "updated": 2, "unchanged": 488, "rejected": 0, "errors": [] }
402 { "error": "product_limit", ... }            // plan limit reached; show the message to the merchant
```

```http
POST /v1/stores/{storeId}/catalog/products/delete
{ "ids": ["123", "456"] }
```

Upserts are keyed on `id` and idempotent: sending an unchanged product costs nothing (no re-embedding). So retries are safe and a nightly full resync is cheap.

### Product fields

Send the platform's own field names where they match these aliases; the importer maps them.

| Field | Required | Accepted names | Notes |
| --- | --- | --- | --- |
| id | yes | `id`, `external_id`, `sku`, `product_id`, `handle` | The platform's stable product id. Use the parent product id, not a variant id. |
| title | yes | `title`, `name` | |
| description | | `description`, `body_html`, `short_description` | HTML is stripped |
| price | yes | `price`, `sale_price`, `variant_price` | Number, the current selling price (lowest variant price for variable products) |
| compare_at_price | | `compare_at_price`, `regular_price`, `msrp` | Shown as a strikethrough when higher than price |
| currency | | `currency` | Default `USD` |
| in_stock | yes | `in_stock`, `stock_status`, `available` | `true`/`false`, or Woo's `instock`/`outofstock`. Out-of-stock products are never recommended. |
| stock_qty | | `stock_qty`, `stock_quantity`, `inventory_quantity` | |
| brand | | `brand`, `vendor` | |
| categories | | `categories`, `product_type`, `collections` | Array of names, most specific last is fine |
| tags | | `tags` | Array or comma string |
| attributes | | `attributes`, or `attr:<name>` keys | `{ "color": "blue", "size": "M" }` or Woo's `[{ name, options }]` |
| variants | | `variants` | Array of `{ id, title, price, in_stock, attributes }`, max 20 used |
| rating, review_count | | `rating`/`average_rating`, `review_count`/`rating_count` | |
| image_url | | `image_url`, `image`, `thumbnail` | Absolute URL |
| url | yes | `url`, `permalink` | Product page on the storefront |
| add_to_cart_url | | `add_to_cart_url` | Fallback link if the connector does not handle the add-to-cart event |

### When to sync

| Platform event | Call |
| --- | --- |
| Install / reconnect | Full sync, in pages of 250-1,000 |
| Product created or updated (webhook / hook) | `PUT products` with that product |
| Stock change | `PUT products` with that product (stock decides what is recommended) |
| Product deleted, unpublished or hidden | `POST products/delete` |
| Nightly (connector's own scheduler) | Full resync, catches missed webhooks |

Platform webhooks: Woo `woocommerce_update_product`, `woocommerce_product_set_stock_status`, `before_delete_post`; Shopify `products/create`, `products/update`, `products/delete`, `inventory_levels/update`; Wix `wix.stores.v1.product_*` events; Webflow `ecomm_inventory_changed`, `collection_item_*` for the products collection.

## 3. Policies

```http
PUT /v1/stores/{storeId}/policies
{ "topic": "shipping", "content": "Free US shipping over $50..." }     // plain text, max 4,000 chars
```

Topics the assistant looks for: `shipping`, `returns`, `warranty`, `payment`, `contact`. Map the platform's policy pages (Shopify `shop.policies`, Woo pages chosen in the plugin settings) and resend on change. Upsert by topic.

## 4. Show the widget

Add one tag to every storefront page (WordPress: `wp_footer`; Shopify: theme app embed block; Wix: embedded script via the app's site extension; Webflow: custom code via the Data API):

```html
<script src="{widgetScriptUrl}" data-sailes-key="{widgetKey}" async></script>
```

Optional attributes: `data-mode="inline"` with `data-target="#css-selector"` renders the chat inside a page element instead of the floating bubble. The widget loads its look (colors, greeting, placement) from SAILES, so the connector has no appearance settings of its own; link to the console instead.

The widget only answers on the allowed sites of its key. The exchange adds the `shop` origin automatically; allow-list changes take up to a minute to apply. Merchants add more sites (custom domains) in the console under Install.

JavaScript API on the page: `window.SAILES.open()`, `.close()`, `.send("text")`, for example to open the chat from a "Help me choose" button.

## 5. Add to cart and orders

When a shopper clicks "Add to cart" on a product card, the widget dispatches a cancelable DOM event:

```js
window.addEventListener('sailes:add-to-cart', (e) => {
  e.preventDefault();                       // tells the widget you handled it
  const { productId, url, addToCartUrl, conversationId } = e.detail;
  // Woo:     POST /?wc-ajax=add_to_cart (product_id), then refresh fragments
  // Shopify: POST /cart/add.js { id: <variant id>, quantity: 1, properties: { _sailes_conversation: conversationId } }
  // Wix:     wix-ecom-frontend addToCart; Webflow: Webflow e-commerce add-to-cart form
});
```

If nobody calls `preventDefault()`, the widget navigates to `addToCartUrl` or the product page. For variable products without a chosen variant, open the product page.

Keep `conversationId` with the cart (Shopify cart attribute or line property, Woo session, Wix/Webflow cart note or local storage), then report completed orders:

```http
POST /v1/stores/{storeId}/orders
{ "orderId": "1001", "total": 64.00, "conversationId": "uuid or null", "productIds": ["123", "456"] }

200 { "ok": true, "duplicate": false }
```

Orders are recorded once per `orderId`, so webhook retries are safe. Send every order, with `conversationId` when known: analytics shows revenue from chat versus the store total.

## Rules for every connector

* **Keys:** the `sk_` key lives only on the connector's server or the merchant's WordPress server. Never send it to the browser. Never log it.
* **Retries:** retry 5xx and network errors with exponential backoff (1s, 2s, 4s, 8s, 16s). Do not retry 4xx except 429 (wait for `retry-after`).
* **Limits:** at most 5,000 products per request; keep to about 10 requests per second per store.
* **No AI settings in the connector.** AI keys, rules, upsell, appearance and billing are managed in the SAILES console; the connector links to it (`consoleUrl`).
* **Platform review:** each app store needs the merchant-facing text: "SAILES syncs your product catalog, stock and store policies, shows the SAILES assistant on your storefront and reports orders for analytics. It does not access customer payment details."
