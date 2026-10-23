#!/bin/sh
# Build OpenWrt apk-v3 packages (for apk-based OpenWrt, 24.10 / 25.12+), using
# apk-tools 3's `apk mkpkg`. Produces, in dist/:
#   tpi-proxy-<ver>.apk
#   luci-app-envisalink-<ver>.apk
#
# These are the packages to upload via LuCI (System -> Software -> Upload Package)
# or install with `apk add --allow-untrusted <file>.apk`. Installing the luci-app
# pulls in tpi-proxy and the python3 deps automatically.
#
# Requirements (build host, not the router):
#   - apk-tools 3 with mkpkg. Set APK=/path/to/apk if it's not in PATH.
#     (Build it from https://gitlab.alpinelinux.org/alpine/apk-tools with meson.)
#   - fakeroot (so packaged files are owned by root:root).
set -e

VERSION=1.0.0
HERE=$(cd "$(dirname "$0")" && pwd)
SRC="$HERE/.."
LA="$HERE/luci-app/files"
OUT="$HERE/dist"
APK="${APK:-apk}"
# Sign with this key if present, so the packages install via LuCI's plain `apk add`
# (which omits --allow-untrusted) once the matching public key is trusted on the
# router. The private key is git-ignored; the .pub is committed and distributed.
KEY="${SIGN_KEY:-$HERE/keys/envisalink-pkg.rsa}"
mkdir -p "$OUT"

command -v "$APK" >/dev/null 2>&1 || { echo "ERROR: apk-tools 3 not found; set APK=/path/to/apk"; exit 1; }
command -v fakeroot >/dev/null 2>&1 || { echo "ERROR: fakeroot not found"; exit 1; }

MAINT="egite <139096069+egite@users.noreply.github.com>"

# ---- tpi-proxy ----
T=$(mktemp -d)
fakeroot sh -s "$T" "$SRC" "$HERE" "$APK" "$OUT" "$VERSION" "$MAINT" "$KEY" <<'EOS'
set -e
T="$1"; SRC="$2"; HERE="$3"; APK="$4"; OUT="$5"; VERSION="$6"; MAINT="$7"; KEY="$8"
SIGN=""; [ -n "$KEY" ] && [ -f "$KEY" ] && SIGN="--sign-key $KEY"
install -d -m0755 "$T/root/usr/bin" "$T/root/etc/init.d" "$T/root/etc/config"
install -m0755 "$SRC/tpi_proxy.py"       "$T/root/usr/bin/tpi_proxy.py"
install -m0755 "$SRC/evl-tpi-proxy.init" "$T/root/etc/init.d/evl-tpi-proxy"
install -m0600 "$HERE/config.envisalink" "$T/root/etc/config/envisalink"
chown -R root:root "$T/root"
"$APK" mkpkg \
	--info "name:tpi-proxy" \
	--info "version:$VERSION" \
	--info "arch:all" \
	--info "license:MIT" \
	--info "maintainer:$MAINT" \
	--info "description:EnvisaLink TPI multiplexing proxy" \
	--info "depends:python3-light python3-asyncio python3-logging" \
	--script "post-install:$HERE/postinst" \
	$SIGN \
	--files "$T/root" \
	--output "$OUT/tpi-proxy-$VERSION.apk"
EOS
rm -rf "$T"
echo "built: $OUT/tpi-proxy-$VERSION.apk"

# ---- luci-app-envisalink ----
T=$(mktemp -d)
fakeroot sh -s "$T" "$LA" "$HERE" "$APK" "$OUT" "$VERSION" "$MAINT" "$KEY" <<'EOS'
set -e
T="$1"; LA="$2"; HERE="$3"; APK="$4"; OUT="$5"; VERSION="$6"; MAINT="$7"; KEY="$8"
SIGN=""; [ -n "$KEY" ] && [ -f "$KEY" ] && SIGN="--sign-key $KEY"
mkdir -p "$T/root"
cp -a "$LA/." "$T/root/"
find "$T/root" -type d -exec chmod 0755 {} +
find "$T/root" -type f -exec chmod 0644 {} +
chown -R root:root "$T/root"
"$APK" mkpkg \
	--info "name:luci-app-envisalink" \
	--info "version:$VERSION" \
	--info "arch:all" \
	--info "license:MIT" \
	--info "maintainer:$MAINT" \
	--info "description:LuCI interface for the EnvisaLink TPI proxy" \
	--info "depends:luci-base tpi-proxy" \
	--script "post-install:$HERE/luci-app/postinst" \
	$SIGN \
	--files "$T/root" \
	--output "$OUT/luci-app-envisalink-$VERSION.apk"
EOS
rm -rf "$T"
echo "built: $OUT/luci-app-envisalink-$VERSION.apk"
