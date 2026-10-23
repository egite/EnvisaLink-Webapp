#!/bin/sh
# Build the OpenWrt .ipk packages by hand (no OpenWrt SDK needed - the proxy is
# pure Python and the LuCI app is just JS/JSON). Produces, in dist/:
#   tpi-proxy_<ver>_all.ipk            - the proxy + init + UCI config
#   luci-app-envisalink_<ver>_all.ipk  - Services -> Envisalink UI (pulls the above)
#
# Install luci-app-envisalink and opkg pulls tpi-proxy and the python3 deps too.
# Needs: ar (binutils), tar, gzip, sed, install.  Run it anywhere with those.
set -e

VERSION=1.0.0
HERE=$(cd "$(dirname "$0")" && pwd)
SRC="$HERE/.."                 # the tpi-proxy/ directory (proxy + init live here)
OUT="$HERE/dist"
mkdir -p "$OUT"

# build_ipk <package-name> <data-dir> <control-dir>
build_ipk() {
	bd=$(mktemp -d)
	tar --owner=0 --group=0 -C "$2" -czf "$bd/data.tar.gz" .
	tar --owner=0 --group=0 -C "$3" -czf "$bd/control.tar.gz" .
	printf '2.0\n' > "$bd/debian-binary"
	ipk="$OUT/$1_${VERSION}_all.ipk"
	rm -f "$ipk"
	( cd "$bd" && ar rc "$ipk" debian-binary control.tar.gz data.tar.gz )
	rm -rf "$bd"
	echo "built: $ipk"
}

# ---- tpi-proxy ----
D=$(mktemp -d); C=$(mktemp -d)
install -d -m0755 "$D/usr/bin" "$D/etc/init.d" "$D/etc/config"
install -m0755 "$SRC/tpi_proxy.py"       "$D/usr/bin/tpi_proxy.py"
install -m0755 "$SRC/evl-tpi-proxy.init" "$D/etc/init.d/evl-tpi-proxy"
install -m0600 "$HERE/config.envisalink" "$D/etc/config/envisalink"
chmod 0755 "$D"
sed "s/@VERSION@/$VERSION/" "$HERE/control" > "$C/control"
cp "$HERE/conffiles" "$C/conffiles"
install -m0755 "$HERE/postinst" "$C/postinst"
chmod 0644 "$C/control" "$C/conffiles"
build_ipk tpi-proxy "$D" "$C"
rm -rf "$D" "$C"

# ---- luci-app-envisalink ----
LA="$HERE/luci-app"
D=$(mktemp -d); C=$(mktemp -d)
cp -a "$LA/files/." "$D/"
find "$D" -type d -exec chmod 0755 {} +
find "$D" -type f -exec chmod 0644 {} +
sed "s/@VERSION@/$VERSION/" "$LA/control" > "$C/control"
install -m0755 "$LA/postinst" "$C/postinst"
chmod 0644 "$C/control"
build_ipk luci-app-envisalink "$D" "$C"
rm -rf "$D" "$C"
