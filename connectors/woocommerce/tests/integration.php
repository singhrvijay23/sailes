<?php
/**
 * End-to-end test of the plugin inside a real WordPress + WooCommerce, against a running SAILES API.
 *
 *   php tests/integration.php /path/to/wordpress http://localhost:4000
 *
 * The WordPress install must have WooCommerce and this plugin active, and wp-config.php must set
 * SAILES_API_URL to the API under test. bin/setup-wordpress.sh prepares one. The test signs up a
 * fresh merchant, so it can run repeatedly against the same database.
 *
 * @package Sailes
 */

// phpcs:disable

$wp_dir  = $argv[1] ?? '';
$api_url = rtrim( $argv[2] ?? 'http://localhost:4000', '/' );
if ( ! is_file( $wp_dir . '/wp-load.php' ) ) {
	fwrite( STDERR, "usage: php tests/integration.php <wordpress dir> [api url]\n" );
	exit( 2 );
}
$_SERVER['HTTP_HOST']   = parse_url( getenv( 'WP_HOME' ) ?: 'http://localhost:8080', PHP_URL_HOST ) . ':' . ( parse_url( getenv( 'WP_HOME' ) ?: 'http://localhost:8080', PHP_URL_PORT ) ?: 80 );
$_SERVER['REQUEST_URI'] = '/';
require $wp_dir . '/wp-load.php';

$failures = 0;
function check( $label, $ok, $detail = '' ) {
	global $failures;
	echo ( $ok ? "  ok   " : "  FAIL " ) . $label . ( $ok || '' === $detail ? '' : "\n       " . $detail ) . "\n";
	if ( ! $ok ) {
		$failures++;
	}
}
function api( $method, $path, $body = null, $token = null ) {
	global $api_url;
	$args = array( 'method' => $method, 'timeout' => 30, 'headers' => array( 'Content-Type' => 'application/json' ) );
	if ( $token ) {
		$args['headers']['Authorization'] = 'Bearer ' . $token;
	}
	$args['body'] = wp_json_encode( null === $body ? new stdClass() : $body );
	if ( 'GET' === $method ) {
		unset( $args['body'], $args['headers']['Content-Type'] );
	}
	$res = wp_remote_request( $api_url . $path, $args );
	if ( is_wp_error( $res ) ) {
		throw new RuntimeException( $res->get_error_message() );
	}
	return array( wp_remote_retrieve_response_code( $res ), json_decode( wp_remote_retrieve_body( $res ), true ) );
}
/** Runs every pending SAILES job now, including debounced and retry jobs. */
function run_jobs() {
	for ( $round = 0; $round < 20; $round++ ) {
		$ids = as_get_scheduled_actions( array( 'group' => 'sailes', 'status' => ActionScheduler_Store::STATUS_PENDING, 'per_page' => 50 ), 'ids' );
		$ran = 0;
		foreach ( $ids as $id ) {
			if ( 'sailes_nightly_sync' === ActionScheduler::store()->fetch_action( $id )->get_hook() ) {
				continue;
			}
			ActionScheduler::runner()->process_action( $id, 'sailes-test' );
			$ran++;
		}
		if ( ! $ran ) {
			return;
		}
	}
}
/** Admin handlers end with a redirect and exit; turn that into an exception the test can catch. */
class Redirected extends Exception {}
add_filter( 'wp_redirect', function ( $location ) {
	throw new Redirected( $location );
}, 1 );
function call_handler( callable $fn ) {
	try {
		$fn();
	} catch ( Redirected $r ) {
		return $r->getMessage();
	}
	return null;
}
function notice() {
	$n = get_transient( 'sailes_notice_' . get_current_user_id() );
	delete_transient( 'sailes_notice_' . get_current_user_id() );
	return is_array( $n ) ? $n : array( '', '' );
}

$admin = get_users( array( 'role' => 'administrator', 'number' => 1 ) )[0];
wp_set_current_user( $admin->ID );
update_option( 'woocommerce_coming_soon', 'no' );
Sailes_Connect::revoke_and_forget();

echo "Products\n";
$cat     = wp_insert_term( 'Shoes ' . wp_generate_password( 4, false ), 'product_cat' );
$make    = function ( $name, $price, $extra = array() ) use ( $cat ) {
	$p = new WC_Product_Simple();
	$p->set_name( $name );
	$p->set_regular_price( $extra['regular'] ?? $price );
	if ( isset( $extra['regular'] ) ) {
		$p->set_sale_price( $price );
	}
	$p->set_description( '<!-- wp:paragraph --><p>Light <strong>trail</strong> shoe.</p><!-- /wp:paragraph --><p>Grippy sole.</p>' );
	$p->set_category_ids( array( $cat['term_id'] ) );
	$p->set_status( $extra['status'] ?? 'publish' );
	if ( isset( $extra['visibility'] ) ) {
		$p->set_catalog_visibility( $extra['visibility'] );
	}
	return $p->save();
};
$sale    = $make( 'Test Trail Shoe', 89, array( 'regular' => 120 ) );
$plain   = $make( 'Test Road Shoe', 140 );
$hidden  = $make( 'Test Hidden Shoe', 70, array( 'visibility' => 'hidden' ) );
$draft   = $make( 'Test Draft Shoe', 70, array( 'status' => 'draft' ) );
$color   = new WC_Product_Attribute();
$color->set_name( 'Color' );
$color->set_options( array( 'Blue', 'Red' ) );
$color->set_visible( true );
$color->set_variation( true );
$var = new WC_Product_Variable();
$var->set_name( 'Test Sock' );
$var->set_attributes( array( $color ) );
$var->set_status( 'publish' );
$sock = $var->save();
foreach ( array( 'Blue' => 12, 'Red' => 14 ) as $c => $price ) {
	$v = new WC_Product_Variation();
	$v->set_parent_id( $sock );
	$v->set_attributes( array( 'color' => $c ) );
	$v->set_regular_price( $price );
	$v->save();
}
WC_Product_Variable::sync( $sock );
$mapped = Sailes_Product_Mapper::map( wc_get_product( $sale ) );
check( 'maps sale price and compare-at price', 89.0 === $mapped['price'] && 120.0 === $mapped['compare_at_price'], wp_json_encode( $mapped ) );
check( 'description is plain text with paragraphs', "Light trail shoe.\nGrippy sole." === $mapped['description'], $mapped['description'] );
check( 'simple product has an add-to-cart link', false !== strpos( $mapped['add_to_cart_url'] ?? '', 'add-to-cart=' . $sale ) );
$mapped = Sailes_Product_Mapper::map( wc_get_product( $sock ) );
check( 'variable product: lowest price, variants and attributes', 12.0 === $mapped['price'] && 2 === count( $mapped['variants'] ) && 'Blue, Red' === $mapped['attributes']['color'], wp_json_encode( $mapped ) );
check( 'hidden and draft products are not syncable', ! Sailes_Product_Mapper::is_syncable( wc_get_product( $hidden ) ) && ! Sailes_Product_Mapper::is_syncable( wc_get_product( $draft ) ) );

echo "Key encryption\n";
$sealed = Sailes_Crypto::encrypt( 'sk_secret_value' );
check( 'round trip', 'sk_secret_value' === Sailes_Crypto::decrypt( $sealed ) && false === strpos( $sealed, 'secret' ) );
check( 'tampered data is rejected', null === Sailes_Crypto::decrypt( substr( $sealed, 0, -2 ) . 'AA' ) );

echo "Connect\n";
list( , $merchant ) = api( 'POST', '/v1/auth/signup', array( 'email' => 'woo' . time() . wp_rand() . '@shop.test', 'password' => 'password123', 'storeName' => 'Woo CI Shop' ) );
$_POST['_wpnonce']  = wp_create_nonce( 'sailes_connect' );
$_REQUEST['_wpnonce'] = $_POST['_wpnonce'];
$console = call_handler( array( 'Sailes_Connect', 'start' ) );
parse_str( (string) wp_parse_url( $console, PHP_URL_QUERY ), $q );
check( 'sends the merchant to the console /connect page', 0 === strpos( $console, SAILES_CONSOLE_URL . '/connect?' ) && 'woocommerce' === $q['platform'] && strlen( $q['state'] ) >= 8, $console );
list( $code, $approved ) = api( 'POST', '/v1/stores/' . $merchant['storeId'] . '/connect/approve', array( 'platform' => 'woocommerce', 'shopUrl' => $q['shop'], 'redirectUri' => $q['redirect_uri'], 'state' => $q['state'] ), $merchant['token'] );
check( 'console approves the connection', 200 === $code, wp_json_encode( $approved ) );
parse_str( (string) wp_parse_url( $approved['redirect'], PHP_URL_QUERY ), $back );

$_GET = array( 'code' => $back['code'], 'state' => 'wrong-state-123' );
call_handler( array( 'Sailes_Connect', 'callback' ) );
check( 'rejects a callback with the wrong state', ! Sailes_Settings::is_connected() && 'error' === notice()[0] );

// The failed attempt used up the state; start again.
$console = call_handler( array( 'Sailes_Connect', 'start' ) );
parse_str( (string) wp_parse_url( $console, PHP_URL_QUERY ), $q );
list( , $approved ) = api( 'POST', '/v1/stores/' . $merchant['storeId'] . '/connect/approve', array( 'platform' => 'woocommerce', 'shopUrl' => $q['shop'], 'redirectUri' => $q['redirect_uri'], 'state' => $q['state'] ), $merchant['token'] );
parse_str( (string) wp_parse_url( $approved['redirect'], PHP_URL_QUERY ), $back );
$_GET = $back;
call_handler( array( 'Sailes_Connect', 'callback' ) );
$n = notice();
check( 'exchanges the code and saves the connection', Sailes_Settings::is_connected() && 'success' === $n[0], wp_json_encode( $n ) );
$conn = Sailes_Settings::connection();
check( 'stores the secret key encrypted', 0 === strpos( $conn['api_key'], 'sv1:' ) && 0 === strpos( (string) Sailes_Settings::api_key(), 'sk_' ) );
$store = Sailes_Client::store( true );
check( 'connector store status', ! is_wp_error( $store ) && $merchant['storeId'] === $store['storeId'] && 'woocommerce' === $store['platform'] && true === $store['active'], wp_json_encode( $store ) );

echo "Catalog sync\n";
run_jobs();
list( , $catalog ) = api( 'GET', '/v1/stores/' . $merchant['storeId'] . '/catalog?limit=200', null, $merchant['token'] );
$ids = array_column( $catalog['items'], 'id' );
check( 'full sync sends published, visible products', in_array( (string) $sale, $ids, true ) && in_array( (string) $plain, $ids, true ) && in_array( (string) $sock, $ids, true ), wp_json_encode( $ids ) );
check( 'full sync leaves out hidden and draft products', ! in_array( (string) $hidden, $ids, true ) && ! in_array( (string) $draft, $ids, true ) );
check( 'sync status is done', 'done' === Sailes_Settings::sync_status()['state'], wp_json_encode( Sailes_Settings::sync_status() ) );

$p = wc_get_product( $plain );
$p->set_regular_price( 129 );
$p->save();
wp_trash_post( $sale );
$h = wc_get_product( $hidden );
$h->set_catalog_visibility( 'visible' );
$h->save();
$sent = array();
add_action( 'http_api_debug', function ( $response, $context, $class, $args, $url ) use ( &$sent ) {
	if ( false !== strpos( $url, '/catalog/products' ) && 'PUT' === $args['method'] ) {
		$sent[] = json_decode( $args['body'], true );
	}
}, 10, 5 );
$red = wc_get_product( wc_get_product( $sock )->get_children()[1] );
$red->set_stock_status( 'outofstock' );
$red->save();
run_jobs();
list( , $catalog ) = api( 'GET', '/v1/stores/' . $merchant['storeId'] . '/catalog?limit=200', null, $merchant['token'] );
$by_id = array_column( $catalog['items'], null, 'id' );
check( 'price change is sent', isset( $by_id[ (string) $plain ] ) && 129.0 === (float) $by_id[ (string) $plain ]['price'] );
check( 'trashed product is removed', ! isset( $by_id[ (string) $sale ] ) );
check( 'product made visible is added', isset( $by_id[ (string) $hidden ] ) );
$sock_sent = null;
foreach ( $sent as $batch ) {
	foreach ( $batch['products'] as $prod ) {
		if ( (string) $sock === $prod['id'] ) {
			$sock_sent = $prod;
		}
	}
}
check( 'variant stock change resends the parent', $sock_sent && false === $sock_sent['variants'][1]['in_stock'] && true === $sock_sent['variants'][0]['in_stock'], wp_json_encode( $sock_sent ) );
check( 'changes are batched into one request', 1 === count( $sent ), count( $sent ) . ' requests' );

echo "Policies\n";
$page = wp_insert_post( array( 'post_type' => 'page', 'post_status' => 'publish', 'post_title' => 'Shipping', 'post_content' => '<p>Free US shipping over $50.</p>' ) );
Sailes_Settings::save_settings( array( 'policy_pages' => array( 'shipping' => $page ) ) );
Sailes_Policies::push_all();
check( 'policy page text', "Shipping\nFree US shipping over $50." === Sailes_Policies::page_text( $page ), Sailes_Policies::page_text( $page ) );

echo "AI provider\n";
$_POST = array( '_wpnonce' => wp_create_nonce( 'sailes_save_ai' ), 'mode' => 'demo' );
$_REQUEST = $_POST;
call_handler( array( 'Sailes_Admin', 'save_ai' ) );
$n = notice();
if ( 'error' === $n[0] && false !== strpos( $n[1], 'SAILES console' ) ) {
	// SAILES servers from before connectors could change AI settings answer 403; the plugin points to the console.
	echo "  note AI settings from WordPress need the SAILES API change that lets connector keys call PUT /ai\n";
} else {
	check( 'saves keyword mode through the connector key', 'success' === $n[0], wp_json_encode( $n ) );
}
$_POST = array( '_wpnonce' => wp_create_nonce( 'sailes_save_ai' ), 'mode' => 'byok', 'provider' => 'openai', 'chat_model' => 'openai:gpt-5-mini', 'api_key' => 'sk-not-a-real-key-000000' );
$_REQUEST = $_POST;
call_handler( array( 'Sailes_Admin', 'save_ai' ) );
$n = notice();
check( 'rejects an invalid provider key with a readable message', 'error' === $n[0] && '' !== $n[1], wp_json_encode( $n ) );

echo "Orders\n";
$conversation = wp_generate_uuid4();
$_COOKIE[ Sailes_Orders::COOKIE ] = $conversation;
$order = wc_create_order();
$order->add_product( wc_get_product( $plain ), 1 );
$order->calculate_totals();
Sailes_Orders::attach_conversation( $order );
$order->save();
$order->update_status( 'processing' );
run_jobs();
$order = wc_get_order( $order->get_id() );
check( 'paid order is reported once', (bool) $order->get_meta( Sailes_Orders::SENT ) );
$payload = Sailes_Orders::payload( $order );
list( , $dup ) = api( 'POST', '/v1/stores/' . $merchant['storeId'] . '/orders', $payload, $merchant['token'] );
check( 'report carries the conversation and product ids', $conversation === $payload['conversationId'] && array( (string) $plain ) === $payload['productIds'] && true === $dup['duplicate'], wp_json_encode( array( $payload, $dup ) ) );

echo "Disconnect\n";
$key = Sailes_Settings::api_key();
Sailes_Connect::revoke_and_forget();
$res = wp_remote_get( $api_url . '/v1/connector/store', array( 'headers' => array( 'Authorization' => 'Bearer ' . $key ) ) );
check( 'key is revoked at SAILES and forgotten here', 401 === wp_remote_retrieve_response_code( $res ) && ! Sailes_Settings::is_connected() );
check( 'background jobs are removed', ! as_get_scheduled_actions( array( 'group' => 'sailes', 'status' => ActionScheduler_Store::STATUS_PENDING ), 'ids' ) );

foreach ( array( $sale, $plain, $hidden, $draft, $sock ) as $id ) {
	wp_delete_post( $id, true );
}
echo $failures ? "\n$failures failed\n" : "\nAll passed\n";
exit( $failures ? 1 : 0 );
