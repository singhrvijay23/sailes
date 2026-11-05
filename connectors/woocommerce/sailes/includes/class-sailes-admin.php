<?php
/**
 * WooCommerce > SAILES settings page: connection, AI provider, catalog sync and storefront.
 *
 * @package Sailes
 */

defined( 'ABSPATH' ) || exit;

/**
 * Admin screens and form handlers.
 */
class Sailes_Admin {

	const SLUG = 'sailes';

	/** Names shown for the AI providers SAILES supports. */
	const PROVIDER_NAMES = array(
		'openai'    => 'OpenAI',
		'gemini'    => 'Google Gemini',
		'anthropic' => 'Anthropic Claude',
	);

	/**
	 * Register hooks.
	 */
	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( SAILES_PLUGIN_FILE ), array( __CLASS__, 'action_links' ) );
		add_action( 'admin_post_sailes_save_ai', array( __CLASS__, 'save_ai' ) );
		add_action( 'admin_post_sailes_save_settings', array( __CLASS__, 'save_settings' ) );
		add_action( 'admin_post_sailes_sync_now', array( __CLASS__, 'sync_now' ) );
		add_action( 'admin_notices', array( __CLASS__, 'connect_prompt' ) );
	}

	/**
	 * Menu item under WooCommerce.
	 */
	public static function menu() {
		add_submenu_page( 'woocommerce', __( 'SAILES AI Sales Assistant', 'sailes' ), __( 'SAILES', 'sailes' ), 'manage_woocommerce', self::SLUG, array( __CLASS__, 'render' ) );
	}

	/**
	 * "Settings" link on the Plugins screen.
	 *
	 * @param array $links Links.
	 * @return array
	 */
	public static function action_links( $links ) {
		array_unshift( $links, '<a href="' . esc_url( self::page_url() ) . '">' . esc_html__( 'Settings', 'sailes' ) . '</a>' );
		return $links;
	}

	/**
	 * Settings page URL.
	 *
	 * @return string
	 */
	public static function page_url() {
		return admin_url( 'admin.php?page=' . self::SLUG );
	}

	/**
	 * Remind admins to connect, except on the SAILES page itself.
	 */
	public static function connect_prompt() {
		$screen = get_current_screen();
		if ( Sailes_Settings::is_connected() || ! current_user_can( 'manage_woocommerce' ) || ( $screen && false !== strpos( (string) $screen->id, self::SLUG ) ) ) {
			return;
		}
		if ( ! $screen || ! in_array( $screen->id, array( 'plugins', 'dashboard', 'woocommerce_page_wc-admin' ), true ) ) {
			return;
		}
		printf(
			'<div class="notice notice-info"><p>%s <a href="%s">%s</a></p></div>',
			esc_html__( 'SAILES is installed. Connect your store to put your AI sales assistant to work.', 'sailes' ),
			esc_url( self::page_url() ),
			esc_html__( 'Connect to SAILES', 'sailes' )
		);
	}

	/**
	 * Show a notice after a redirect back to the settings page, then stop.
	 *
	 * @param string $type    success|error|warning.
	 * @param string $message Text.
	 */
	public static function redirect_with_notice( $type, $message ) {
		set_transient( 'sailes_notice_' . get_current_user_id(), array( $type, $message ), 120 );
		wp_safe_redirect( self::page_url() );
		exit;
	}

	/* ---------------------------------------------------------------- Handlers */

	/**
	 * Save the AI provider. The API key passes through to SAILES, which validates it with a live call
	 * and stores it encrypted. It is never saved in WordPress.
	 */
	public static function save_ai() {
		self::guard( 'sailes_save_ai' );
		// phpcs:disable WordPress.Security.NonceVerification.Missing -- checked in guard().
		$mode     = isset( $_POST['mode'] ) ? sanitize_key( wp_unslash( $_POST['mode'] ) ) : '';
		$provider = isset( $_POST['provider'] ) ? sanitize_key( wp_unslash( $_POST['provider'] ) ) : '';
		$model    = isset( $_POST['chat_model'] ) ? sanitize_text_field( wp_unslash( $_POST['chat_model'] ) ) : '';
		$key      = isset( $_POST['api_key'] ) ? trim( sanitize_text_field( wp_unslash( $_POST['api_key'] ) ) ) : '';
		// phpcs:enable

		if ( ! in_array( $mode, array( 'demo', 'managed', 'byok' ), true ) ) {
			self::redirect_with_notice( 'error', __( 'Choose how SAILES should answer.', 'sailes' ) );
		}
		$body = array( 'mode' => $mode );
		if ( 'byok' === $mode ) {
			if ( ! isset( self::PROVIDER_NAMES[ $provider ] ) ) {
				self::redirect_with_notice( 'error', __( 'Choose an AI provider.', 'sailes' ) );
			}
			$body['provider'] = $provider;
			if ( '' !== $key ) {
				$body['apiKey'] = $key;
			}
			if ( '' !== $model && 0 === strpos( $model, $provider . ':' ) ) {
				$body['chatModel'] = substr( $model, strlen( $provider ) + 1 );
			}
		}
		$res = Sailes_Client::request( 'PUT', '/v1/stores/{store}/ai', $body, array( 'timeout' => 45 ) );
		if ( is_wp_error( $res ) ) {
			$data = (array) $res->get_error_data();
			if ( 403 === (int) ( $data['status'] ?? 0 ) ) {
				self::redirect_with_notice( 'error', __( 'Your SAILES account does not allow changing AI settings from WordPress yet. Change them in the SAILES console.', 'sailes' ) );
			}
			self::redirect_with_notice( 'error', $res->get_error_message() );
		}
		$msg = 'byok' === $mode
			/* translators: %s: provider name */
			? sprintf( __( 'Saved. SAILES now answers with your %s key.', 'sailes' ), self::PROVIDER_NAMES[ $provider ] )
			: __( 'Saved.', 'sailes' );
		if ( ! empty( $res['reindexing'] ) ) {
			$msg .= ' ' . __( 'Your catalog is being re-indexed for the new provider; this takes a few minutes.', 'sailes' );
		}
		self::redirect_with_notice( 'success', $msg );
	}

	/**
	 * Save storefront settings and resend policies.
	 */
	public static function save_settings() {
		self::guard( 'sailes_save_settings' );
		// phpcs:disable WordPress.Security.NonceVerification.Missing -- checked in guard().
		$pages = array();
		$posted = isset( $_POST['policy_pages'] ) && is_array( $_POST['policy_pages'] ) ? wp_unslash( $_POST['policy_pages'] ) : array(); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- each value is absint'd below.
		foreach ( Sailes_Settings::POLICY_TOPICS as $topic ) {
			$pages[ $topic ] = isset( $posted[ $topic ] ) ? absint( $posted[ $topic ] ) : 0;
		}
		Sailes_Settings::save_settings(
			array(
				'widget_enabled' => ! empty( $_POST['widget_enabled'] ),
				'policy_pages'   => $pages,
			)
		);
		// phpcs:enable
		Sailes_Policies::schedule_push();
		self::redirect_with_notice( 'success', __( 'Settings saved.', 'sailes' ) );
	}

	/**
	 * Start a full catalog sync now.
	 */
	public static function sync_now() {
		self::guard( 'sailes_sync_now' );
		Sailes_Sync::start_full_sync();
		Sailes_Policies::schedule_push();
		self::redirect_with_notice( 'success', __( 'Sync started. It runs in the background; refresh this page to see progress.', 'sailes' ) );
	}

	/**
	 * Capability and nonce check.
	 *
	 * @param string $action Nonce action.
	 */
	private static function guard( $action ) {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'You do not have permission to change SAILES settings.', 'sailes' ), 403 );
		}
		check_admin_referer( $action );
		if ( ! in_array( $action, array( 'sailes_save_settings' ), true ) && ! Sailes_Settings::is_connected() ) {
			self::redirect_with_notice( 'error', __( 'Connect your store to SAILES first.', 'sailes' ) );
		}
	}

	/* ---------------------------------------------------------------- Page */

	/**
	 * Render the settings page.
	 */
	public static function render() {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			return;
		}
		$notice = get_transient( 'sailes_notice_' . get_current_user_id() );
		delete_transient( 'sailes_notice_' . get_current_user_id() );
		$conn  = Sailes_Settings::connection();
		$store = $conn ? Sailes_Client::store( true ) : null;
		$conn  = Sailes_Settings::connection(); // store() may have refreshed it.
		?>
		<div class="wrap sailes-wrap">
			<h1><?php esc_html_e( 'SAILES AI Sales Assistant', 'sailes' ); ?></h1>
			<p class="description"><?php esc_html_e( 'Your 24/7 digital sales associate: it searches your catalog, asks shoppers the right questions and recommends products that fit.', 'sailes' ); ?></p>
			<?php
			if ( is_array( $notice ) ) {
				printf( '<div class="notice notice-%1$s is-dismissible"><p>%2$s</p></div>', esc_attr( $notice[0] ), esc_html( $notice[1] ) );
			}
			self::style();
			if ( ! $conn ) {
				self::render_connect();
			} else {
				self::render_connection( $conn, $store );
				if ( empty( $conn['invalid'] ) && ! is_wp_error( $store ) ) {
					self::render_ai( $store );
					self::render_sync();
				}
			}
			self::render_storefront( (bool) $conn );
			?>
		</div>
		<?php
	}

	/**
	 * Not connected yet.
	 */
	private static function render_connect() {
		$https = 0 === strpos( home_url(), 'https://' );
		?>
		<div class="sailes-card">
			<h2><?php esc_html_e( 'Connect your store', 'sailes' ); ?></h2>
			<p><?php esc_html_e( 'You will sign in to SAILES (or create an account with a 14-day free trial), approve the connection and come straight back here.', 'sailes' ); ?></p>
			<p><?php esc_html_e( 'SAILES syncs your product catalog, stock and store policies, shows the SAILES assistant on your storefront and reports orders for analytics. It does not access customer payment details.', 'sailes' ); ?></p>
			<?php if ( ! $https ) : ?>
				<p class="sailes-warn"><?php esc_html_e( 'Your site address does not use https. SAILES only connects to https stores (local development sites are the exception).', 'sailes' ); ?></p>
			<?php endif; ?>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="sailes_connect" />
				<?php wp_nonce_field( 'sailes_connect' ); ?>
				<?php submit_button( __( 'Connect to SAILES', 'sailes' ), 'primary', 'submit', false ); ?>
			</form>
		</div>
		<?php
	}

	/**
	 * Connection status.
	 *
	 * @param array               $conn  Connection.
	 * @param array|WP_Error|null $store Store status.
	 */
	private static function render_connection( array $conn, $store ) {
		$console = is_array( $store ) && ! empty( $store['consoleUrl'] ) ? untrailingslashit( $store['consoleUrl'] ) : untrailingslashit( SAILES_CONSOLE_URL );
		?>
		<div class="sailes-card">
			<h2><?php esc_html_e( 'Connection', 'sailes' ); ?></h2>
			<?php if ( ! empty( $conn['invalid'] ) ) : ?>
				<p class="sailes-warn"><?php esc_html_e( 'SAILES no longer accepts this site\'s key. The store may have been reconnected from another site or removed. Reconnect to continue.', 'sailes' ); ?></p>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="sailes-inline">
					<input type="hidden" name="action" value="sailes_connect" />
					<?php wp_nonce_field( 'sailes_connect' ); ?>
					<?php submit_button( __( 'Reconnect', 'sailes' ), 'primary', 'submit', false ); ?>
				</form>
			<?php elseif ( is_wp_error( $store ) ) : ?>
				<p class="sailes-warn"><?php echo esc_html( $store->get_error_message() ); ?></p>
			<?php else : ?>
				<table class="form-table" role="presentation">
					<tr><th><?php esc_html_e( 'Store', 'sailes' ); ?></th><td><strong><?php echo esc_html( $store['storeName'] ?? '' ); ?></strong></td></tr>
					<tr><th><?php esc_html_e( 'Plan', 'sailes' ); ?></th><td><?php echo esc_html( ucfirst( (string) ( $store['plan'] ?? '' ) ) ); ?></td></tr>
					<tr>
						<th><?php esc_html_e( 'Status', 'sailes' ); ?></th>
						<td>
							<?php if ( ! empty( $store['active'] ) ) : ?>
								<span class="sailes-ok"><?php esc_html_e( 'Active: the assistant is live on your store', 'sailes' ); ?></span>
							<?php else : ?>
								<span class="sailes-warn"><?php esc_html_e( 'Your free trial has ended. The assistant is hidden until you choose a plan.', 'sailes' ); ?></span>
								<a class="button button-primary" href="<?php echo esc_url( $console . '/billing' ); ?>" target="_blank" rel="noopener"><?php esc_html_e( 'Choose a plan', 'sailes' ); ?></a>
							<?php endif; ?>
						</td>
					</tr>
				</table>
			<?php endif; ?>
			<p>
				<a class="button" href="<?php echo esc_url( $console ); ?>" target="_blank" rel="noopener"><?php esc_html_e( 'Open SAILES console', 'sailes' ); ?></a>
				<span class="description"><?php esc_html_e( 'Look and greeting, sales rules, upsell, conversations, analytics and billing are in the console.', 'sailes' ); ?></span>
			</p>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" onsubmit="return confirm('<?php echo esc_js( __( 'Disconnect this store from SAILES? The assistant will disappear from your storefront.', 'sailes' ) ); ?>');">
				<input type="hidden" name="action" value="sailes_disconnect" />
				<?php wp_nonce_field( 'sailes_disconnect' ); ?>
				<?php submit_button( __( 'Disconnect', 'sailes' ), 'delete', 'submit', false ); ?>
			</form>
		</div>
		<?php
	}

	/**
	 * AI provider: the store admin's own OpenAI, Gemini or Claude key, SAILES AI credits, or keyword mode.
	 *
	 * @param array $store Store status.
	 */
	private static function render_ai( array $store ) {
		$current   = Sailes_Client::request( 'GET', '/v1/stores/{store}/ai', null, array( 'timeout' => 15 ) );
		$providers = Sailes_Client::request( 'GET', '/v1/ai/providers', null, array( 'auth' => false, 'timeout' => 15 ) );
		$console   = untrailingslashit( $store['consoleUrl'] ?? SAILES_CONSOLE_URL );
		?>
		<div class="sailes-card">
			<h2><?php esc_html_e( 'AI provider', 'sailes' ); ?></h2>
			<?php
			if ( is_wp_error( $current ) || is_wp_error( $providers ) ) {
				echo '<p>' . esc_html__( 'AI settings for this store are managed in the SAILES console.', 'sailes' ) . ' <a href="' . esc_url( $console . '/ai' ) . '" target="_blank" rel="noopener">' . esc_html__( 'Open AI settings', 'sailes' ) . '</a></p></div>';
				return;
			}
			$mode     = (string) ( $current['mode'] ?? 'demo' );
			$cred     = is_array( $current['credential'] ?? null ) ? $current['credential'] : null;
			$selected = $cred ? (string) $cred['provider'] : 'openai';
			$model    = $cred ? (string) $cred['chat_model'] : '';
			$list     = array();
			foreach ( (array) ( $providers['providers'] ?? array() ) as $p ) {
				if ( isset( self::PROVIDER_NAMES[ $p['id'] ] ) ) {
					$list[ $p['id'] ] = $p;
				}
			}
			?>
			<p><?php esc_html_e( 'Use your own AI account: paste an API key from OpenAI, Google Gemini or Anthropic Claude. The key is checked with a test call, then stored encrypted by SAILES. It is not saved in WordPress, and AI usage is billed to your provider account.', 'sailes' ); ?></p>
			<?php if ( $cred ) : ?>
				<p>
					<?php
					printf(
						/* translators: 1: provider, 2: model, 3: last 4 characters of the key */
						esc_html__( 'Current key: %1$s, model %2$s, key ending %3$s.', 'sailes' ),
						esc_html( self::PROVIDER_NAMES[ $cred['provider'] ] ?? $cred['provider'] ),
						'<code>' . esc_html( $cred['chat_model'] ) . '</code>',
						'<code>' . esc_html( (string) $cred['key_last4'] ) . '</code>'
					);
					?>
				</p>
			<?php endif; ?>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" id="sailes-ai-form" autocomplete="off">
				<input type="hidden" name="action" value="sailes_save_ai" />
				<?php wp_nonce_field( 'sailes_save_ai' ); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><?php esc_html_e( 'Answer with', 'sailes' ); ?></th>
						<td>
							<fieldset>
								<label><input type="radio" name="mode" value="byok" <?php checked( 'byok', $mode ); ?> /> <?php esc_html_e( 'My own AI provider key (recommended)', 'sailes' ); ?></label><br />
								<?php if ( ! empty( $providers['managedAvailable'] ) ) : ?>
									<label><input type="radio" name="mode" value="managed" <?php checked( 'managed', $mode ); ?> /> <?php esc_html_e( 'SAILES AI credits (no key needed, prepaid in the console)', 'sailes' ); ?></label><br />
								<?php endif; ?>
								<label><input type="radio" name="mode" value="demo" <?php checked( 'demo', $mode ); ?> /> <?php esc_html_e( 'Keyword search only (no AI, for testing)', 'sailes' ); ?></label>
							</fieldset>
						</td>
					</tr>
					<tr class="sailes-byok">
						<th scope="row"><label for="sailes-provider"><?php esc_html_e( 'Provider', 'sailes' ); ?></label></th>
						<td>
							<select name="provider" id="sailes-provider">
								<?php foreach ( $list as $id => $p ) : ?>
									<option value="<?php echo esc_attr( $id ); ?>" <?php selected( $selected, $id ); ?>><?php echo esc_html( self::PROVIDER_NAMES[ $id ] ); ?></option>
								<?php endforeach; ?>
							</select>
						</td>
					</tr>
					<tr class="sailes-byok">
						<th scope="row"><label for="sailes-model"><?php esc_html_e( 'Model', 'sailes' ); ?></label></th>
						<td>
							<select name="chat_model" id="sailes-model">
								<?php foreach ( $list as $id => $p ) : ?>
									<optgroup label="<?php echo esc_attr( self::PROVIDER_NAMES[ $id ] ); ?>" data-provider="<?php echo esc_attr( $id ); ?>">
										<?php foreach ( (array) $p['models'] as $m ) : ?>
											<option value="<?php echo esc_attr( $id . ':' . $m ); ?>" <?php selected( $cred && $selected === $id ? $model : $p['defaultModel'], $m ); ?>>
												<?php echo esc_html( $m . ( $m === $p['defaultModel'] ? ' ' . __( '(default, lowest cost)', 'sailes' ) : '' ) ); ?>
											</option>
										<?php endforeach; ?>
									</optgroup>
								<?php endforeach; ?>
							</select>
						</td>
					</tr>
					<tr class="sailes-byok">
						<th scope="row"><label for="sailes-key"><?php esc_html_e( 'API key', 'sailes' ); ?></label></th>
						<td>
							<input type="password" name="api_key" id="sailes-key" class="regular-text" autocomplete="new-password" spellcheck="false"
								placeholder="<?php echo esc_attr( $cred ? __( 'Leave empty to keep the current key', 'sailes' ) : __( 'Paste your API key', 'sailes' ) ); ?>" />
							<p class="description"><?php esc_html_e( 'Get a key: platform.openai.com/api-keys, aistudio.google.com/apikey or console.anthropic.com/settings/keys.', 'sailes' ); ?></p>
						</td>
					</tr>
				</table>
				<?php submit_button( __( 'Save AI settings', 'sailes' ) ); ?>
			</form>
			<script>
			( function () {
				var form = document.getElementById( 'sailes-ai-form' );
				var provider = document.getElementById( 'sailes-provider' );
				var model = document.getElementById( 'sailes-model' );
				function update() {
					var mode = form.querySelector( 'input[name=mode]:checked' );
					var byok = ! mode || mode.value === 'byok';
					form.querySelectorAll( '.sailes-byok' ).forEach( function ( r ) { r.style.display = byok ? '' : 'none'; } );
					var groups = model.querySelectorAll( 'optgroup' );
					groups.forEach( function ( g ) {
						var on = g.getAttribute( 'data-provider' ) === provider.value;
						g.hidden = ! on;
						g.disabled = ! on;
					} );
					if ( model.selectedOptions.length === 0 || model.selectedOptions[0].parentNode.disabled ) {
						var first = model.querySelector( 'optgroup[data-provider="' + provider.value + '"] option' );
						if ( first ) { first.selected = true; }
					}
				}
				form.addEventListener( 'change', update );
				update();
			} )();
			</script>
		</div>
		<?php
	}

	/**
	 * Catalog sync status.
	 */
	private static function render_sync() {
		$s      = Sailes_Settings::sync_status();
		$labels = array(
			'idle'    => __( 'Not synced yet', 'sailes' ),
			'running' => __( 'Syncing…', 'sailes' ),
			'done'    => __( 'Up to date', 'sailes' ),
			'failed'  => __( 'Sync stopped', 'sailes' ),
			'limit'   => __( 'Product limit reached', 'sailes' ),
		);
		$count  = array_sum( (array) wp_count_posts( 'product' )->publish );
		?>
		<div class="sailes-card">
			<h2><?php esc_html_e( 'Catalog sync', 'sailes' ); ?></h2>
			<p><?php esc_html_e( 'Published products are sent to SAILES when you connect, again whenever a product, price or stock level changes, and once a night to catch anything missed. Hidden, draft and private products are not shown to shoppers.', 'sailes' ); ?></p>
			<table class="form-table" role="presentation">
				<tr><th><?php esc_html_e( 'Status', 'sailes' ); ?></th><td><strong><?php echo esc_html( $labels[ $s['state'] ] ?? $s['state'] ); ?></strong></td></tr>
				<tr>
					<th><?php esc_html_e( 'Last full sync', 'sailes' ); ?></th>
					<td>
						<?php
						if ( $s['finished_at'] && 'done' === $s['state'] ) {
							printf(
								/* translators: 1: number of products sent, 2: published products in the store, 3: time ago */
								esc_html__( '%1$s of %2$s published products sent, %3$s ago', 'sailes' ),
								esc_html( number_format_i18n( $s['sent'] ) ),
								esc_html( number_format_i18n( $count ) ),
								esc_html( human_time_diff( $s['finished_at'] ) )
							);
						} elseif ( 'running' === $s['state'] ) {
							/* translators: %s: number of products sent so far */
							printf( esc_html__( '%s products sent so far', 'sailes' ), esc_html( number_format_i18n( $s['sent'] ) ) );
						} else {
							echo '&mdash;';
						}
						?>
					</td>
				</tr>
				<?php if ( $s['rejected'] ) : ?>
					<tr><th><?php esc_html_e( 'Skipped', 'sailes' ); ?></th><td><?php /* translators: %s: count */ printf( esc_html__( '%s products were skipped because they have no price or name.', 'sailes' ), esc_html( number_format_i18n( $s['rejected'] ) ) ); ?></td></tr>
				<?php endif; ?>
				<?php if ( $s['last_error'] ) : ?>
					<tr><th><?php esc_html_e( 'Last problem', 'sailes' ); ?></th><td class="sailes-warn"><?php echo esc_html( $s['last_error'] ); ?> <span class="description">(<?php echo esc_html( human_time_diff( $s['last_error_at'] ) ); ?> <?php esc_html_e( 'ago', 'sailes' ); ?>)</span></td></tr>
				<?php endif; ?>
			</table>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="sailes_sync_now" />
				<?php wp_nonce_field( 'sailes_sync_now' ); ?>
				<?php submit_button( __( 'Sync all products now', 'sailes' ), 'secondary', 'submit', false ); ?>
			</form>
		</div>
		<?php
	}

	/**
	 * Storefront and policy pages.
	 *
	 * @param bool $connected Connected.
	 */
	private static function render_storefront( $connected ) {
		$s      = Sailes_Settings::settings();
		$labels = array(
			'shipping' => __( 'Shipping', 'sailes' ),
			'returns'  => __( 'Returns and refunds', 'sailes' ),
			'warranty' => __( 'Warranty', 'sailes' ),
			'payment'  => __( 'Payment', 'sailes' ),
			'contact'  => __( 'Contact', 'sailes' ),
		);
		?>
		<div class="sailes-card">
			<h2><?php esc_html_e( 'Storefront', 'sailes' ); ?></h2>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="sailes_save_settings" />
				<?php wp_nonce_field( 'sailes_save_settings' ); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><?php esc_html_e( 'Assistant', 'sailes' ); ?></th>
						<td>
							<label><input type="checkbox" name="widget_enabled" value="1" <?php checked( $s['widget_enabled'] ); ?> /> <?php esc_html_e( 'Show the SAILES chat on every page of the store', 'sailes' ); ?></label>
							<p class="description">
								<?php
								printf(
									/* translators: %s: shortcode */
									esc_html__( 'To show the chat inside a page instead of the floating button (for example on a "Help me choose" page), add the %s shortcode to that page.', 'sailes' ),
									'<code>[sailes_chat]</code>'
								);
								?>
							</p>
						</td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Policy pages', 'sailes' ); ?></th>
						<td>
							<p class="description"><?php esc_html_e( 'The assistant answers questions about shipping, returns and more from these pages.', 'sailes' ); ?></p>
							<?php foreach ( $labels as $topic => $label ) : ?>
								<p>
									<label for="sailes-policy-<?php echo esc_attr( $topic ); ?>" class="sailes-policy-label"><?php echo esc_html( $label ); ?></label>
									<?php
									wp_dropdown_pages(
										array(
											'name'              => 'policy_pages[' . esc_attr( $topic ) . ']',
											'id'                => 'sailes-policy-' . esc_attr( $topic ),
											'selected'          => (int) ( $s['policy_pages'][ $topic ] ?? 0 ),
											'show_option_none'  => esc_html__( '— None —', 'sailes' ),
											'option_none_value' => '0',
										)
									);
									?>
								</p>
							<?php endforeach; ?>
						</td>
					</tr>
				</table>
				<?php submit_button( $connected ? __( 'Save and send to SAILES', 'sailes' ) : __( 'Save', 'sailes' ) ); ?>
			</form>
		</div>
		<?php
	}

	/**
	 * A little layout for the cards.
	 */
	private static function style() {
		?>
		<style>
			.sailes-wrap .sailes-card { background: #fff; border: 1px solid #c3c4c7; border-radius: 4px; padding: 4px 20px 16px; margin: 16px 0; max-width: 900px; }
			.sailes-wrap .sailes-ok { color: #00a32a; font-weight: 600; }
			.sailes-wrap .sailes-warn { color: #b32d2e; }
			.sailes-wrap .sailes-policy-label { display: inline-block; min-width: 160px; }
			.sailes-wrap .form-table th { width: 160px; }
		</style>
		<?php
	}
}
