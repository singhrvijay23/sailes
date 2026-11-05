#!/usr/bin/env bash
# Builds a throwaway WordPress + WooCommerce site (SQLite, no MySQL needed) with this plugin active,
# for tests/integration.php and for trying the plugin locally.
#
#   connectors/woocommerce/bin/setup-wordpress.sh /tmp/wp http://localhost:4000
#
# Then: php -S localhost:8080 -t /tmp/wp   (admin / admin123)
set -euo pipefail

DIR="${1:?usage: setup-wordpress.sh <dir> [sailes api url] [sailes console url]}"
API_URL="${2:-http://localhost:4000}"
CONSOLE_URL="${3:-http://localhost:3000}"
WP_HOME="${WP_HOME:-http://localhost:8080}"
WC_VERSION="${WC_VERSION:-10.3.0}"
PLUGIN_SRC="$(cd "$(dirname "$0")/../sailes" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd)"

if [ ! -f "$DIR/wp-load.php" ]; then
  curl -fsSL -o "$TMP/wp.zip" https://wordpress.org/latest.zip
  unzip -q "$TMP/wp.zip" -d "$TMP" && cp -r "$TMP/wordpress/." "$DIR/"
fi
PLUGINS="$DIR/wp-content/plugins"
if [ ! -d "$PLUGINS/woocommerce" ]; then
  curl -fsSL -o "$TMP/wc.zip" "https://github.com/woocommerce/woocommerce/releases/download/$WC_VERSION/woocommerce.zip"
  unzip -q "$TMP/wc.zip" -d "$PLUGINS"
fi
if [ ! -d "$PLUGINS/sqlite-database-integration" ]; then
  curl -fsSL -o "$TMP/sqlite.zip" https://downloads.wordpress.org/plugin/sqlite-database-integration.latest-stable.zip
  unzip -q "$TMP/sqlite.zip" -d "$PLUGINS"
fi
ln -sfn "$PLUGIN_SRC" "$PLUGINS/sailes"

SQLITE="$PLUGINS/sqlite-database-integration"
sed -e "s#{SQLITE_IMPLEMENTATION_FOLDER_PATH}#$SQLITE#" -e "s#{SQLITE_PLUGIN}#sqlite-database-integration/load.php#g" "$SQLITE/db.copy" > "$DIR/wp-content/db.php"

cat > "$DIR/wp-config.php" <<EOF
<?php
define( 'DB_NAME', 'wp' ); define( 'DB_USER', '' ); define( 'DB_PASSWORD', '' ); define( 'DB_HOST', 'localhost' );
define( 'DB_CHARSET', 'utf8' ); define( 'DB_COLLATE', '' );
define( 'DB_DIR', __DIR__ . '/wp-content/database/' ); define( 'DB_FILE', 'wp.sqlite' );
define( 'AUTH_KEY', '$(openssl rand -hex 24)' ); define( 'SECURE_AUTH_KEY', '$(openssl rand -hex 24)' );
define( 'LOGGED_IN_KEY', '$(openssl rand -hex 24)' ); define( 'NONCE_KEY', '$(openssl rand -hex 24)' );
define( 'AUTH_SALT', '$(openssl rand -hex 24)' ); define( 'SECURE_AUTH_SALT', '$(openssl rand -hex 24)' );
define( 'LOGGED_IN_SALT', '$(openssl rand -hex 24)' ); define( 'NONCE_SALT', '$(openssl rand -hex 24)' );
\$table_prefix = 'wp_';
define( 'WP_HOME', '$WP_HOME' ); define( 'WP_SITEURL', '$WP_HOME' );
define( 'WP_DEBUG', true ); define( 'WP_DEBUG_LOG', true ); define( 'WP_DEBUG_DISPLAY', false );
define( 'DISABLE_WP_CRON', true );
define( 'SAILES_API_URL', '$API_URL' ); define( 'SAILES_CONSOLE_URL', '$CONSOLE_URL' );
if ( ! defined( 'ABSPATH' ) ) { define( 'ABSPATH', __DIR__ . '/' ); }
require_once ABSPATH . 'wp-settings.php';
EOF

WP_DIR="$DIR" php -r '
  define( "WP_INSTALLING", true );
  $_SERVER["HTTP_HOST"] = "localhost";
  require getenv( "WP_DIR" ) . "/wp-load.php";
  require_once ABSPATH . "wp-admin/includes/upgrade.php";
  if ( ! is_blog_installed() ) { wp_install( "SAILES Test Shop", "admin", "admin@example.com", true, "", "admin123" ); }
'
WP_DIR="$DIR" php -r '
  $_SERVER["HTTP_HOST"] = "localhost";
  require getenv( "WP_DIR" ) . "/wp-load.php";
  require_once ABSPATH . "wp-admin/includes/plugin.php";
  foreach ( array( "woocommerce/woocommerce.php", "sailes/sailes.php" ) as $p ) {
    $r = activate_plugin( $p );
    if ( is_wp_error( $r ) ) { fwrite( STDERR, "$p: " . $r->get_error_message() . "\n" ); exit( 1 ); }
  }
'
WP_DIR="$DIR" php -r '
  $_SERVER["HTTP_HOST"] = "localhost";
  require getenv( "WP_DIR" ) . "/wp-load.php";
  WC_Install::install();
  update_option( "woocommerce_coming_soon", "no" );
'
echo "WordPress + WooCommerce + SAILES ready in $DIR. Serve it with: php -S ${WP_HOME#http://} -t $DIR  (admin / admin123)"
