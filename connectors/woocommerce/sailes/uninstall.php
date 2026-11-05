<?php
/**
 * Uninstall: revoke the connector key at SAILES and remove everything the plugin stored.
 * Catalog data stays in SAILES until the merchant deletes the store in the console.
 *
 * @package Sailes
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

if ( ! defined( 'SAILES_API_URL' ) ) {
	define( 'SAILES_API_URL', 'https://api.sailes.ai' );
}
if ( ! defined( 'SAILES_VERSION' ) ) {
	define( 'SAILES_VERSION', '0.1.0' );
}
require_once __DIR__ . '/includes/class-sailes-crypto.php';
require_once __DIR__ . '/includes/class-sailes-settings.php';
require_once __DIR__ . '/includes/class-sailes-client.php';

if ( Sailes_Settings::is_connected() ) {
	Sailes_Client::request( 'POST', '/v1/connector/disconnect', null, array( 'timeout' => 10 ) );
}
if ( function_exists( 'as_unschedule_all_actions' ) ) {
	foreach ( array( 'sailes_full_sync_page', 'sailes_nightly_sync', 'sailes_flush_changes', 'sailes_push_policies', 'sailes_report_order' ) as $sailes_hook ) {
		as_unschedule_all_actions( $sailes_hook, null, 'sailes' );
	}
}
foreach ( array( 'sailes_connection', 'sailes_settings', 'sailes_sync_status', 'sailes_store_cache', 'sailes_dirty_products' ) as $sailes_option ) {
	delete_option( $sailes_option );
}
