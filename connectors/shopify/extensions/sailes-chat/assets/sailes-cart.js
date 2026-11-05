/*
 * SAILES add-to-cart for Shopify themes. The SAILES widget fires a cancelable `sailes:add-to-cart`
 * event; we add the product with the Ajax Cart API and keep the conversation id on the cart so the
 * order can be credited to the chat. Products with several variants open the product page instead.
 */
(function () {
  if (window.__sailesCart) return;
  window.__sailesCart = true;
  var cfg = window.SAILES_SHOPIFY || {};
  var root = (cfg.root || '/').replace(/\/?$/, '/');

  function variantFrom(url) {
    if (!url) return null;
    try {
      var id = new URL(url, location.href).searchParams.get('id');
      return id && /^\d+$/.test(id) ? Number(id) : null;
    } catch (e) {
      return null;
    }
  }

  function post(path, body) {
    return fetch(root + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      if (!r.ok) throw new Error('cart ' + r.status);
      return r.json();
    });
  }

  function refreshCartUi() {
    // Common theme hooks (Dawn and most Online Store 2.0 themes), then a generic event.
    fetch(root + 'cart.js', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (cart) {
        document.querySelectorAll('.cart-count-bubble span[aria-hidden="true"], [data-cart-count]').forEach(function (el) {
          el.textContent = String(cart.item_count);
        });
        document.dispatchEvent(new CustomEvent('cart:refresh', { detail: cart }));
        document.documentElement.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true, detail: cart }));
      })
      .catch(function () {});
  }

  window.addEventListener('sailes:add-to-cart', function (e) {
    var d = e.detail || {};
    var variantId = variantFrom(d.addToCartUrl);
    if (!variantId) {
      // Several variants: the shopper picks size or color on the product page.
      if (d.url) {
        e.preventDefault();
        location.href = d.url;
      }
      return;
    }
    e.preventDefault();
    var conv = d.conversationId || null;
    var item = { id: variantId, quantity: 1 };
    if (conv) item.properties = { _sailes_conversation: conv };
    post('cart/add.js', { items: [item] })
      .then(function () {
        return conv ? post('cart/update.js', { attributes: { _sailes_conversation: conv } }) : null;
      })
      .then(function () {
        window.dispatchEvent(new CustomEvent('sailes:added-to-cart', { detail: d }));
        if (cfg.afterAdd === 'cart') location.href = root + 'cart';
        else refreshCartUi();
      })
      .catch(function () {
        location.href = d.addToCartUrl || d.url;
      });
  });
})();
