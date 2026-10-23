#!/bin/sh
# Generate a self-contained installer, dist/install-openwrt.sh, from the canonical
# source files. Run that one script on the router (SSH or LuCI terminal) to install
# the TPI proxy + LuCI app on OpenWrt regardless of package manager (apk or opkg) -
# handy on apk-based OpenWrt (24.10+), where the .ipk cannot be uploaded.
#
# It installs the python3 deps, drops the files into place, enables the service and
# refreshes LuCI. It never overwrites an existing /etc/config/envisalink.
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
SRC="$HERE/.."
LA="$HERE/luci-app/files"
OUT="$HERE/dist/install-openwrt.sh"
mkdir -p "$HERE/dist"

# emit_file <marker> <target> <mode> <source>
emit_file() {
	printf "install -d -m0755 '%s'\n" "$(dirname "$3")" >> "$OUT"
	printf "cat > '%s' <<'%s'\n" "$3" "$1" >> "$OUT"
	cat "$4" >> "$OUT"
	# source files end with a newline, so the marker lands on its own line
	printf "%s\n" "$1" >> "$OUT"
	printf "chmod %s '%s'\n\n" "$2" "$3" >> "$OUT"
}

cat > "$OUT" <<'HEADER'
#!/bin/sh
# EnvisaLink TPI proxy + LuCI app installer for OpenWrt (apk or opkg).
# Run on the router:  sh install-openwrt.sh
set -e
echo "== EnvisaLink TPI proxy installer =="

echo "-- installing python3 dependencies --"
if command -v apk >/dev/null 2>&1; then
	apk update || true
	apk add python3-light python3-asyncio python3-logging
elif command -v opkg >/dev/null 2>&1; then
	opkg update
	opkg install python3-light python3-asyncio python3-logging
else
	echo "ERROR: neither apk nor opkg found"; exit 1
fi

echo "-- installing files --"
HEADER

emit_file __EOF_PROXY__   0755 /usr/bin/tpi_proxy.py                                          "$SRC/tpi_proxy.py"
emit_file __EOF_INIT__    0755 /etc/init.d/evl-tpi-proxy                                      "$SRC/evl-tpi-proxy.init"
emit_file __EOF_VIEW__    0644 /www/luci-static/resources/view/envisalink/settings.js         "$LA/www/luci-static/resources/view/envisalink/settings.js"
emit_file __EOF_MENU__    0644 /usr/share/luci/menu.d/luci-app-envisalink.json                "$LA/usr/share/luci/menu.d/luci-app-envisalink.json"
emit_file __EOF_ACL__     0644 /usr/share/rpcd/acl.d/luci-app-envisalink.json                 "$LA/usr/share/rpcd/acl.d/luci-app-envisalink.json"

# config is written only if it does not already exist (preserve user settings)
{
	printf "if [ ! -f /etc/config/envisalink ]; then\n"
	printf "install -d -m0755 /etc/config\n"
	printf "cat > /etc/config/envisalink <<'__EOF_CONFIG__'\n"
	cat "$HERE/config.envisalink"
	printf "__EOF_CONFIG__\n"
	printf "chmod 600 /etc/config/envisalink\nfi\n\n"
} >> "$OUT"

cat >> "$OUT" <<'FOOTER'
echo "-- refreshing LuCI and rpcd --"
rm -f /tmp/luci-indexcache* 2>/dev/null || true
rm -rf /tmp/luci-modulecache 2>/dev/null || true
/etc/init.d/rpcd reload 2>/dev/null || /etc/init.d/rpcd restart 2>/dev/null || true

/etc/init.d/evl-tpi-proxy enable 2>/dev/null || true

echo
echo "Done. Next:"
echo "  1. Open LuCI -> Services -> Envisalink (or edit /etc/config/envisalink)."
echo "  2. Set the EnvisaLink IP, password and panel type, enable, and Start."
echo "     Or from the shell: uci set envisalink.main.evl_host='192.168.21.123';"
echo "        uci set envisalink.main.evl_pass='SECRET'; uci set envisalink.main.panel='honeywell';"
echo "        uci commit envisalink; /etc/init.d/evl-tpi-proxy restart"
echo "  3. Watch:  logread -e tpi-proxy"
FOOTER

chmod +x "$OUT"
echo "generated: $OUT"
