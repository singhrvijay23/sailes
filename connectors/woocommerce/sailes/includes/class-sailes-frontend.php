<?php
/**
 * Storefront (connector contract sections 4 and 5): the widget script tag, the [sailes_chat]
 * shortcode for an inline chat, and real add-to-cart from the assistant's product cards.
 *
 * @package Sailes
 */

defined( 'ABSPATH' ) || exit;

/**
 * Storefront integration.
 */
class Sailes_Frontend {

	const HANDLE = 'sailes-widget';

	/** Set when [sailes_chat] rendered on this page, so the widget opens inline there. */
	private static $inline_target = '';

	/**
	 * Register hooks.
	 */
	public static function init() {
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
		add_filter( 'script_loader_tag', array( __CLASS__, 'script_tag' ), 10, 2 );
		add_shortcode( 'sailes_chat', array( __CLASS__, 'shortcode' ) );
		add_action( 'wc_ajax_sailes_add_to_cart', array( __CLASS__, 'add_to_cart' ) );
	}

	/**
	 * Whether the assistant should load on this request.
	 *
	 * @return bool
	 */
	public static function should_show() {
		$c = Sailes_Settings::connection();
		$show = $c && empty( $c['invalid'] ) && ! empty( $c['widget_key'] ) && ! empty( $c['widget_script_url'] ) && Sailes_Settings::settings()['widget_enabled'];
		/**
		 * Filter whether the SAILES assistant appears on the current page.
		 *
		 * @param bool $show Default decision.
		 */
		return (bool) apply_filters( 'sailes_show_widget', $show );
	}

	/**
	 * Enqueue the widget and the add-to-cart bridge.
	 */
	public static function enqueue() {
		if ( ! self::should_show() ) {
			return;
		}
		$c = Sailes_Settings::connection();
		wp_enqueue_script( self::HANDLE, $c['widget_script_url'], array(), null, array( 'in_footer' => true, 'strategy' => 'async' ) ); // phpcs:ignore WordPress.WP.EnqueuedResourceParameters.MissingVersion -- SAILES versions the widget itself.
		wp_enqueue_script( 'sailes-cart', SAILES_PLUGIN_URL . 'assets/sailes-cart.js', array(), SAILES_VERSION, array( 'in_footer' => true, 'strategy' => 'defer' ) );
		wp_localize_script(
			'sailes-cart',
			'sailesCart',
			array(
				'endpoint' => WC_AJAX::get_endpoint( 'sailes_add_to_cart' ),
				'cookie'   => Sailes_Orders::COOKIE,
				'cartUrl'  => wc_get_cart_url(),
				'i18n'     => array(
					'added'    => __( 'Added to your cart', 'sailes' ),
					'viewCart' => __( 'View cart', 'sailes' ),
				),
			)
		);
	}

	/**
	 * Add the widget key (and inline mode) to the widget's script tag.
	 *
	 * @param string $tag    Script HTML.
	 * @param string $handle Handle.
	 * @return string
	 */
	public static function script_tag( $tag, $handle ) {
		if ( self::HANDLE !== $handle ) {
			return $tag;
		}
		$c     = Sailes_Settings::connection();
		$attrs = ' data-sailes-key="' . esc_attr( $c ? $c['widget_key'] : '' ) . '"';
		if ( self::$inline_target ) {
			$attrs .= ' data-mode="inline" data-target="' . esc_attr( self::$inline_target ) . '"';
		}
		return str_replace( ' src=', $attrs . ' src=', $tag );
	}

	/**
	 * [sailes_chat] renders the assistant inside the page instead of the floating bubble.
	 *
	 * @param array|string $atts Attributes: height (CSS length, default 600px).
	 * @return string
	 */
	public static function shortcode( $atts ) {
		if ( ! self::should_show() ) {
			return '';
		}
		$atts   = shortcode_atts( array( 'height' => '600px' ), $atts, 'sailes_chat' );
		$height = preg_match( '/^\d{2,4}(px|vh|rem|em)$/', $atts['height'] ) ? $atts['height'] : '600px';
		if ( self::$inline_target ) {
			return ''; // One assistant per page.
		}
		self::$inline_target = '#sailes-chat';
		return '<div id="sailes-chat" class="sailes-chat-inline" style="min-height:' . esc_attr( $height ) . '"></div>';
	}

	/**
	 * The widget's add-to-cart event, forwarded by assets/sailes-cart.js. Simple products go
	 * straight into the cart; products that need a choice (size, color) open their page.
	 */
	public static function add_to_cart() {
		// phpcs:disable WordPress.Security.NonceVerification.Missing -- public cart action, like WooCommerce's own wc-ajax=add_to_cart.
		$product_id = isset( $_POST['product_id'] ) ? absint( $_POST['product_id'] ) : 0;
		// phpcs:enable
		$product = $product_id ? wc_get_product( $product_id ) : null;
		if ( ! $product || ! Sailes_Product_Mapper::is_syncable( $product ) ) {
			wp_send_json( array( 'added' => false, 'redirect' => null ), 404 );
		}
		$redirect = get_permalink( $product_id );
		if ( ! $product->is_type( 'simple' ) || ! $product->is_purchasable() || ! $product->is_in_stock() ) {
			wp_send_json( array( 'added' => false, 'redirect' => $redirect ) );
		}
		$passed = apply_filters( 'woocommerce_add_to_cart_validation', true, $product_id, 1 );
		$key    = $passed ? WC()->cart->add_to_cart( $product_id, 1 ) : false;
		if ( ! $key ) {
			$notices = wc_get_notices( 'error' );
			wc_clear_notices();
			$message = $notices ? wp_strip_all_tags( is_array( $notices[0] ) ? $notices[0]['notice'] : $notices[0] ) : '';
			wp_send_json( array( 'added' => false, 'redirect' => $redirect, 'message' => $message ) );
		}
		do_action( 'woocommerce_ajax_added_to_cart', $product_id );
		wp_send_json(
			array(
				'added'     => true,
				'cartUrl'   => wc_get_cart_url(),
				'cartCount' => WC()->cart->get_cart_contents_count(),
			)
		);
	}
}
