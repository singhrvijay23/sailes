<?php
/**
 * Maps WooCommerce products to the SAILES product shape (connector contract section 2).
 *
 * @package Sailes
 */

defined( 'ABSPATH' ) || exit;

/**
 * WC_Product to SAILES product.
 */
class Sailes_Product_Mapper {

	const MAX_VARIANTS = 20;

	/** Product types SAILES can recommend. Variations are sent inside their parent. */
	const TYPES = array( 'simple', 'variable', 'grouped', 'external' );

	/**
	 * Whether a product belongs in the SAILES catalog: published, visible in the shop and not password protected.
	 *
	 * @param WC_Product|false|null $product Product.
	 * @return bool
	 */
	public static function is_syncable( $product ) {
		if ( ! $product instanceof WC_Product || ! in_array( $product->get_type(), self::syncable_types(), true ) ) {
			return false;
		}
		if ( 'publish' !== $product->get_status() || '' !== (string) $product->get_post_password() ) {
			return false;
		}
		$include = in_array( $product->get_catalog_visibility(), array( 'visible', 'catalog', 'search' ), true );
		/**
		 * Filter whether a product is sent to SAILES.
		 *
		 * @param bool       $include Default decision.
		 * @param WC_Product $product Product.
		 */
		return (bool) apply_filters( 'sailes_product_is_syncable', $include, $product );
	}

	/**
	 * Types sent to SAILES. Filterable for custom product types (subscriptions, bundles).
	 *
	 * @return string[]
	 */
	public static function syncable_types() {
		return (array) apply_filters( 'sailes_syncable_product_types', self::TYPES );
	}

	/**
	 * Build the SAILES product.
	 *
	 * @param WC_Product $product Product.
	 * @return array
	 */
	public static function map( WC_Product $product ) {
		$id       = $product->get_id();
		$is_var   = $product instanceof WC_Product_Variable;
		$price    = $is_var ? $product->get_variation_price( 'min' ) : $product->get_price();
		$regular  = $is_var ? $product->get_variation_regular_price( 'min' ) : $product->get_regular_price();
		$url      = get_permalink( $id );
		$image_id = $product->get_image_id();

		$data = array(
			'id'          => (string) $id,
			'title'       => wp_strip_all_tags( $product->get_name() ),
			'description' => self::text( $product->get_description() ? $product->get_description() : $product->get_short_description() ),
			'price'       => '' === $price || null === $price ? null : (float) $price,
			'currency'    => get_woocommerce_currency(),
			'in_stock'    => $product->is_in_stock(),
			'categories'  => self::term_names( $id, 'product_cat' ),
			'tags'        => self::term_names( $id, 'product_tag' ),
			'attributes'  => self::attributes( $product ),
			'url'         => $url ? $url : null,
		);
		if ( '' !== (string) $regular && (float) $regular > (float) $price ) {
			$data['compare_at_price'] = (float) $regular;
		}
		if ( $product->managing_stock() && null !== $product->get_stock_quantity() ) {
			$data['stock_qty'] = (int) $product->get_stock_quantity();
		}
		$brand = self::brand( $product );
		if ( $brand ) {
			$data['brand'] = $brand;
		}
		if ( $product->get_review_count() > 0 ) {
			$data['rating']       = (float) $product->get_average_rating();
			$data['review_count'] = (int) $product->get_review_count();
		}
		if ( $image_id ) {
			$img = wp_get_attachment_image_url( $image_id, 'woocommerce_single' );
			if ( $img ) {
				$data['image_url'] = $img;
			}
		}
		// Direct add-to-cart link for simple products; others go to the product page to choose options.
		if ( $product->is_type( 'simple' ) && $product->is_purchasable() && $product->is_in_stock() ) {
			$data['add_to_cart_url'] = add_query_arg( 'add-to-cart', $id, $url ? $url : home_url( '/' ) );
		}
		if ( $is_var ) {
			$data['variants'] = self::variants( $product );
		}

		/**
		 * Filter the product sent to SAILES, for example to add custom fields as attributes.
		 *
		 * @param array      $data    SAILES product.
		 * @param WC_Product $product Product.
		 */
		return apply_filters( 'sailes_product_data', $data, $product );
	}

	/**
	 * Visible attributes as name => "value, value".
	 *
	 * @param WC_Product $product Product.
	 * @return array<string,string>
	 */
	private static function attributes( WC_Product $product ) {
		$out = array();
		foreach ( $product->get_attributes() as $attr ) {
			if ( ! $attr instanceof WC_Product_Attribute || ! $attr->get_visible() ) {
				continue;
			}
			$values = $attr->is_taxonomy()
				? wc_get_product_terms( $product->get_id(), $attr->get_name(), array( 'fields' => 'names' ) )
				: $attr->get_options();
			$values = array_filter( array_map( 'strval', (array) $values ), 'strlen' );
			if ( $values ) {
				$out[ self::attr_key( wc_attribute_label( $attr->get_name(), $product ) ) ] = implode( ', ', $values );
			}
		}
		return $out;
	}

	/**
	 * Up to 20 purchasable variations.
	 *
	 * @param WC_Product_Variable $product Parent.
	 * @return array
	 */
	private static function variants( WC_Product_Variable $product ) {
		$out = array();
		foreach ( $product->get_children() as $child_id ) {
			$v = wc_get_product( $child_id );
			if ( ! $v instanceof WC_Product_Variation || 'publish' !== $v->get_status() ) {
				continue;
			}
			$attrs = array();
			foreach ( $v->get_variation_attributes( false ) as $tax => $slug ) {
				$label = wc_attribute_label( $tax, $product );
				$value = $slug;
				if ( taxonomy_exists( $tax ) && '' !== $slug ) {
					$term  = get_term_by( 'slug', $slug, $tax );
					$value = $term ? $term->name : $slug;
				}
				$attrs[ self::attr_key( $label ) ] = '' === $value ? 'any' : $value;
			}
			$out[] = array(
				'id'         => (string) $child_id,
				'title'      => implode( ' / ', array_values( $attrs ) ),
				'price'      => '' === $v->get_price() ? null : (float) $v->get_price(),
				'in_stock'   => $v->is_in_stock(),
				'attributes' => $attrs,
			);
			if ( count( $out ) >= self::MAX_VARIANTS ) {
				break;
			}
		}
		return $out;
	}

	/**
	 * Brand from WooCommerce Brands (core since 9.6), common brand plugins, or a "brand" attribute.
	 *
	 * @param WC_Product $product Product.
	 * @return string
	 */
	private static function brand( WC_Product $product ) {
		$taxonomies = apply_filters( 'sailes_brand_taxonomies', array( 'product_brand', 'pwb-brand', 'yith_product_brand', 'pa_brand' ) );
		foreach ( $taxonomies as $tax ) {
			if ( taxonomy_exists( $tax ) ) {
				$names = self::term_names( $product->get_id(), $tax );
				if ( $names ) {
					return $names[0];
				}
			}
		}
		$custom = $product->get_attribute( 'brand' );
		return is_string( $custom ) ? trim( explode( ',', $custom )[0] ) : '';
	}

	/**
	 * Term names, parents before children.
	 *
	 * @param int    $id  Product id.
	 * @param string $tax Taxonomy.
	 * @return string[]
	 */
	private static function term_names( $id, $tax ) {
		$terms = get_the_terms( $id, $tax );
		if ( ! is_array( $terms ) ) {
			return array();
		}
		$names   = array();
		$default = 'product_cat' === $tax ? (int) get_option( 'default_product_cat', 0 ) : 0;
		foreach ( $terms as $t ) {
			if ( $t->term_id === $default ) {
				continue;
			}
			foreach ( array_reverse( get_ancestors( $t->term_id, $tax, 'taxonomy' ) ) as $a ) {
				$at = get_term( $a, $tax );
				if ( $at && ! is_wp_error( $at ) ) {
					$names[] = html_entity_decode( $at->name, ENT_QUOTES, 'UTF-8' );
				}
			}
			$names[] = html_entity_decode( $t->name, ENT_QUOTES, 'UTF-8' );
		}
		return array_values( array_unique( $names ) );
	}

	/**
	 * Attribute label to a key ("Pa Color" / "Color" -> "color").
	 *
	 * @param string $label Label.
	 * @return string
	 */
	private static function attr_key( $label ) {
		return strtolower( trim( html_entity_decode( wp_strip_all_tags( $label ), ENT_QUOTES, 'UTF-8' ) ) );
	}

	/**
	 * Plain text from post content: shortcodes, block markup and tags removed, paragraphs kept
	 * on their own lines, capped in size.
	 *
	 * @param string $html Content.
	 * @param int    $max  Maximum characters.
	 * @return string
	 */
	public static function text( $html, $max = 6000 ) {
		$html = preg_replace( '#</(p|li|h[1-6]|div|tr|blockquote)>|<br\s*/?>#i', "$0\n", strip_shortcodes( (string) $html ) );
		$text = html_entity_decode( wp_strip_all_tags( $html ), ENT_QUOTES, 'UTF-8' );
		$text = trim( preg_replace( array( '/[ \t]+/', '/\s*\n\s*/' ), array( ' ', "\n" ), $text ) );
		return function_exists( 'mb_substr' ) ? mb_substr( $text, 0, $max ) : substr( $text, 0, $max );
	}
}
