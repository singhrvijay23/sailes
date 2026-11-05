<?php
/**
 * Stored plugin state: the connection, merchant settings and sync status.
 *
 * @package Sailes
 */

defined( 'ABSPATH' ) || exit;

/**
 * Option access in one place.
 */
class Sailes_Settings {

	const CONNECTION = 'sailes_connection';
	const SETTINGS   = 'sailes_settings';
	const SYNC       = 'sailes_sync_status';
	const STORE      = 'sailes_store_cache';

	/** Policy topics the assistant looks for (connector contract section 3). */
	const POLICY_TOPICS = array( 'shipping', 'returns', 'warranty', 'payment', 'contact' );

	/**
	 * The saved connection, or null when not connected.
	 *
	 * @return array{store_id:string,api_key:string,widget_key:string,api_url:string,widget_script_url:string,shop_url:string,connected_at:int}|null
	 */
	public static function connection() {
		$c = get_option( self::CONNECTION );
		return is_array( $c ) && ! empty( $c['store_id'] ) ? $c : null;
	}

	/**
	 * True when this site holds a connector key.
	 *
	 * @return bool
	 */
	public static function is_connected() {
		return null !== self::connection();
	}

	/**
	 * Save the credentials from the code exchange. The secret key is encrypted before it is stored.
	 *
	 * @param array $creds Exchange response.
	 * @param string $shop_url Shop origin sent to SAILES.
	 */
	public static function save_connection( array $creds, $shop_url ) {
		update_option(
			self::CONNECTION,
			array(
				'store_id'          => (string) $creds['storeId'],
				'api_key'           => Sailes_Crypto::encrypt( (string) $creds['apiKey'] ),
				'widget_key'        => (string) ( $creds['widgetKey'] ?? '' ),
				'api_url'           => untrailingslashit( (string) $creds['apiUrl'] ),
				'widget_script_url' => (string) $creds['widgetScriptUrl'],
				'shop_url'          => (string) $shop_url,
				'connected_at'      => time(),
			),
			false
		);
		delete_option( self::STORE );
	}

	/**
	 * Forget the connection (after disconnect or a revoked key).
	 */
	public static function clear_connection() {
		delete_option( self::CONNECTION );
		delete_option( self::STORE );
		delete_option( self::SYNC );
	}

	/**
	 * The decrypted connector key, or null.
	 *
	 * @return string|null
	 */
	public static function api_key() {
		$c = self::connection();
		return $c ? Sailes_Crypto::decrypt( $c['api_key'] ) : null;
	}

	/**
	 * Merchant settings with defaults.
	 *
	 * @return array{widget_enabled:bool,policy_pages:array<string,int>}
	 */
	public static function settings() {
		$s = get_option( self::SETTINGS );
		$s = is_array( $s ) ? $s : array();
		$pages = isset( $s['policy_pages'] ) && is_array( $s['policy_pages'] ) ? $s['policy_pages'] : self::default_policy_pages();
		return array(
			'widget_enabled' => isset( $s['widget_enabled'] ) ? (bool) $s['widget_enabled'] : true,
			'policy_pages'   => array_map( 'absint', array_intersect_key( $pages, array_flip( self::POLICY_TOPICS ) ) ),
		);
	}

	/**
	 * Save merchant settings.
	 *
	 * @param array $s Settings.
	 */
	public static function save_settings( array $s ) {
		update_option( self::SETTINGS, array_merge( self::settings(), $s ), false );
	}

	/**
	 * WooCommerce creates a "Refund and Returns Policy" page on install; use it until the merchant picks.
	 *
	 * @return array<string,int>
	 */
	private static function default_policy_pages() {
		$returns = (int) get_option( 'woocommerce_refund_returns_page_id', 0 );
		return array( 'returns' => $returns > 0 && 'publish' === get_post_status( $returns ) ? $returns : 0 );
	}

	/**
	 * Sync progress shown on the settings page.
	 *
	 * @return array
	 */
	public static function sync_status() {
		$s = get_option( self::SYNC );
		return wp_parse_args(
			is_array( $s ) ? $s : array(),
			array(
				'state'         => 'idle',
				'sent'          => 0,
				'removed'       => 0,
				'rejected'      => 0,
				'started_at'    => 0,
				'finished_at'   => 0,
				'last_error'    => '',
				'last_error_at' => 0,
			)
		);
	}

	/**
	 * Merge into the sync status.
	 *
	 * @param array $changes Fields to change.
	 */
	public static function update_sync_status( array $changes ) {
		update_option( self::SYNC, array_merge( self::sync_status(), $changes ), false );
	}

	/**
	 * The storefront origin sent to SAILES (scheme, host and port only).
	 *
	 * @return string
	 */
	public static function shop_origin() {
		$parts  = wp_parse_url( home_url() );
		$origin = ( $parts['scheme'] ?? 'https' ) . '://' . ( $parts['host'] ?? '' );
		if ( ! empty( $parts['port'] ) ) {
			$origin .= ':' . $parts['port'];
		}
		return $origin;
	}
}
