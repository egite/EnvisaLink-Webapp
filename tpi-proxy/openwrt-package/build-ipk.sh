#!/bin/sh
# Build a noarch OpenWrt .ipk for the TPI proxy, by hand (no OpenWrt SDK needed -
# the proxy is pure Python). Produces dist/tpi-proxy_<version>_all.ipk, which you
# can install with  opkg install  or upload via LuCI (System -> Software).
#
# Needs: ar (binutils), tar, gzip, sed.  Run it anywhere with those tools.
set -e

VERSION=1.0.0
PKG=tpi-proxy

HERE=$(cd "$(dirname "$0")" && pwd)
SRC="$HERE/.."                 # the tpi-proxy/ directory
OUT="$HERE/dist"
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
mkdir -p "$OUT"

# ---- data.tar.gz: the files as they install on the router ----
install -d -m0755 "$BUILD/data/usr/bin" "$BUILD/data/etc/init.d" "$BUILD/data/etc"
install -m0755 "$SRC/tpi_proxy.py"           "$BUILD/data/usr/bin/tpi_proxy.py"
install -m0755 "$SRC/evl-tpi-proxy.init"     "$BUILD/data/etc/init.d/evl-tpi-proxy"
install -m0600 "$SRC/tpi-proxy.conf.example" "$BUILD/data/etc/tpi-proxy.conf"

# ---- control.tar.gz: package metadata + scripts ----
mkdir -p "$BUILD/control"
sed "s/@VERSION@/$VERSION/" "$HERE/control" > "$BUILD/control/control"
cp "$HERE/conffiles" "$BUILD/control/conffiles"
install -m0755 "$HERE/postinst" "$BUILD/control/postinst"
chmod 0644 "$BUILD/control/control" "$BUILD/control/conffiles"

# ---- assemble (root-owned tars, gzip; ar member order matters) ----
tar --owner=0 --group=0 -C "$BUILD/data"    -czf "$BUILD/data.tar.gz" .
tar --owner=0 --group=0 -C "$BUILD/control" -czf "$BUILD/control.tar.gz" .
printf '2.0\n' > "$BUILD/debian-binary"

IPK="$OUT/${PKG}_${VERSION}_all.ipk"
rm -f "$IPK"
( cd "$BUILD" && ar rc "$IPK" debian-binary control.tar.gz data.tar.gz )

echo "built: $IPK"
