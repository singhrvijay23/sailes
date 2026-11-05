<?php
/**
 * Plugin Name:          SAILES – AI Sales Assistant for WooCommerce
 * Plugin URI:           https://sailes.ai
 * Description:          Your 24/7 digital sales associate. SAILES finds the right products in your catalog, asks shoppers the right questions and recommends what fits.
 * Version:              0.1.0
 * Requires at least:    6.4
 * Requires PHP:         7.4
 * Requires Plugins:     woocommerce
 * WC requires at least: 8.0
 * WC tested up to:      10.3
 * Author:               True North Management Inc.
 * Author URI:           https://sailes.ai
 * License:              GPL-2.0-or-later
 * License URI:          https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:          sailes
 *
 * @package Sailes
 */

defined( 'ABSPATH' ) || exit;

define( 'SAILES_VERSION', '0.1.0' );
define( 'SAILES_PLUGIN_FILE', __FILE__ );
define( 'SAILES_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'SAILES_PLUGIN_URL', plugin_dir_url( __FILE__ ) );

/*
 * Where the SAILES service lives. Override in wp-config.php for staging or local development:
 *   define( 'SAILES_API_URL', 'http://localhost:4000' );
 *   define( 'SAILES_CONSOLE_URL', 'http://localhost:3000' );
 * After connecting, API calls use the apiUrl SAILES returned, not this constant.
 */
if ( ! defined( 'SAILES_API_URL' ) ) {
	define( 'SAILES_API_URL', 'https://api.sailes.ai' );
}
if ( ! defined( 'SAILES_CONSOLE_URL' ) ) {
	define( 'SAILES_CONSOLE_URL', 'https://app.sailes.ai' );
}

require_once SAILES_PLUGIN_DIR . 'includes/class-sailes-crypto.php';
require_once SAILES_PLUGIN_DIR . 'includes/class-sailes-settings.php';
require_once SAILES_PLUGIN_DIR . 'includes/class-sailes-client.php';
require_once SAILES_PLUGIN_DIR . 'includes/class-sailes-connect.php';
require_once SAILES_PLUGIN_DIR . 'includes/class-sailes-product-mapper.php';
require_once SAILES_PLUGIN_DIR . 'includes/class-sailes-sync.php';
require_once SAILES_PLUGIN_DIR . 'includes/class-sailes-policies.php';
require_once SAILES_PLUGIN_DIR . 'includes/class-sailes-orders.php';
require_once SAILES_PLUGIN_DIR . 'includes/class-sailes-frontend.php';
require_once SAILES_PLUGIN_DIR . 'includes/class-sailes-admin.php';

add_action(
	'before_woocommerce_init',
	static function () {
		if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', SAILES_PLUGIN_FILE, true );
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'cart_checkout_blocks', SAILES_PLUGIN_FILE, true );
		}
	}
);

add_action(
	'plugins_loaded',
	static function () {
		load_plugin_textdomain( 'sailes' );
		if ( ! class_exists( 'WooCommerce' ) ) {
			add_action(
				'admin_notices',
				static function () {
					echo '<div class="notice notice-error"><p>' . esc_html__( 'SAILES needs WooCommerce. Install and activate WooCommerce first.', 'sailes' ) . '</p></div>';
				}
			);
			return;
		}
		Sailes_Connect::init();
		Sailes_Sync::init();
		Sailes_Policies::init();
		Sailes_Orders::init();
		Sailes_Frontend::init();
		if ( is_admin() ) {
			Sailes_Admin::init();
		}
	}
);

register_deactivation_hook( __FILE__, array( 'Sailes_Sync', 'unschedule_all' ) );
