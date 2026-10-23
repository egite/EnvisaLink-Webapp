# Installing & upgrading on OpenWrt (apk)

How to install `luci-app-envisalink` on a fresh OpenWrt router, and how to upgrade it
later. This is the single, self-contained package: it installs the EnvisaLink TPI proxy,
its service, the UCI config and the **Services → Envisalink** LuCI page, and pulls in its
dependencies (`python3-light`, `python3-asyncio`, `python3-logging`, `luci-base`) from
the OpenWrt feeds.

Applies to **apk-based OpenWrt** (24.10 / 25.12 and newer — check with `apk --version`).
For older, opkg-based OpenWrt (≤ 23.05), use the `.ipk` packages or the installer script
described in [README.md](README.md).

You need:

- The package file, e.g. `luci-app-envisalink-1.0.0.apk`.
- `envisalink-pkg.rsa.pub` — the signing public key (only for the LuCI-upload method).
- The router **online** (so apk can fetch the dependencies from the feeds).

---

## Fresh install

### Method A — LuCI upload (recommended)

**1. Trust the signing key (one time only).** apk refuses *unsigned* packages uploaded
through LuCI, and this package is signed. Install the public key on the router so apk
trusts it. Over SSH from where the `.pub` file is:

```sh
scp envisalink-pkg.rsa.pub root@ROUTER:/etc/apk/keys/
```

You only do this once. Every future upgrade is signed with the same key, so it just
works — no need to repeat this step.

**2. Update package lists.** In LuCI: **System → Software → Update lists…** (or `apk
update` over SSH). This lets apk find the dependencies in the feeds.

**3. Upload the package.** **System → Software → Upload Package…**, choose
`luci-app-envisalink-<version>.apk`, and install. apk automatically pulls in
`python3-light`, `python3-asyncio`, `python3-logging` and `luci-base`.

**4. Configure.** Open **Services → Envisalink** and set:

- **EnvisaLink IP address** and **password** (the EnvisaLink's local password — must be
  changed from the default `user`, or its firewall blocks the connection).
- **Panel type** — Honeywell/Vista or DSC.
- Tick **Enabled**, then **Save & Apply**, then click **Start**.

**5. Point your clients at the router.** Set Home Assistant (and the EnvisaLink web app,
if you use it) to connect to the **router's IP on port 4025**, with the EnvisaLink
password. They now share the one real EnvisaLink connection through the proxy.

**6. Verify.** Over SSH: `logread -e tpi-proxy` should show
`logged in to EnvisaLink`. The status line on the Services → Envisalink page shows
**Running**.

### Method B — SSH (no key to trust)

```sh
scp luci-app-envisalink-<version>.apk root@ROUTER:/tmp/
ssh root@ROUTER 'apk update && apk add --allow-untrusted /tmp/luci-app-envisalink-<version>.apk'
```

`--allow-untrusted` skips the signature check, so you don't need the key. Then configure
as in steps 4–6 above (or with `uci`):

```sh
uci set envisalink.main.evl_host='192.168.21.123'
uci set envisalink.main.evl_pass='YOUR_EVL_PASSWORD'
uci set envisalink.main.panel='honeywell'       # or 'dsc'
uci set envisalink.main.enabled='1'
uci commit envisalink
/etc/init.d/evl-tpi-proxy enable
/etc/init.d/evl-tpi-proxy restart
```

---

## Upgrade (package already installed)

An upgrade is the same upload — apk replaces the installed version in place and **keeps
your settings**.

**1. No need to re-trust the key** — upgrades are signed with the same key.

**2. The new package must have a higher version** than the installed one. Check the
current version:

```sh
apk list --installed 2>/dev/null | grep luci-app-envisalink
```

apk only upgrades to a higher version. (Re-uploading the *same* version does nothing; to
force a reinstall of the same version use `apk add --allow-untrusted --reinstall …` over
SSH.)

**3. Install the new `.apk`** exactly as in a fresh install:

- LuCI: **System → Software → Update lists… → Upload Package…** → the new file, or
- SSH: `apk add --allow-untrusted /tmp/luci-app-envisalink-<newversion>.apk`.

**4. Your configuration is preserved.** apk does **not** overwrite your
`/etc/config/envisalink`; it writes the package's new default alongside it as
`/etc/config/envisalink.apk-new`. Your IP, password and settings are untouched. If an
upgrade introduced new options you want to pick up, compare and then remove the leftover:

```sh
diff /etc/config/envisalink /etc/config/envisalink.apk-new
rm /etc/config/envisalink.apk-new
```

**5. Restart the service** so the new code runs:

```sh
/etc/init.d/evl-tpi-proxy restart
```

(or **Services → Envisalink → Restart**).

**6. If the LuCI page looks stale**, hard-refresh the browser (Ctrl-Shift-R). The package
clears LuCI's server-side caches on install.

---

## Uninstall

```sh
apk del luci-app-envisalink
```

(or **System → Software**, find it, **Remove**). This removes the files and the service.
Your `/etc/config/envisalink` may be left behind — delete it by hand if you don't want it.

---

## Troubleshooting

- **`UNTRUSTED signature` on upload** — the public key isn't in `/etc/apk/keys/`. Do the
  one-time key step, or install over SSH with `apk add --allow-untrusted`.
- **`… (no such package)` / unmet dependencies** — run **Update lists…** (`apk update`)
  and make sure the router has internet; the python3 modules and `luci-base` come from
  the feeds.
- **`error: uninstallable` / arch** — you have the wrong file; this package is built
  `arch: noarch` and installs on any apk-based OpenWrt.
- **Status stays "reconnecting"** — check the EnvisaLink IP, password and panel type in
  Services → Envisalink, that the EnvisaLink password isn't still the default `user`, and
  that nothing else is holding the EnvisaLink's TPI port directly (everything should point
  at the proxy now). `logread -e tpi-proxy` shows the reason.
