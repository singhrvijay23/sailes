<?php
/**
 * HTTP client for the SAILES API.
 *
 * @package Sailes
 */

defined( 'ABSPATH' ) || exit;

/**
 * Calls the SAILES API with the connector key. The key is only ever sent from this server.
 */
class Sailes_Client {

	/** Retries for background jobs, per the contract: 1s, 2s, 4s, 8s, 16s. */
	const BACKGROUND_RETRIES = 5;

	/**
	 * Send a request.
	 *
	 * @param string     $method  HTTP method.
	 * @param string     $path    Path starting with /v1/. "{store}" is replaced with the store id.
	 * @param array|null $body    JSON body.
	 * @param array      $opts    retries (int), auth (bool, default true), base (string, default the saved apiUrl), timeout (int).
	 * @return array|WP_Error Decoded JSON, or an error whose data holds the HTTP status.
	 */
	public static function request( $method, $path, $body = null, array $opts = array() ) {
		$retries = isset( $opts['retries'] ) ? (int) $opts['retries'] : 0;
		$auth    = isset( $opts['auth'] ) ? (bool) $opts['auth'] : true;
		$conn    = Sailes_Settings::connection();
		$base    = isset( $opts['base'] ) ? $opts['base'] : ( $conn ? $conn['api_url'] : SAILES_API_URL );

		$headers = array(
			'Accept'     => 'application/json',
			'User-Agent' => 'SAILES-WooCommerce/' . SAILES_VERSION . '; ' . home_url(),
		);
		if ( $auth ) {
			$key = Sailes_Settings::api_key();
			if ( ! $conn || ! $key ) {
				return new WP_Error( 'sailes_not_connected', __( 'This store is not connected to SAILES.', 'sailes' ), array( 'status' => 0 ) );
			}
			$headers['Authorization'] = 'Bearer ' . $key;
			$path                     = str_replace( '{store}', rawurlencode( $conn['store_id'] ), $path );
		}
		$args = array(
			'method'  => $method,
			'timeout' => isset( $opts['timeout'] ) ? (int) $opts['timeout'] : 30,
			'headers' => $headers,
		);
		if ( null === $body && 'GET' !== $method ) {
			$body = new stdClass(); // An empty JSON object; WordPress would otherwise send a form content type.
		}
		if ( null !== $body ) {
			$args['headers']['Content-Type'] = 'application/json';
			$args['body']                    = wp_json_encode( $body );
		}
		$url = untrailingslashit( $base ) . $path;

		for ( $attempt = 0; ; $attempt++ ) {
			$res   = wp_remote_request( $url, $args );
			$wait  = min( 16, 2 ** $attempt );
			$retry = false;
			if ( is_wp_error( $res ) ) {
				$error = new WP_Error( 'sailes_network', __( 'Could not reach SAILES. Try again in a minute.', 'sailes' ), array( 'status' => 0 ) );
				$retry = true;
			} else {
				$status = (int) wp_remote_retrieve_response_code( $res );
				$data   = json_decode( wp_remote_retrieve_body( $res ), true );
				if ( $status >= 200 && $status < 300 ) {
					return is_array( $data ) ? $data : array();
				}
				$code    = is_array( $data ) && ! empty( $data['error'] ) ? (string) $data['error'] : 'http_' . $status;
				$message = is_array( $data ) && ! empty( $data['message'] ) ? (string) $data['message'] : sprintf( /* translators: %d: HTTP status */ __( 'SAILES returned an error (%d).', 'sailes' ), $status );
				$error   = new WP_Error( 'sailes_' . $code, $message, array( 'status' => $status, 'code' => $code ) );
				if ( 401 === $status && $auth ) {
					self::mark_key_invalid();
				}
				if ( 429 === $status ) {
					$retry = true;
					$after = (int) wp_remote_retrieve_header( $res, 'retry-after' );
					$wait  = $after > 0 ? min( 30, $after ) : $wait;
				} elseif ( $status >= 500 ) {
					$retry = true;
				}
			}
			if ( ! $retry || $attempt >= $retries ) {
				return $error;
			}
			sleep( $wait );
		}
	}

	/**
	 * The key was revoked (reconnected elsewhere, store deleted or uninstalled from the console).
	 */
	private static function mark_key_invalid() {
		$c = Sailes_Settings::connection();
		if ( $c && empty( $c['invalid'] ) ) {
			$c['invalid'] = true;
			update_option( Sailes_Settings::CONNECTION, $c, false );
		}
	}

	/**
	 * Store status from SAILES (plan, active, widget key, console URL). Cached briefly for the storefront.
	 *
	 * @param bool $fresh Skip the cache.
	 * @return array|WP_Error
	 */
	public static function store( $fresh = false ) {
		$cached = get_option( Sailes_Settings::STORE );
		if ( ! $fresh && is_array( $cached ) && $cached['_at'] > time() - 10 * MINUTE_IN_SECONDS ) {
			return $cached;
		}
		$res = self::request( 'GET', '/v1/connector/store' );
		if ( is_wp_error( $res ) ) {
			return $res;
		}
		$res['_at'] = time();
		update_option( Sailes_Settings::STORE, $res, false );
		// The widget key or script URL can change in the console; keep the saved copy current.
		$c = Sailes_Settings::connection();
		if ( $c && ! empty( $res['widgetKey'] ) && ( $c['widget_key'] !== $res['widgetKey'] || $c['widget_script_url'] !== $res['widgetScriptUrl'] || ! empty( $c['invalid'] ) ) ) {
			$c['widget_key']        = $res['widgetKey'];
			$c['widget_script_url'] = $res['widgetScriptUrl'];
			unset( $c['invalid'] );
			update_option( Sailes_Settings::CONNECTION, $c, false );
		}
		return $res;
	}
}
