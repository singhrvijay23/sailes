<?php
/**
 * Catalog sync (connector contract section 2): full sync on connect, changes as they happen,
 * and a nightly resync that catches anything missed. Runs in the background with Action Scheduler,
 * which ships with WooCommerce.
 *
 * @package Sailes
 */

defined( 'ABSPATH' ) || exit;

/**
 * Background catalog sync.
 */
class Sailes_Sync {

	const GROUP      = 'sailes';
	const PAGE_SIZE  = 250;
	const DIRTY      = 'sailes_dirty_products';
	const MAX_DIRTY  = 2000;
	const DEBOUNCE   = 10;
	const RETRY_WAIT = 5 * MINUTE_IN_SECONDS;
	const MAX_TRIES  = 6;

	/**
	 * Register hooks.
	 */
	public static function init() {
		add_action( 'sailes_full_sync_page', array( __CLASS__, 'full_sync_page' ), 10, 2 );
		add_action( 'sailes_nightly_sync', array( __CLASS__, 'nightly' ) );
		add_action( 'sailes_flush_changes', array( __CLASS__, 'flush_changes' ) );

		// Product changes.
		add_action( 'woocommerce_new_product', array( __CLASS__, 'mark_dirty' ) );
		add_action( 'woocommerce_update_product', array( __CLASS__, 'mark_dirty' ) );
		add_action( 'woocommerce_new_product_variation', array( __CLASS__, 'mark_variation_dirty' ) );
		add_action( 'woocommerce_update_product_variation', array( __CLASS__, 'mark_variation_dirty' ) );
		add_action( 'woocommerce_product_set_stock_status', array( __CLASS__, 'mark_dirty' ) );
		add_action( 'woocommerce_variation_set_stock_status', array( __CLASS__, 'mark_variation_dirty' ) );
		add_action( 'woocommerce_product_set_stock', array( __CLASS__, 'mark_product_object_dirty' ) );
		add_action( 'woocommerce_variation_set_stock', array( __CLASS__, 'mark_product_object_dirty' ) );
		// Trash, restore, delete, unpublish.
		add_action( 'trashed_post', array( __CLASS__, 'mark_post_dirty' ) );
		add_action( 'untrashed_post', array( __CLASS__, 'mark_post_dirty' ) );
		add_action( 'before_delete_post', array( __CLASS__, 'mark_post_dirty' ) );
		add_action( 'transition_post_status', array( __CLASS__, 'on_status_change' ), 10, 3 );
	}

	/* ---------------------------------------------------------------- Full sync */

	/**
	 * Start (or restart) a full sync in pages.
	 */
	public static function start_full_sync() {
		if ( ! Sailes_Settings::is_connected() ) {
			return;
		}
		as_unschedule_all_actions( 'sailes_full_sync_page', null, self::GROUP );
		Sailes_Settings::update_sync_status(
			array(
				'state'       => 'running',
				'sent'        => 0,
				'removed'     => 0,
				'rejected'    => 0,
				'started_at'  => time(),
				'finished_at' => 0,
				'last_error'  => '',
			)
		);
		as_enqueue_async_action( 'sailes_full_sync_page', array( 1, 0 ), self::GROUP );
	}

	/**
	 * One page of the full sync.
	 *
	 * @param int $page    Page number, from 1.
	 * @param int $attempt Retry count for this page.
	 */
	public static function full_sync_page( $page, $attempt = 0 ) {
		if ( ! Sailes_Settings::is_connected() ) {
			return;
		}
		$page = max( 1, (int) $page );
		$ids  = wc_get_products(
			array(
				'status'  => 'publish',
				'type'    => Sailes_Product_Mapper::syncable_types(),
				'limit'   => self::PAGE_SIZE,
				'page'    => $page,
				'orderby' => 'ID',
				'order'   => 'ASC',
				'return'  => 'ids',
			)
		);
		$result = self::push( $ids );
		if ( is_wp_error( $result ) ) {
			self::handle_page_error( $result, $page, (int) $attempt );
			return;
		}
		$status = Sailes_Settings::sync_status();
		Sailes_Settings::update_sync_status(
			array(
				'sent'     => $status['sent'] + $result['sent'],
				'removed'  => $status['removed'] + $result['removed'],
				'rejected' => $status['rejected'] + $result['rejected'],
			)
		);

		if ( count( $ids ) === self::PAGE_SIZE ) {
			as_enqueue_async_action( 'sailes_full_sync_page', array( $page + 1, 0 ), self::GROUP );
			return;
		}

		// Last page: remove products that are no longer published.
		$gone    = wc_get_products(
			array(
				'status' => array( 'draft', 'pending', 'private', 'trash' ),
				'type'   => Sailes_Product_Mapper::syncable_types(),
				'limit'  => -1,
				'return' => 'ids',
			)
		);
		$removed = 0;
		foreach ( array_chunk( array_map( 'strval', $gone ), 1000 ) as $chunk ) {
			$res = Sailes_Client::request( 'POST', '/v1/stores/{store}/catalog/products/delete', array( 'ids' => $chunk ), array( 'retries' => Sailes_Client::BACKGROUND_RETRIES ) );
			if ( ! is_wp_error( $res ) ) {
				$removed += (int) ( $res['deleted'] ?? 0 );
			}
		}
		$status = Sailes_Settings::sync_status();
		Sailes_Settings::update_sync_status(
			array(
				'state'       => 'done',
				'removed'     => $status['removed'] + $removed,
				'finished_at' => time(),
				'last_error'  => '',
			)
		);
	}

	/**
	 * Retry a failed page later, or stop on errors that need the merchant.
	 *
	 * @param WP_Error $error   Error.
	 * @param int      $page    Page.
	 * @param int      $attempt Attempt.
	 */
	private static function handle_page_error( WP_Error $error, $page, $attempt ) {
		$data   = (array) $error->get_error_data();
		$status = (int) ( $data['status'] ?? 0 );
		$fatal  = in_array( $status, array( 401, 402, 403 ), true ) || ( $status >= 400 && $status < 500 && 429 !== $status );
		if ( ! $fatal && $attempt + 1 < self::MAX_TRIES ) {
			as_schedule_single_action( time() + self::RETRY_WAIT, 'sailes_full_sync_page', array( $page, $attempt + 1 ), self::GROUP );
			Sailes_Settings::update_sync_status( array( 'last_error' => $error->get_error_message(), 'last_error_at' => time() ) );
			return;
		}
		Sailes_Settings::update_sync_status(
			array(
				'state'         => 402 === $status ? 'limit' : 'failed',
				'last_error'    => $error->get_error_message(),
				'last_error_at' => time(),
				'finished_at'   => time(),
			)
		);
	}

	/**
	 * Nightly resync, unless one is already running.
	 */
	public static function nightly() {
		$status = Sailes_Settings::sync_status();
		if ( 'running' === $status['state'] && $status['started_at'] > time() - 6 * HOUR_IN_SECONDS ) {
			return;
		}
		self::start_full_sync();
	}

	/**
	 * Schedule the nightly resync at a random minute between 2 and 4 am site time.
	 */
	public static function schedule_nightly() {
		if ( as_next_scheduled_action( 'sailes_nightly_sync', array(), self::GROUP ) ) {
			return;
		}
		$tz    = wp_timezone();
		$first = new DateTime( 'tomorrow', $tz );
		$first->setTime( 2, wp_rand( 0, 119 ) );
		as_schedule_recurring_action( $first->getTimestamp(), DAY_IN_SECONDS, 'sailes_nightly_sync', array(), self::GROUP );
	}

	/**
	 * Remove all SAILES background jobs (disconnect, deactivate, uninstall).
	 */
	public static function unschedule_all() {
		if ( function_exists( 'as_unschedule_all_actions' ) ) {
			foreach ( array( 'sailes_full_sync_page', 'sailes_nightly_sync', 'sailes_flush_changes', 'sailes_push_policies', 'sailes_report_order' ) as $hook ) {
				as_unschedule_all_actions( $hook, null, self::GROUP );
			}
		}
		delete_option( self::DIRTY );
	}

	/* ---------------------------------------------------------------- Changes */

	/**
	 * A product changed. Changes are collected for a few seconds and sent together.
	 *
	 * @param int|mixed $product_id Product id.
	 */
	public static function mark_dirty( $product_id ) {
		$product_id = absint( $product_id );
		if ( ! $product_id || ! Sailes_Settings::is_connected() ) {
			return;
		}
		$dirty = self::dirty();
		if ( count( $dirty ) >= self::MAX_DIRTY ) {
			// A bulk edit or import: one full sync is cheaper than thousands of single updates.
			delete_option( self::DIRTY );
			self::start_full_sync();
			return;
		}
		$dirty[ $product_id ] = 1;
		update_option( self::DIRTY, $dirty, false );
		if ( ! self::has_pending( 'sailes_flush_changes' ) ) {
			as_schedule_single_action( time() + self::DEBOUNCE, 'sailes_flush_changes', array(), self::GROUP );
		}
	}

	/**
	 * A variation changed: resend its parent.
	 *
	 * @param int $variation_id Variation id.
	 */
	public static function mark_variation_dirty( $variation_id ) {
		$parent = wp_get_post_parent_id( absint( $variation_id ) );
		if ( $parent ) {
			self::mark_dirty( $parent );
		}
	}

	/**
	 * Stock hooks pass the product object.
	 *
	 * @param WC_Product $product Product or variation.
	 */
	public static function mark_product_object_dirty( $product ) {
		if ( $product instanceof WC_Product ) {
			self::mark_dirty( $product->get_parent_id() ? $product->get_parent_id() : $product->get_id() );
		}
	}

	/**
	 * Trash, restore or delete of a product or variation.
	 *
	 * @param int $post_id Post id.
	 */
	public static function mark_post_dirty( $post_id ) {
		$type = get_post_type( $post_id );
		if ( 'product' === $type ) {
			self::mark_dirty( $post_id );
		} elseif ( 'product_variation' === $type ) {
			self::mark_variation_dirty( $post_id );
		}
	}

	/**
	 * Publish, unpublish or schedule a product.
	 *
	 * @param string  $new  New status.
	 * @param string  $old  Old status.
	 * @param WP_Post $post Post.
	 */
	public static function on_status_change( $new, $old, $post ) {
		if ( $new !== $old && $post instanceof WP_Post && 'product' === $post->post_type ) {
			self::mark_dirty( $post->ID );
		}
	}

	/**
	 * Send collected changes: upsert what is still sellable, delete the rest.
	 */
	public static function flush_changes() {
		$ids = array_keys( self::dirty() );
		delete_option( self::DIRTY );
		if ( ! $ids || ! Sailes_Settings::is_connected() ) {
			return;
		}
		$result = self::push( $ids );
		if ( is_wp_error( $result ) ) {
			$data   = (array) $result->get_error_data();
			$status = (int) ( $data['status'] ?? 0 );
			Sailes_Settings::update_sync_status( array( 'last_error' => $result->get_error_message(), 'last_error_at' => time() ) );
			if ( 0 === $status || 429 === $status || $status >= 500 ) {
				// Put them back and try again later.
				$dirty = self::dirty();
				foreach ( $ids as $id ) {
					$dirty[ $id ] = 1;
				}
				update_option( self::DIRTY, $dirty, false );
				as_schedule_single_action( time() + self::RETRY_WAIT, 'sailes_flush_changes', array(), self::GROUP );
			}
			return;
		}
		Sailes_Settings::update_sync_status( array( 'last_change_at' => time() ) );
		if ( self::dirty() && ! self::has_pending( 'sailes_flush_changes' ) ) {
			as_schedule_single_action( time() + self::DEBOUNCE, 'sailes_flush_changes', array(), self::GROUP );
		}
	}

	/* ---------------------------------------------------------------- Shared */

	/**
	 * Upsert sellable products and delete the others.
	 *
	 * @param int[] $ids Product ids.
	 * @return array{sent:int,removed:int,rejected:int}|WP_Error
	 */
	public static function push( array $ids ) {
		$products = array();
		$remove   = array();
		foreach ( $ids as $id ) {
			$product = wc_get_product( $id );
			if ( Sailes_Product_Mapper::is_syncable( $product ) ) {
				$products[] = Sailes_Product_Mapper::map( $product );
			} elseif ( ! $product || in_array( $product->get_type(), Sailes_Product_Mapper::syncable_types(), true ) ) {
				// Deleted, unpublished or hidden. Variations and other types were never sent.
				$remove[] = (string) $id;
			}
		}
		$out = array( 'sent' => 0, 'removed' => 0, 'rejected' => 0 );
		$opt = array( 'retries' => Sailes_Client::BACKGROUND_RETRIES );
		if ( $products ) {
			$res = Sailes_Client::request( 'PUT', '/v1/stores/{store}/catalog/products', array( 'products' => $products ), $opt );
			if ( is_wp_error( $res ) ) {
				return $res;
			}
			$out['sent']     = count( $products );
			$out['rejected'] = (int) ( $res['rejected'] ?? 0 );
			if ( ! empty( $res['errors'] ) ) {
				Sailes_Settings::update_sync_status( array( 'rejected_samples' => array_slice( (array) $res['errors'], 0, 5 ) ) );
			}
		}
		if ( $remove ) {
			$res = Sailes_Client::request( 'POST', '/v1/stores/{store}/catalog/products/delete', array( 'ids' => $remove ), $opt );
			if ( is_wp_error( $res ) ) {
				return $res;
			}
			$out['removed'] = (int) ( $res['deleted'] ?? 0 );
		}
		return $out;
	}

	/**
	 * Pending changed-product ids.
	 *
	 * @return array<int,int>
	 */
	private static function dirty() {
		$d = get_option( self::DIRTY );
		return is_array( $d ) ? $d : array();
	}

	/**
	 * Whether a job is waiting to run (a running job does not count).
	 *
	 * @param string $hook Hook.
	 * @return bool
	 */
	public static function has_pending( $hook ) {
		return (bool) as_get_scheduled_actions(
			array(
				'hook'     => $hook,
				'group'    => self::GROUP,
				'status'   => ActionScheduler_Store::STATUS_PENDING,
				'per_page' => 1,
			),
			'ids'
		);
	}
}
