<?php
/**
 * Order reporting (connector contract section 5). Every paid order is reported, with the SAILES
 * conversation id when the shopper used the assistant, so analytics can show revenue from chat.
 *
 * @package Sailes
 */

defined( 'ABSPATH' ) || exit;

/**
 * Conversation attribution and order reports.
 */
class Sailes_Orders {

	/** Set by the storefront script when a shopper adds to cart from the assistant. */
	const COOKIE = 'sailes_conversation';
	const META   = '_sailes_conversation_id';
	const SENT   = '_sailes_reported';

	/**
	 * Register hooks.
	 */
	public static function init() {
		add_action( 'woocommerce_checkout_create_order', array( __CLASS__, 'attach_conversation' ) );
		add_action( 'woocommerce_store_api_checkout_update_order_from_request', array( __CLASS__, 'attach_conversation' ) );
		add_action( 'woocommerce_order_status_changed', array( __CLASS__, 'on_status_changed' ), 10, 4 );
		add_action( 'sailes_report_order', array( __CLASS__, 'report' ), 10, 2 );
	}

	/**
	 * The conversation id from the cookie, if it is a valid UUID.
	 *
	 * @return string|null
	 */
	public static function conversation_from_cookie() {
		$raw = isset( $_COOKIE[ self::COOKIE ] ) ? sanitize_text_field( wp_unslash( $_COOKIE[ self::COOKIE ] ) ) : '';
		return wp_is_uuid( $raw ) ? strtolower( $raw ) : null;
	}

	/**
	 * Save the conversation id on the new order (classic and block checkout).
	 *
	 * @param WC_Order $order Order being created.
	 */
	public static function attach_conversation( $order ) {
		$conversation = self::conversation_from_cookie();
		if ( $conversation && $order instanceof WC_Order ) {
			$order->update_meta_data( self::META, $conversation );
		}
	}

	/**
	 * Report orders once they are paid.
	 *
	 * @param int      $order_id Order id.
	 * @param string   $from     Old status.
	 * @param string   $to       New status.
	 * @param WC_Order $order    Order.
	 */
	public static function on_status_changed( $order_id, $from, $to, $order ) {
		if ( ! Sailes_Settings::is_connected() || ! in_array( $to, wc_get_is_paid_statuses(), true ) ) {
			return;
		}
		if ( $order instanceof WC_Order && ! $order->get_meta( self::SENT ) ) {
			as_enqueue_async_action( 'sailes_report_order', array( (int) $order_id, 0 ), Sailes_Sync::GROUP, true );
		}
	}

	/**
	 * The report sent to SAILES.
	 *
	 * @param WC_Order $order Order.
	 * @return array
	 */
	public static function payload( WC_Order $order ) {
		$product_ids = array();
		foreach ( $order->get_items() as $item ) {
			if ( $item instanceof WC_Order_Item_Product && $item->get_product_id() ) {
				$product_ids[] = (string) $item->get_product_id(); // Parent id, matching the synced catalog.
			}
		}
		$conversation = $order->get_meta( self::META );
		return array(
			'orderId'        => (string) $order->get_order_number(),
			'total'          => max( 0, (float) $order->get_total() ),
			'conversationId' => wp_is_uuid( $conversation ) ? $conversation : null,
			'productIds'     => array_slice( array_values( array_unique( $product_ids ) ), 0, 200 ),
		);
	}

	/**
	 * Send one order. SAILES records each order id once, so retries are safe.
	 *
	 * @param int $order_id Order id.
	 * @param int $attempt  Retry count.
	 */
	public static function report( $order_id, $attempt = 0 ) {
		$order = wc_get_order( $order_id );
		if ( ! $order || $order->get_meta( self::SENT ) || ! Sailes_Settings::is_connected() ) {
			return;
		}
		$res = Sailes_Client::request( 'POST', '/v1/stores/{store}/orders', self::payload( $order ), array( 'retries' => 2 ) );
		if ( is_wp_error( $res ) ) {
			$data   = (array) $res->get_error_data();
			$status = (int) ( $data['status'] ?? 0 );
			if ( ( 0 === $status || 429 === $status || $status >= 500 ) && $attempt < 5 ) {
				as_schedule_single_action( time() + ( 10 * MINUTE_IN_SECONDS ) * ( $attempt + 1 ), 'sailes_report_order', array( (int) $order_id, $attempt + 1 ), Sailes_Sync::GROUP );
			}
			return;
		}
		$order->update_meta_data( self::SENT, time() );
		$order->save_meta_data();
	}
}
