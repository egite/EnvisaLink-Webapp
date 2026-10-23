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
install -d -m0755 '/usr/bin'
cat > '/usr/bin/tpi_proxy.py' <<'__EOF_PROXY__'
#!/usr/bin/env python3
"""
EnvisaLink TPI multiplexing proxy.

The EnvisaLink accepts only one TPI client on port 4025. This proxy holds that one
connection and presents its own listening port that several clients (Home Assistant,
this webapp, ...) connect to and share.

It is transparent for panel traffic: every message the EnvisaLink sends is fanned
out to all logged-in clients verbatim, and every command a client sends is forwarded
upstream verbatim. The only protocol-specific part is the *session login*, which the
proxy emulates for each client (Honeywell `Login:`/`OK`, or DSC `505`/`005`). When a
new client logs in, the proxy replays the last cached state messages so it has
current state right away.

Pure standard library (asyncio) - no dependencies. Runs on an OpenWrt router
(python3-light) or any always-on LAN host. Configure with flags or env vars:

  EVL_HOST, EVL_PORT, EVL_PASS, LISTEN_HOST, LISTEN_PORT, CLIENT_PASS, PANEL

  tpi_proxy.py --evl-host 192.168.21.123 --evl-pass SECRET --panel honeywell
"""

import argparse
import asyncio
import logging
import os
import sys

log = logging.getLogger("tpi-proxy")

CRLF = b"\r\n"


def _dsc_checksum(payload: bytes) -> bytes:
    total = sum(payload) & 0xFF
    return ("%02X" % total).encode("ascii")


def _dsc_frame(cmd: str, data: str = "") -> bytes:
    payload = (cmd + data).encode("ascii")
    return payload + _dsc_checksum(payload) + CRLF


class HoneywellProfile:
    """Text login: EVL sends 'Login:', client sends password, EVL replies 'OK'."""
    name = "honeywell"
    # Messages whose latest copy is worth replaying to a new client (current state).
    cache_prefixes = (b"%00", b"%02", b"%FF")
    refresh_cmd = b"^02,$" + CRLF        # dump zone timers -> fresh %FF
    poll_cmd = b"^00,$" + CRLF           # keepalive / watchdog poll

    def cache_key(self, line: bytes):
        head = line.split(b",", 1)[0].strip()
        return head if head in self.cache_prefixes else None

    async def login_upstream(self, reader, writer, password):
        # Read line-by-line so the stream buffer keeps any state message the EVL
        # sends immediately after "OK" for the main read loop.
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=15)
            if not line:
                raise ConnectionError("EVL closed during login")
            if b"Login:" in line:
                break
        writer.write(password.encode("ascii") + CRLF)
        await writer.drain()
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=15)
            if not line:
                raise ConnectionError("EVL closed during login")
            if b"OK" in line:
                return
            if b"FAILED" in line or b"Timed Out" in line:
                raise ConnectionError("EVL rejected password")

    async def login_downstream(self, reader, writer, client_pass):
        writer.write(b"Login:" + CRLF)
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), timeout=30)
        if not line:
            return False
        given = line.strip().decode("ascii", "ignore")
        if client_pass and given != client_pass:
            writer.write(b"FAILED" + CRLF)
            await writer.drain()
            return False
        writer.write(b"OK" + CRLF)
        await writer.drain()
        return True


class DscProfile:
    """Numeric login: EVL sends 505|3, client sends 005|pass, EVL replies 505|1."""
    name = "dsc"
    cache_prefixes = ()
    refresh_cmd = _dsc_frame("001")      # status report -> rebroadcast of state
    poll_cmd = _dsc_frame("000")         # keepalive / watchdog poll

    def cache_key(self, line: bytes):
        return None

    async def login_upstream(self, reader, writer, password):
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=15)
            if not line:
                raise ConnectionError("EVL closed during login")
            if line.startswith(b"505") and line[3:4] == b"3":
                break
        writer.write(_dsc_frame("005", password))
        await writer.drain()
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=15)
            if not line:
                raise ConnectionError("EVL closed during login")
            if line.startswith(b"505"):
                if line[3:4] == b"1":
                    return
                if line[3:4] in (b"0", b"2"):
                    raise ConnectionError("EVL rejected password")

    async def login_downstream(self, reader, writer, client_pass):
        writer.write(_dsc_frame("505", "3"))
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), timeout=30)
        if not line or not line.startswith(b"005"):
            writer.write(_dsc_frame("505", "0"))
            await writer.drain()
            return False
        given = line[3:-4].decode("ascii", "ignore")   # strip 005 ... CKS CRLF
        if client_pass and given != client_pass:
            writer.write(_dsc_frame("505", "0"))
            await writer.drain()
            return False
        writer.write(_dsc_frame("505", "1"))
        await writer.drain()
        return True


PROFILES = {"honeywell": HoneywellProfile, "dsc": DscProfile}


class Proxy:
    def __init__(self, evl_host, evl_port, evl_pass, listen_host, listen_port,
                 client_pass, profile, keepalive):
        self.evl_host = evl_host
        self.evl_port = evl_port
        self.evl_pass = evl_pass
        self.listen_host = listen_host
        self.listen_port = listen_port
        self.client_pass = client_pass
        self.profile = profile
        self.keepalive = keepalive

        self.clients = set()             # writers of logged-in clients
        self.upstream_writer = None
        self.cache = {}                  # prefix -> last raw line

    # ---- upstream (the one real EnvisaLink connection) ----------------------

    async def upstream_loop(self):
        while True:
            try:
                await self._run_upstream()
            except Exception as e:  # noqa: BLE001
                log.warning("upstream connection failed: %s", e)
            self.upstream_writer = None
            await asyncio.sleep(5)

    async def _run_upstream(self):
        log.info("connecting to EnvisaLink %s:%s", self.evl_host, self.evl_port)
        reader, writer = await asyncio.open_connection(self.evl_host, self.evl_port)
        await self.profile.login_upstream(reader, writer, self.evl_pass)
        self.upstream_writer = writer
        log.info("logged in to EnvisaLink; %d client(s) connected", len(self.clients))
        ka = asyncio.create_task(self._keepalive(writer))
        try:
            while True:
                line = await reader.readline()
                if not line:
                    raise ConnectionError("EVL closed the connection")
                key = self.profile.cache_key(line)
                if key:
                    self.cache[key] = line
                self._broadcast(line)
        finally:
            ka.cancel()
            writer.close()

    async def _keepalive(self, writer):
        # Clients send their own keepalives (forwarded upstream); this is a backstop
        # so the EnvisaLink watchdog never fires even if every client is idle.
        while True:
            await asyncio.sleep(self.keepalive)
            try:
                writer.write(self.profile.poll_cmd)
                await writer.drain()
            except Exception:  # noqa: BLE001
                return

    def _broadcast(self, line):
        for w in list(self.clients):
            try:
                w.write(line)
            except Exception:  # noqa: BLE001
                self.clients.discard(w)

    # ---- downstream (clients sharing the connection) ------------------------

    async def handle_client(self, reader, writer):
        peer = writer.get_extra_info("peername")
        try:
            ok = await self.profile.login_downstream(reader, writer, self.client_pass)
            if not ok:
                log.info("client %s failed login", peer)
                writer.close()
                return
            self.clients.add(writer)
            log.info("client %s logged in (%d total)", peer, len(self.clients))

            # Give the new client current state: replay cached messages and ask
            # the panel to re-send state.
            for line in self.cache.values():
                writer.write(line)
            await writer.drain()
            if self.upstream_writer is not None:
                try:
                    self.upstream_writer.write(self.profile.refresh_cmd)
                    await self.upstream_writer.drain()
                except Exception:  # noqa: BLE001
                    pass

            while True:
                line = await reader.readline()
                if not line:
                    break
                if self.upstream_writer is not None:
                    self.upstream_writer.write(line)
                    await self.upstream_writer.drain()
                else:
                    log.debug("dropping client command; upstream down")
        except (asyncio.IncompleteReadError, ConnectionError, asyncio.TimeoutError):
            pass
        except Exception:  # noqa: BLE001
            log.exception("client %s error", peer)
        finally:
            self.clients.discard(writer)
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass
            log.info("client %s disconnected (%d left)", peer, len(self.clients))

    async def run(self):
        server = await asyncio.start_server(self.handle_client, self.listen_host, self.listen_port)
        asyncio.create_task(self.upstream_loop())
        log.info("listening on %s:%s (panel=%s)", self.listen_host, self.listen_port, self.profile.name)
        async with server:
            await server.serve_forever()


def main(argv=None):
    ap = argparse.ArgumentParser(description="EnvisaLink TPI multiplexing proxy")
    ap.add_argument("--evl-host", default=os.environ.get("EVL_HOST"))
    ap.add_argument("--evl-port", type=int, default=int(os.environ.get("EVL_PORT", "4025")))
    ap.add_argument("--evl-pass", default=os.environ.get("EVL_PASS"))
    ap.add_argument("--listen-host", default=os.environ.get("LISTEN_HOST", "0.0.0.0"))
    ap.add_argument("--listen-port", type=int, default=int(os.environ.get("LISTEN_PORT", "4025")))
    ap.add_argument("--client-pass", default=os.environ.get("CLIENT_PASS"),
                    help="password clients must send (default: same as --evl-pass)")
    ap.add_argument("--panel", default=os.environ.get("PANEL", "honeywell"), choices=list(PROFILES))
    ap.add_argument("--keepalive", type=int, default=int(os.environ.get("KEEPALIVE", "120")))
    ap.add_argument("--log-level", default=os.environ.get("LOG_LEVEL", "INFO"))
    args = ap.parse_args(argv)

    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    if not args.evl_host or not args.evl_pass:
        ap.error("--evl-host and --evl-pass are required (or set EVL_HOST / EVL_PASS)")

    proxy = Proxy(
        evl_host=args.evl_host, evl_port=args.evl_port, evl_pass=args.evl_pass,
        listen_host=args.listen_host, listen_port=args.listen_port,
        client_pass=args.client_pass if args.client_pass is not None else args.evl_pass,
        profile=PROFILES[args.panel](), keepalive=args.keepalive,
    )
    try:
        asyncio.run(proxy.run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
__EOF_PROXY__
chmod 0755 '/usr/bin/tpi_proxy.py'

install -d -m0755 '/etc/init.d'
cat > '/etc/init.d/evl-tpi-proxy' <<'__EOF_INIT__'
#!/bin/sh /etc/rc.common
# OpenWrt procd init script for the EnvisaLink TPI proxy.
#
# Configuration is read from UCI (/etc/config/envisalink), which the LuCI app
# edits. If that isn't populated it falls back to /etc/tpi-proxy.conf (the
# manual / systemd-style env file).
#
# Logs: logread -e tpi-proxy

USE_PROCD=1
START=95
STOP=10

start_service() {
    local evl_host evl_port evl_pass panel listen_host listen_port client_pass keepalive enabled

    config_load envisalink
    config_get      evl_host    main evl_host
    config_get      evl_port    main evl_port    4025
    config_get      evl_pass    main evl_pass
    config_get      panel       main panel       honeywell
    config_get      listen_host main listen_host 0.0.0.0
    config_get      listen_port main listen_port 4025
    config_get      client_pass main client_pass
    config_get      keepalive   main keepalive   120
    config_get_bool enabled     main enabled     1

    # Fall back to the env file when UCI has no host (non-LuCI installs).
    if [ -z "$evl_host" ] && [ -f /etc/tpi-proxy.conf ]; then
        . /etc/tpi-proxy.conf
        evl_host="${EVL_HOST}"
        evl_port="${EVL_PORT:-$evl_port}"
        evl_pass="${EVL_PASS}"
        panel="${PANEL:-$panel}"
        listen_host="${LISTEN_HOST:-$listen_host}"
        listen_port="${LISTEN_PORT:-$listen_port}"
        client_pass="${CLIENT_PASS:-$client_pass}"
        keepalive="${KEEPALIVE:-$keepalive}"
    fi

    [ "$enabled" = "1" ] || { echo "tpi-proxy: disabled in config"; return 0; }
    if [ -z "$evl_host" ] || [ -z "$evl_pass" ]; then
        echo "tpi-proxy: set the EnvisaLink IP and password first"
        return 1
    fi

    procd_open_instance
    procd_set_param command /usr/bin/python3 /usr/bin/tpi_proxy.py \
        --evl-host "$evl_host" --evl-port "$evl_port" --evl-pass "$evl_pass" \
        --panel "$panel" --listen-host "$listen_host" --listen-port "$listen_port" \
        --keepalive "$keepalive"
    [ -n "$client_pass" ] && procd_append_param command --client-pass "$client_pass"
    procd_set_param respawn
    procd_set_param stdout 1
    procd_set_param stderr 1
    procd_close_instance
}

service_triggers() {
    procd_add_reload_trigger "envisalink"
}
__EOF_INIT__
chmod 0755 '/etc/init.d/evl-tpi-proxy'

install -d -m0755 '/www/luci-static/resources/view/envisalink'
cat > '/www/luci-static/resources/view/envisalink/settings.js' <<'__EOF_VIEW__'
'use strict';
'require view';
'require form';
'require rpc';
'require fs';
'require ui';

var callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: ['name'],
	expect: { '': {} }
});

function getRunning() {
	return L.resolveDefault(callServiceList('evl-tpi-proxy'), {}).then(function(res) {
		try {
			var inst = res['evl-tpi-proxy'].instances;
			for (var k in inst)
				if (inst[k].running)
					return true;
		} catch (e) {}
		return false;
	});
}

function runAction(action) {
	return fs.exec('/etc/init.d/evl-tpi-proxy', [action]).then(function(res) {
		if (res.code === 0)
			ui.addNotification(null, E('p', _('EnvisaLink proxy: %s').format(action)), 'info');
		else
			ui.addNotification(null, E('p', _('Action "%s" failed (code %d)').format(action, res.code)), 'danger');
	}).catch(function(e) {
		ui.addNotification(null, E('p', _('Action failed: %s').format(e)), 'danger');
	});
}

return view.extend({
	load: function() {
		return getRunning();
	},

	render: function(running) {
		var m, s, o;

		m = new form.Map('envisalink', _('EnvisaLink TPI Proxy'),
			_('Shares the EnvisaLink\'s single TPI connection so Home Assistant and the web app can both use it. ' +
			  'Point each client at this router on the listen port below, using the EnvisaLink password.'));

		/* ---- service status + controls ---- */
		s = m.section(form.NamedSection, 'main', 'envisalink', _('Service'));
		s.anonymous = true;

		o = s.option(form.DummyValue, '_status', _('Status'));
		o.cfgvalue = function() {
			return running
				? E('span', { 'style': 'color:#2e8b57;font-weight:bold' }, _('Running'))
				: E('span', { 'style': 'color:#b00;font-weight:bold' }, _('Stopped'));
		};

		o = s.option(form.Button, '_start', _('Start'));
		o.inputtitle = _('Start');
		o.inputstyle = 'apply';
		o.onclick = function() { return runAction('start'); };

		o = s.option(form.Button, '_stop', _('Stop'));
		o.inputtitle = _('Stop');
		o.inputstyle = 'remove';
		o.onclick = function() { return runAction('stop'); };

		o = s.option(form.Button, '_restart', _('Restart'));
		o.inputtitle = _('Restart');
		o.inputstyle = 'reload';
		o.onclick = function() { return runAction('restart'); };

		/* ---- settings ---- */
		s = m.section(form.NamedSection, 'main', 'envisalink', _('Settings'));
		s.anonymous = true;

		o = s.option(form.Flag, 'enabled', _('Enabled'), _('Start the proxy at boot.'));
		o.rmempty = false;

		o = s.option(form.Value, 'evl_host', _('EnvisaLink IP address'));
		o.datatype = 'host';
		o.rmempty = false;

		o = s.option(form.Value, 'evl_port', _('EnvisaLink port'));
		o.datatype = 'port';
		o.placeholder = '4025';

		o = s.option(form.Value, 'evl_pass', _('EnvisaLink password'));
		o.password = true;
		o.rmempty = false;

		o = s.option(form.ListValue, 'panel', _('Panel type'));
		o.value('honeywell', _('Honeywell / Vista'));
		o.value('dsc', _('DSC'));

		o = s.option(form.Value, 'listen_port', _('Listen port'),
			_('Point Home Assistant and the web app at this router on this port.'));
		o.datatype = 'port';
		o.placeholder = '4025';

		o = s.option(form.Value, 'listen_host', _('Listen address'));
		o.datatype = 'ipaddr';
		o.placeholder = '0.0.0.0';
		o.optional = true;

		o = s.option(form.Value, 'client_pass', _('Client password'),
			_('Password clients must send. Leave blank to require the EnvisaLink password.'));
		o.password = true;
		o.optional = true;

		o = s.option(form.Value, 'keepalive', _('Keepalive (seconds)'));
		o.datatype = 'uinteger';
		o.placeholder = '120';
		o.optional = true;

		return m.render();
	}
});
__EOF_VIEW__
chmod 0644 '/www/luci-static/resources/view/envisalink/settings.js'

install -d -m0755 '/usr/share/luci/menu.d'
cat > '/usr/share/luci/menu.d/luci-app-envisalink.json' <<'__EOF_MENU__'
{
	"admin/services/envisalink": {
		"title": "Envisalink",
		"order": 60,
		"action": {
			"type": "view",
			"path": "envisalink/settings"
		},
		"depends": {
			"acl": [ "luci-app-envisalink" ]
		}
	}
}
__EOF_MENU__
chmod 0644 '/usr/share/luci/menu.d/luci-app-envisalink.json'

install -d -m0755 '/usr/share/rpcd/acl.d'
cat > '/usr/share/rpcd/acl.d/luci-app-envisalink.json' <<'__EOF_ACL__'
{
	"luci-app-envisalink": {
		"description": "Grant access to the EnvisaLink TPI proxy",
		"read": {
			"uci": [ "envisalink" ],
			"ubus": {
				"service": [ "list" ]
			},
			"file": {
				"/etc/init.d/evl-tpi-proxy": [ "exec" ]
			}
		},
		"write": {
			"uci": [ "envisalink" ],
			"file": {
				"/etc/init.d/evl-tpi-proxy": [ "exec" ]
			}
		}
	}
}
__EOF_ACL__
chmod 0644 '/usr/share/rpcd/acl.d/luci-app-envisalink.json'

if [ ! -f /etc/config/envisalink ]; then
install -d -m0755 /etc/config
cat > /etc/config/envisalink <<'__EOF_CONFIG__'
config envisalink 'main'
	option evl_host ''
	option evl_port '4025'
	option evl_pass ''
	option panel 'honeywell'
	option listen_host '0.0.0.0'
	option listen_port '4025'
	option client_pass ''
	option keepalive '120'
	option enabled '1'
__EOF_CONFIG__
chmod 600 /etc/config/envisalink
fi

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
