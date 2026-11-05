<?php
/**
 * Store policies (connector contract section 3): the pages the merchant picks for shipping,
 * returns and so on are sent to SAILES as plain text, and resent when they change.
 *
 * @package Sailes
 */

defined( 'ABSPATH' ) || exit;

/**
 * Policy page sync.
 */
class Sailes_Policies {

	const MAX_CHARS = 4000;

	/**
	 * Register hooks.
	 */
	public static function init() {
		add_action( 'sailes_push_policies', array( __CLASS__, 'push_all' ) );
		add_action( 'save_post_page', array( __CLASS__, 'on_page_saved' ), 20, 2 );
	}

	/**
	 * Send all policies in the background.
	 */
	public static function schedule_push() {
		if ( Sailes_Settings::is_connected() && ! Sailes_Sync::has_pending( 'sailes_push_policies' ) ) {
			as_enqueue_async_action( 'sailes_push_policies', array(), Sailes_Sync::GROUP );
		}
	}

	/**
	 * A policy page was edited.
	 *
	 * @param int     $post_id Page id.
	 * @param WP_Post $post    Page.
	 */
	public static function on_page_saved( $post_id, $post ) {
		if ( wp_is_post_revision( $post_id ) || wp_is_post_autosave( $post_id ) || 'publish' !== $post->post_status ) {
			return;
		}
		if ( in_array( (int) $post_id, Sailes_Settings::settings()['policy_pages'], true ) ) {
			self::schedule_push();
		}
	}

	/**
	 * Send every chosen policy page. Topics without a page are skipped (SAILES keeps any text
	 * entered in the console for them).
	 */
	public static function push_all() {
		foreach ( Sailes_Settings::settings()['policy_pages'] as $topic => $page_id ) {
			$content = $page_id ? self::page_text( $page_id ) : '';
			if ( '' === $content ) {
				continue;
			}
			Sailes_Client::request( 'PUT', '/v1/stores/{store}/policies', array( 'topic' => $topic, 'content' => $content ), array( 'retries' => Sailes_Client::BACKGROUND_RETRIES ) );
		}
	}

	/**
	 * Plain text of a published page, capped at 4,000 characters.
	 *
	 * @param int $page_id Page id.
	 * @return string
	 */
	public static function page_text( $page_id ) {
		$post = get_post( $page_id );
		if ( ! $post || 'publish' !== $post->post_status || '' !== $post->post_password ) {
			return '';
		}
		return Sailes_Product_Mapper::text( trim( get_the_title( $post ) ) . '<br>' . $post->post_content, self::MAX_CHARS );
	}
}
