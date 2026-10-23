# EnvisaLink TPI proxy

The EnvisaLink accepts only **one** TPI client on port 4025. This proxy holds that
one connection and lets several clients — Home Assistant, this webapp, anything else
that speaks TPI — share it. Each client connects to the proxy as if it were the
EnvisaLink; the proxy fans out every panel message to all of them and forwards every
command upstream.

- Pure Python 3 standard library (asyncio), no dependencies.
- Emulates the session login (Honeywell `Login:`/`OK`, or DSC `505`/`005`) and
  replays the last state messages to a newly-connected client so it has current
  state immediately. Panel traffic is forwarded verbatim.
- Runs on an OpenWrt router or any always-on Linux host on the LAN.

See [`../docs/multi-client-access.md`](../docs/multi-client-access.md) for why this
exists and the alternative (HTTP) approach.

## Run it (quick test)

```bash
python3 tpi_proxy.py --evl-host 192.168.21.123 --evl-pass SECRET --panel honeywell
```

Then point a client at `this-host:4025`. Flags (or the matching env vars
`EVL_HOST`, `EVL_PASS`, `PANEL`, `LISTEN_HOST`, `LISTEN_PORT`, `CLIENT_PASS`,
`KEEPALIVE`): `--help` lists them. `--panel` is `honeywell` or `dsc`.

## Which OpenWrt? apk vs opkg

- **OpenWrt 24.10 / 25.12 and newer use `apk`.** Use the **`.apk` packages** below.
  The `.ipk` files are the old opkg format and `apk` rejects them ("file format is
  invalid").
- **OpenWrt 23.05 and older use `opkg`.** Use the `.ipk` packages (further down).

Check with `apk --version` vs `opkg --version` on the router.

## Install on apk-based OpenWrt (24.10 / 25.12+) — .apk packages

Prebuilt, signed, noarch packages are in [`openwrt-package/dist/`](openwrt-package/dist/):
`luci-app-envisalink-1.0.0.apk` and `tpi-proxy-1.0.0.apk`. Rebuild with
`openwrt-package/build-apk.sh` (needs apk-tools 3 + fakeroot). They're signed with the
key in `openwrt-package/keys/` so LuCI's uploader (which runs a plain `apk add`)
accepts them.

**One-time: trust the signing key** (apk refuses unsigned uploads). Copy the public key
to the router's key store — over SSH:

```sh
scp openwrt-package/keys/envisalink-pkg.rsa.pub root@ROUTER:/etc/apk/keys/
```

**Then, for this install and every future update, via LuCI:** **System → Software →
Upload Package…**, choose `luci-app-envisalink-1.0.0.apk`. apk pulls in its
dependencies automatically — `tpi-proxy` and the python3 modules (`python3-light`,
`python3-asyncio`, `python3-logging`) — from the feeds, so make sure package lists are
updated (**Update lists…**) and the router has internet.

Then open **Services → Envisalink**, set the EnvisaLink IP / password / panel type,
enable, **Save & Apply**, and **Start**.

> **Prefer not to trust a key?** Install over SSH instead, which allows unsigned:
> `apk add --allow-untrusted ./luci-app-envisalink-1.0.0.apk` (after copying the file
> to the router). Or use the installer script below, which needs no package at all.

## Install on any OpenWrt — installer script (no package)

[`openwrt-package/dist/install-openwrt.sh`](openwrt-package/dist/) is a single,
self-contained script (regenerate with `openwrt-package/build-installer.sh`). It works
on both apk and opkg: it installs the python3 dependencies, drops the proxy, init
script, UCI config and the LuCI app into place, enables the service and refreshes
LuCI. It does **not** overwrite an existing `/etc/config/envisalink`.

Copy it to the router and run it (SSH, or LuCI's terminal if installed):

```sh
sh install-openwrt.sh
```

Then open **Services → Envisalink**, set the EnvisaLink IP / password / panel type,
enable, Save & Apply, and Start.

## Install on opkg-based OpenWrt (≤23.05) — package + LuCI menu

Two prebuilt, noarch packages are in [`openwrt-package/dist/`](openwrt-package/dist/):
`tpi-proxy_1.0.0_all.ipk` (the proxy) and `luci-app-envisalink_1.0.0_all.ipk` (a
**Services → Envisalink** page to configure it and start/stop/restart it). Rebuild
both anytime with `openwrt-package/build-ipk.sh` (needs only `ar`, `tar`, `sed` — no
OpenWrt SDK).

1. **Update the package lists** so opkg can pull dependencies — LuCI: **System →
   Software → Update lists…**, or `opkg update`.
2. **Upload `luci-app-envisalink_1.0.0_all.ipk`** in **System → Software → Upload
   Package…**. opkg automatically installs its dependencies: `tpi-proxy` and the
   python3 modules (`python3-light`, `python3-asyncio`, `python3-logging`). The
   router needs internet and a few MB of flash for python3 (use extroot/USB if tight).
3. Open **Services → Envisalink**, fill in the EnvisaLink **IP**, **password** and
   **panel type** (Honeywell), tick **Enabled**, and **Save & Apply**.
4. Use the **Start / Restart** buttons on that page. The status line shows whether
   it's running. `logread -e tpi-proxy` shows the connection log.

> If you'd rather not use LuCI, upload just `tpi-proxy_1.0.0_all.ipk` and configure
> with UCI: `uci set envisalink.main.evl_host=...`, `uci set envisalink.main.evl_pass=...`,
> `uci set envisalink.main.panel=honeywell`, `uci commit`, then
> `/etc/init.d/evl-tpi-proxy enable && /etc/init.d/evl-tpi-proxy start`.
> `/etc/config/envisalink` is a conffile, so settings survive upgrades. If the python3
> deps aren't fetched automatically, run step 1 then
> `opkg install python3-light python3-asyncio python3-logging`.

## Install on OpenWrt — manual copy (alternative)

```sh
opkg update && opkg install python3-light python3-asyncio python3-logging
# then copy, over scp/ssh:
#   tpi_proxy.py                        -> /usr/bin/tpi_proxy.py
#   evl-tpi-proxy.init                  -> /etc/init.d/evl-tpi-proxy
#   openwrt-package/config.envisalink   -> /etc/config/envisalink   (then edit, chmod 600)
chmod +x /usr/bin/tpi_proxy.py /etc/init.d/evl-tpi-proxy
chmod 600 /etc/config/envisalink
# set evl_host / evl_pass / panel in /etc/config/envisalink (uci), then:
/etc/init.d/evl-tpi-proxy enable && /etc/init.d/evl-tpi-proxy start
logread -e tpi-proxy
```

## Install on a Linux host (e.g. the Ubuntu box)

```bash
sudo cp tpi_proxy.py /usr/local/bin/tpi_proxy.py
sudo cp tpi-proxy.conf.example /etc/tpi-proxy.conf   # edit it, then: sudo chmod 600 /etc/tpi-proxy.conf
sudo cp evl-tpi-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now evl-tpi-proxy
journalctl -u evl-tpi-proxy -f
```

## Point your clients at the proxy

Both clients now use the **proxy's IP** on port 4025, with the **same EnvisaLink
password** they already use (that's the default `CLIENT_PASS`):

- **This webapp**: Settings → Connection → set *IP* to the proxy's address (port
  4025), keep the password, set panel type to Honeywell. Save & reconnect.
- **Home Assistant**: change the `envisalink` integration's `host` to the proxy's
  address and restart. HA releases the EnvisaLink; the proxy takes the one real
  connection; both clients run.

Switch them over one at a time so the proxy can grab the EnvisaLink once HA lets go.

## Notes

- Only ONE proxy per EnvisaLink (it is the single TPI client). Run exactly one
  instance.
- Keep `/etc/tpi-proxy.conf` readable only by root — it has the password. It's not
  in git.
- A client command's ack (e.g. a `^..` response) is broadcast to all clients; TPI
  clients ignore acks they didn't ask for, so this is harmless.
- If the upstream connection drops, the proxy reconnects automatically and keeps
  your clients connected.
