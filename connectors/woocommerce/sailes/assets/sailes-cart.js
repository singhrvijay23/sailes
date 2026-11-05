/**
 * SAILES add-to-cart bridge for WooCommerce.
 *
 * The SAILES widget dispatches a cancelable "sailes:add-to-cart" event when a shopper clicks
 * "Add to cart" on a product card. This adds simple products to the real WooCommerce cart,
 * refreshes the mini cart (classic and block themes) and remembers the conversation so the
 * order can be attributed to the assistant. Products that need a choice open their page.
 */
( function () {
	'use strict';
	var cfg = window.sailesCart;
	if ( ! cfg ) {
		return;
	}
	var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

	function remember( conversationId ) {
		if ( conversationId && UUID.test( conversationId ) ) {
			var secure = location.protocol === 'https:' ? '; Secure' : '';
			document.cookie = cfg.cookie + '=' + conversationId + '; Max-Age=' + 60 * 60 * 24 * 30 + '; Path=/; SameSite=Lax' + secure;
		}
	}

	function refreshCart( productId ) {
		var $ = window.jQuery;
		if ( $ ) {
			$( document.body ).trigger( 'wc_fragment_refresh' );
			$( document.body ).trigger( 'added_to_cart', [ {}, '', null ] );
		}
		// Mini-Cart block listens for this.
		document.body.dispatchEvent( new CustomEvent( 'wc-blocks_added_to_cart', { bubbles: true, cancelable: true, detail: { preserveCartData: false } } ) );
		if ( window.wp && window.wp.data && window.wp.data.dispatch ) {
			try {
				var store = window.wp.data.dispatch( 'wc/store/cart' );
				if ( store && store.invalidateResolutionForStore ) {
					store.invalidateResolutionForStore();
				}
			} catch ( e ) {}
		}
	}

	var toastEl;
	function toast( text, href, linkText ) {
		if ( ! toastEl ) {
			toastEl = document.createElement( 'div' );
			toastEl.setAttribute( 'role', 'status' );
			toastEl.setAttribute( 'aria-live', 'polite' );
			toastEl.style.cssText =
				'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483646;background:#1B2A4A;color:#fff;' +
				'padding:10px 16px;border-radius:8px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2);max-width:calc(100vw - 32px)';
			document.body.appendChild( toastEl );
		}
		toastEl.textContent = text;
		if ( href ) {
			var a = document.createElement( 'a' );
			a.href = href;
			a.textContent = linkText;
			a.style.cssText = 'color:#fff;text-decoration:underline;margin-left:12px';
			toastEl.appendChild( a );
		}
		toastEl.style.display = 'block';
		clearTimeout( toastEl._t );
		toastEl._t = setTimeout( function () {
			toastEl.style.display = 'none';
		}, 5000 );
	}

	window.addEventListener( 'sailes:add-to-cart', function ( e ) {
		var d = e.detail || {};
		remember( d.conversationId );
		if ( ! d.productId || ! /^\d+$/.test( String( d.productId ) ) ) {
			return; // Not a WooCommerce id: let the widget follow its link.
		}
		e.preventDefault();
		var fallback = d.url || d.addToCartUrl;
		var body = new URLSearchParams();
		body.set( 'product_id', String( d.productId ) );
		fetch( cfg.endpoint, { method: 'POST', credentials: 'same-origin', body: body } )
			.then( function ( r ) {
				return r.json();
			} )
			.then( function ( res ) {
				if ( res && res.added ) {
					refreshCart( d.productId );
					toast( cfg.i18n.added, res.cartUrl || cfg.cartUrl, cfg.i18n.viewCart );
				} else {
					var to = ( res && res.redirect ) || fallback;
					if ( to ) {
						location.href = to;
					}
				}
			} )
			.catch( function () {
				if ( fallback ) {
					location.href = fallback;
				}
			} );
	} );
} )();
