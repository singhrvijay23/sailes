=== SAILES – AI Sales Assistant for WooCommerce ===
Contributors: sailes
Tags: ai, chatbot, product search, sales assistant, woocommerce
Requires at least: 6.4
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 0.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Your 24/7 digital sales associate. SAILES finds the right products, asks shoppers the right questions and recommends what fits.

== Description ==

SAILES adds an AI sales assistant to your WooCommerce store. Shoppers describe what they need in their own words; SAILES searches your catalog, asks a helpful follow-up question when there are too many options, and recommends products that are really in stock, with real prices and an "Add to cart" button.

* **Finds products by meaning, not just keywords.** "Something warm for winter runs under $80" works.
* **Sells like a good store associate.** Asks one good counter-question at a time, compares options and suggests add-ons.
* **Only recommends what you sell.** Product cards come from your synced catalog, so names, prices and stock are always right.
* **Use your own AI account.** Connect your OpenAI, Google Gemini or Anthropic Claude API key from the plugin settings, or use prepaid SAILES AI credits.
* **Knows your policies.** Answers shipping and returns questions from your own policy pages.
* **Real add to cart.** Simple products go straight into the WooCommerce cart from the chat.
* **Revenue analytics.** See orders and revenue that came from conversations in the SAILES console.

SAILES syncs your product catalog, stock and store policies, shows the SAILES assistant on your storefront and reports orders for analytics. It does not access customer payment details.

== External services ==

This plugin connects to the SAILES service, operated by True North Management Inc., to provide the assistant. A SAILES account is required (14-day free trial).

* **When you connect:** your browser is sent to the SAILES console (app.sailes.ai) with your store's address; your WordPress server then receives a store key from the SAILES API (api.sailes.ai).
* **Catalog sync:** published product data (name, description, price, stock, categories, tags, attributes, variations, image and page links, rating) is sent to the SAILES API when you connect, when products change and once a night.
* **Policies:** the text of the policy pages you choose in the settings is sent to the SAILES API.
* **AI settings:** if you enter an AI provider API key, it is sent to the SAILES API, which checks it with the provider and stores it encrypted. It is not stored in WordPress.
* **Orders:** for each paid order, the order number, total, product ids and, if the shopper used the assistant, the conversation id are sent to the SAILES API. No customer names, addresses, emails or payment details are sent.
* **Storefront:** the assistant script is loaded from the SAILES API on your store's pages. Shopper messages are sent to SAILES to be answered.

Terms of service: https://sailes.ai/terms
Privacy policy: https://sailes.ai/privacy

== Installation ==

1. Install and activate WooCommerce.
2. Upload the `sailes` folder to `/wp-content/plugins/`, or install the zip from Plugins > Add New > Upload.
3. Activate SAILES, then go to WooCommerce > SAILES and click **Connect to SAILES**.
4. Sign in or create your SAILES account and approve the connection. Your products start syncing right away.
5. Under **AI provider**, paste your OpenAI, Gemini or Claude API key and pick a model.

To show the chat inside a page (for example a "Help me choose" page) instead of the floating button, add the `[sailes_chat]` shortcode to that page.

== Frequently Asked Questions ==

= Do I need my own AI API key? =

You can use your own OpenAI, Google Gemini or Anthropic Claude key (AI usage is then billed by your provider), or buy SAILES AI credits in the SAILES console.

= Which products does the assistant recommend? =

Only published products that are visible in your shop and in stock. Hidden, draft, private and password-protected products are never shown.

= Where do I change the assistant's colors and greeting? =

In the SAILES console (WooCommerce > SAILES > Open SAILES console), along with sales rules, upsell offers, conversations, analytics and billing.

= Does it work with block themes and the block checkout? =

Yes. It works with classic and block themes, the Cart and Checkout blocks, and High-Performance Order Storage.

== Changelog ==

= 0.1.0 =
* First release: connect, catalog and policy sync, storefront assistant, add to cart, order reporting, AI provider settings.
