#!/bin/sh
# Build the OpenWrt apk-v3 package (for apk-based OpenWrt, 24.10 / 25.12+), using
# apk-tools 3's `apk mkpkg`. Produces, in dist/:
#   luci-app-envisalink-<ver>.apk   - SELF-CONTAINED: the proxy, its service, the
#                                     UCI config AND the Services -> Envisalink UI,
#                                     in one package.
#
# It is a single upload on purpose. Its dependencies (python3-light, python3-asyncio,
# python3-logging, luci-base) are all in the OpenWrt feeds, so `apk add` resolves them
# automatically - no ordering, no "tpi-proxy: no such package" (the proxy files ship
# inside this package rather than as a separate feed-less dependency).
#
# These are what you upload via LuCI (System -> Software -> Upload Package) or install
# with `apk add --allow-untrusted <file>.apk`.
#
# Requirements (build host, not the router):
#   - apk-tools 3 with mkpkg. Set APK=/path/to/apk if it's not in PATH.
#   - fakeroot (so packaged files are owned by root:root).
set -e

VERSION="${VERSION:-1.0.0}"
HERE=$(cd "$(dirname "$0")" && pwd)
SRC="$HERE/.."
LA="$HERE/luci-app/files"
OUT="$HERE/dist"
APK="${APK:-apk}"
# Sign with this key if present, so the package installs via LuCI's plain `apk add`
# (which omits --allow-untrusted) once the matching public key is trusted on the router.
KEY="${SIGN_KEY:-$HERE/keys/envisalink-pkg.rsa}"
mkdir -p "$OUT"

command -v "$APK" >/dev/null 2>&1 || { echo "ERROR: apk-tools 3 not found; set APK=/path/to/apk"; exit 1; }
command -v fakeroot >/dev/null 2>&1 || { echo "ERROR: fakeroot not found"; exit 1; }

MAINT="egite <139096069+egite@users.noreply.github.com>"

T=$(mktemp -d)
fakeroot sh -s "$T" "$SRC" "$HERE" "$LA" "$APK" "$OUT" "$VERSION" "$MAINT" "$KEY" <<'EOS'
set -e
T="$1"; SRC="$2"; HERE="$3"; LA="$4"; APK="$5"; OUT="$6"; VERSION="$7"; MAINT="$8"; KEY="$9"
SIGN=""; [ -n "$KEY" ] && [ -f "$KEY" ] && SIGN="--sign-key $KEY"

# proxy + service + config
install -d -m0755 "$T/root/usr/bin" "$T/root/etc/init.d" "$T/root/etc/config"
install -m0755 "$SRC/tpi_proxy.py"       "$T/root/usr/bin/tpi_proxy.py"
install -m0755 "$SRC/evl-tpi-proxy.init" "$T/root/etc/init.d/evl-tpi-proxy"
install -m0600 "$HERE/config.envisalink" "$T/root/etc/config/envisalink"
# LuCI app (view, menu, acl)
cp -a "$LA/." "$T/root/"
find "$T/root/www" "$T/root/usr/share" -type d -exec chmod 0755 {} +
find "$T/root/www" "$T/root/usr/share" -type f -exec chmod 0644 {} +
chown -R root:root "$T/root"

"$APK" mkpkg \
	--info "name:luci-app-envisalink" \
	--info "version:$VERSION" \
	--info "arch:noarch" \
	--info "license:Unlicense" \
	--info "maintainer:$MAINT" \
	--info "description:EnvisaLink TPI proxy with a Services -> Envisalink LuCI page" \
	--info "depends:python3-light python3-asyncio python3-logging luci-base" \
	--script "post-install:$HERE/luci-app/postinst" \
	$SIGN \
	--files "$T/root" \
	--output "$OUT/luci-app-envisalink-$VERSION.apk"
EOS
rm -rf "$T"
echo "built: $OUT/luci-app-envisalink-$VERSION.apk"
