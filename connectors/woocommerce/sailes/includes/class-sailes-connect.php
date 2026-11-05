<?php
/**
 * Install flow (connector contract section 1): send the merchant to the SAILES console, then
 * exchange the one-time code for the connector key on this server.
 *
 * @package Sailes
 */

defined( 'ABSPATH' ) || exit;

/**
 * Connect, callback and disconnect handlers.
 */
class Sailes_Connect {

	const STATE_TTL = 15 * MINUTE_IN_SECONDS;

	/**
	 * Register handlers.
	 */
	public static function init() {
		add_action( 'admin_post_sailes_connect', array( __CLASS__, 'start' ) );
		add_action( 'admin_post_sailes_callback', array( __CLASS__, 'callback' ) );
		add_action( 'admin_post_sailes_disconnect', array( __CLASS__, 'disconnect' ) );
	}

	/**
	 * Where SAILES sends the merchant back to.
	 *
	 * @return string
	 */
	public static function redirect_uri() {
		return admin_url( 'admin-post.php?action=sailes_callback' );
	}

	/**
	 * The console URL that starts the connection.
	 *
	 * @param string $state CSRF state.
	 * @return string
	 */
	public static function connect_url( $state ) {
		return add_query_arg(
			array(
				'platform'     => 'woocommerce',
				'shop'         => rawurlencode( Sailes_Settings::shop_origin() ),
				'redirect_uri' => rawurlencode( self::redirect_uri() ),
				'state'        => rawurlencode( $state ),
			),
			untrailingslashit( SAILES_CONSOLE_URL ) . '/connect'
		);
	}

	/**
	 * Step 1: the merchant clicked "Connect to SAILES".
	 */
	public static function start() {
		self::guard( 'sailes_connect' );
		$state = wp_generate_password( 32, false, false );
		set_transient( self::state_key(), $state, self::STATE_TTL );
		wp_redirect( self::connect_url( $state ) ); // phpcs:ignore WordPress.Security.SafeRedirect.wp_redirect_wp_redirect -- the SAILES console is a different host.
		exit;
	}

	/**
	 * Step 3: SAILES sent the merchant back with ?code=cc_...&state=...
	 */
	public static function callback() {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'You do not have permission to connect this store.', 'sailes' ), 403 );
		}
		// phpcs:disable WordPress.Security.NonceVerification.Recommended -- the state parameter is the CSRF check here.
		$state = isset( $_GET['state'] ) ? sanitize_text_field( wp_unslash( $_GET['state'] ) ) : '';
		$code  = isset( $_GET['code'] ) ? sanitize_text_field( wp_unslash( $_GET['code'] ) ) : '';
		// phpcs:enable
		$expected = get_transient( self::state_key() );
		delete_transient( self::state_key() );

		if ( ! is_string( $expected ) || '' === $state || ! hash_equals( $expected, $state ) ) {
			Sailes_Admin::redirect_with_notice( 'error', __( 'The connection request expired or did not come from this site. Click "Connect to SAILES" again.', 'sailes' ) );
		}
		if ( '' === $code ) {
			Sailes_Admin::redirect_with_notice( 'error', __( 'SAILES did not return a connection code. Click "Connect to SAILES" again.', 'sailes' ) );
		}

		$creds = Sailes_Client::request( 'POST', '/v1/connect/exchange', array( 'code' => $code ), array( 'auth' => false, 'base' => SAILES_API_URL, 'retries' => 2 ) );
		if ( is_wp_error( $creds ) ) {
			Sailes_Admin::redirect_with_notice( 'error', $creds->get_error_message() );
		}
		if ( empty( $creds['storeId'] ) || empty( $creds['apiKey'] ) || empty( $creds['apiUrl'] ) ) {
			Sailes_Admin::redirect_with_notice( 'error', __( 'SAILES returned an incomplete response. Try connecting again.', 'sailes' ) );
		}

		Sailes_Settings::save_connection( $creds, Sailes_Settings::shop_origin() );
		Sailes_Sync::start_full_sync();
		Sailes_Sync::schedule_nightly();
		Sailes_Policies::schedule_push();
		Sailes_Admin::redirect_with_notice( 'success', __( 'Connected to SAILES. Your products are syncing in the background.', 'sailes' ) );
	}

	/**
	 * Disconnect: revoke the key at SAILES and forget it here. Catalog data stays in SAILES.
	 */
	public static function disconnect() {
		self::guard( 'sailes_disconnect' );
		self::revoke_and_forget();
		Sailes_Admin::redirect_with_notice( 'success', __( 'Disconnected. The assistant no longer appears on your store.', 'sailes' ) );
	}

	/**
	 * Revoke the key (best effort) and clear local state. Used by disconnect and uninstall.
	 */
	public static function revoke_and_forget() {
		if ( Sailes_Settings::is_connected() ) {
			Sailes_Client::request( 'POST', '/v1/connector/disconnect', null, array( 'timeout' => 10 ) );
		}
		Sailes_Sync::unschedule_all();
		Sailes_Settings::clear_connection();
	}

	/**
	 * Capability and nonce check for admin-post actions.
	 *
	 * @param string $action Nonce action.
	 */
	private static function guard( $action ) {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'You do not have permission to change SAILES settings.', 'sailes' ), 403 );
		}
		check_admin_referer( $action );
	}

	/**
	 * Per-user transient for the CSRF state.
	 *
	 * @return string
	 */
	private static function state_key() {
		return 'sailes_state_' . get_current_user_id();
	}
}
