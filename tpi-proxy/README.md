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

## Install on OpenWrt

Your router needs room for `python3-light` (a few MB of flash; use extroot/USB on
small devices, or port the ~250 lines to Lua/C if space is tight).

```sh
opkg update && opkg install python3-light
```

Copy the files onto the router:

```sh
# from this directory, over scp/ssh:
#   tpi_proxy.py            -> /usr/bin/tpi_proxy.py
#   evl-tpi-proxy.init      -> /etc/init.d/evl-tpi-proxy
#   tpi-proxy.conf.example  -> /etc/tpi-proxy.conf   (then edit, chmod 600)
chmod +x /usr/bin/tpi_proxy.py /etc/init.d/evl-tpi-proxy
chmod 600 /etc/tpi-proxy.conf
/etc/init.d/evl-tpi-proxy enable
/etc/init.d/evl-tpi-proxy start
logread -e tpi-proxy
```

Edit `/etc/tpi-proxy.conf` with your EnvisaLink IP, password, and `PANEL=honeywell`.

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
