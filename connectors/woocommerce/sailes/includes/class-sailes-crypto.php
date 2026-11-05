<?php
/**
 * Encrypts the SAILES connector key at rest, with a key derived from this site's salts.
 *
 * @package Sailes
 */

defined( 'ABSPATH' ) || exit;

/**
 * Sodium secretbox (XSalsa20-Poly1305). WordPress bundles sodium_compat, so this works on every host.
 * If the site's salts change, decryption fails and the merchant is asked to reconnect.
 */
class Sailes_Crypto {

	const PREFIX = 'sv1:';

	/**
	 * 32-byte key from the site's auth salts. The salts never leave this server.
	 *
	 * @return string
	 */
	private static function key() {
		return sodium_crypto_generichash( 'sailes-connector-key|' . wp_salt( 'auth' ) . '|' . wp_salt( 'secure_auth' ), '', SODIUM_CRYPTO_SECRETBOX_KEYBYTES );
	}

	/**
	 * Encrypt a secret.
	 *
	 * @param string $plain Secret.
	 * @return string
	 */
	public static function encrypt( $plain ) {
		$nonce = random_bytes( SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
		return self::PREFIX . base64_encode( $nonce . sodium_crypto_secretbox( $plain, $nonce, self::key() ) ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
	}

	/**
	 * Decrypt a secret, or null when it cannot be read (salts changed or data damaged).
	 *
	 * @param string $sealed Output of encrypt().
	 * @return string|null
	 */
	public static function decrypt( $sealed ) {
		if ( ! is_string( $sealed ) || 0 !== strpos( $sealed, self::PREFIX ) ) {
			return null;
		}
		$raw = base64_decode( substr( $sealed, strlen( self::PREFIX ) ), true ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode
		if ( false === $raw || strlen( $raw ) <= SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ) {
			return null;
		}
		$plain = sodium_crypto_secretbox_open( substr( $raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ), substr( $raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ), self::key() );
		return false === $plain ? null : $plain;
	}
}
