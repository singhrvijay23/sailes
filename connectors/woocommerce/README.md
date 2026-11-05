# SAILES for WooCommerce

The WordPress plugin that connects a WooCommerce store to SAILES. It follows [the connector contract](../../docs/connector-contract.md).

| Folder | What it is |
| --- | --- |
| `sailes/` | The plugin itself. Zip this folder to install it (`cd connectors/woocommerce && zip -r sailes.zip sailes`) |
| `bin/setup-wordpress.sh` | Builds a throwaway WordPress + WooCommerce site on SQLite with the plugin active |
| `tests/integration.php` | End-to-end test inside that site against a running SAILES API (runs in CI) |

## What the plugin does

| Contract job | In the plugin |
| --- | --- |
| 1. Connect | WooCommerce > SAILES > **Connect to SAILES** sends the merchant to the console's `/connect` page, then the callback (`admin-post.php?action=sailes_callback`) checks `state` and exchanges the code on the server. The `sk_` key is stored encrypted with the site's salts (libsodium) and never reaches the browser. **Disconnect** and plugin uninstall revoke it. |
| 2. Catalog sync | Full sync on connect in pages of 250, a debounced sync of changed products (edits, price, stock, variation changes, trash, delete, unpublish), and a nightly resync between 2 and 4 am. All background work runs on Action Scheduler (bundled with WooCommerce) with the contract's retry rules. Hidden, draft, private and password-protected products are removed from SAILES. |
| 3. Policies | The merchant picks a page for shipping, returns, warranty, payment and contact. They are sent as plain text and resent when the page is edited. Defaults to WooCommerce's Refund and Returns page. |
| 4. Widget | One script tag on every storefront page (`wp_enqueue_script`, async). `[sailes_chat]` shows the chat inside a page instead of the bubble. |
| 5. Cart and orders | "Add to cart" on a product card adds simple products to the real cart (`?wc-ajax=sailes_add_to_cart`), refreshes classic and block mini carts and shows a "View cart" toast. Products with options open their page. The conversation id is kept in a first-party cookie, saved on the order (classic and block checkout), and each paid order is reported once. |
| AI provider | The settings page lets the store admin choose their own OpenAI, Gemini or Claude key and model (or SAILES AI credits, or keyword mode). The key is sent to SAILES, which validates and stores it; it is not saved in WordPress. Needs the API to accept connector keys on `GET/PUT /v1/stores/{id}/ai`; until then the page links to the console. |

Requirements: WordPress 6.4+, WooCommerce 8.0+, PHP 7.4+. HPOS and block checkout compatible.

Developer hooks: `sailes_product_data` (change the product sent), `sailes_product_is_syncable`, `sailes_syncable_product_types` (add custom product types such as subscriptions or bundles), `sailes_brand_taxonomies`, `sailes_show_widget`.

## Try it locally

```bash
# 1. SAILES API on :4000 (see the root README), then:
connectors/woocommerce/bin/setup-wordpress.sh /tmp/wp http://localhost:4000 http://localhost:3000
php -S localhost:8080 -t /tmp/wp          # http://localhost:8080/wp-admin  (admin / admin123)

# 2. Run the end-to-end test
php connectors/woocommerce/tests/integration.php /tmp/wp http://localhost:4000
```

To point a real site at a staging SAILES, add to `wp-config.php`:

```php
define( 'SAILES_API_URL', 'https://api.staging.sailes.ai' );
define( 'SAILES_CONSOLE_URL', 'https://app.staging.sailes.ai' );
```

## Before submitting to WordPress.org

* Replace the placeholder domains (`api.sailes.ai`, `app.sailes.ai`) once the domain is confirmed.
* Run Plugin Check (`plugin-check` plugin) and add screenshots and a banner to the SVN `assets/` folder.
* The plugin calls an external service, which `readme.txt` discloses with links to the terms and privacy policy; those pages must exist first.
