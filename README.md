# EnvisaLink webapp

A small, self-contained web UI for a **DSC** alarm panel through an **EnvisaLink**
(EVL3/EVL4) module. Shows partition state and zones, and arms/disarms from a phone
or computer. Runs natively on the Ubuntu box — no Docker, no Home Assistant.

It's the EnvisaLink counterpart to the AlarmDecoder webapp: a Flask app on top of
a protocol library ([`pyenvisalink`](https://pypi.org/project/pyenvisalink/),
which speaks the EnvisaLink TPI protocol), instead of the AlarmDecoder board and
the `alarmdecoder` library.

## How it's put together

| File | What it is |
|------|-----------|
| `app.py` | Flask app: login, status page, JSON state API, command endpoints |
| `evlpanel.py` | Runs `pyenvisalink` in a background asyncio thread; keeps a state snapshot; schedules commands |
| `config.toml` | Your settings (copied from `config.example.toml`) |
| `templates/`, `static/` | The web UI (status banner, zones, arm/disarm buttons, live polling) |
| `requirements.txt` | `pyenvisalink`, `async_timeout`, `Flask`, `waitress` |
| `run.sh` | Makes the venv, installs deps, runs the app |
| `envisalink-webapp.service` | systemd unit to run it at boot |

Config is TOML, read with Python 3.11+'s built-in `tomllib` — no extra dependency.

## Before you start — on the EnvisaLink

1. **Change its local password** from the default `user` to something 4+ chars.
   The TPI firewall on port 4025 blocks all clients until you do. EVL3 max 6 chars.
2. Give the EnvisaLink a **static IP / DHCP reservation**.
3. Make sure **nothing else is connected to port 4025** — it allows only one TPI
   client, and this app holds it.

## Set up

1. Edit `config.toml`:
   - `[envisalink] host`, `password`, `evl_version` (3 or 4)
   - `[alarm] code` (arm/disarm code), `num_zones`
   - `[web] login_password` (password for this web UI)
   - `[[zones]]` blocks to name your zones
2. Run it:
   ```bash
   ./run.sh
   ```
   First run builds the venv and installs deps, then serves on the `[web] port`
   (default **8080**). Open `http://<this-box-ip>:8080`, log in with the web
   password, and you should see the panel connect.

Run at boot with the systemd unit (see the header of `envisalink-webapp.service`).

## Notifications (email)

**Settings → Notifications** configures email alerts with the same options as the
original AlarmDecoder webapp:

- **Events**: subscribe to any of alarm, panic, fire, arm, disarm, zone fault/
  restore/bypass, power, low battery, (re)connect, ready, chime.
- **Zone filter**: zone fault/restore/bypass alerts only fire for the zones you tick.
- **Time window**: only send between a start and end time (overnight windows work).
- **Throttle**: at most *N* emails per *M* minutes (0 = no limit). Alarm, panic and
  fire are always sent; the next email that goes out says how many were held back.
- **Zone-fault delay**: wait *N* seconds and skip the email if the zone restores first.
- **Message templates** (Settings → Message templates) with `{zone}`, `{zone_name}`,
  `{status}`, `{arm_type}` fields.

Use the **Test** button on the notifications list to send a test message. Only email
sends in this build; other notification types are preserved by import/export but not
delivered.

## Import / export (AlarmDecoder-compatible)

The app reads and writes the **same `alarmdecoder-export-*.tar.gz` format** as the
original webapp, so settings move both ways.

- **In the webapp**: Settings → Import (upload an archive) / Export (download one).
  Import replaces zones, notifications, message templates and stored settings; it
  faithfully preserves notification types the app doesn't send (Pushover, Twilio,
  etc.) so a later export still contains them.
- **From the command line** (one-shot migration without logging in):
  ```bash
  ./venv/bin/python import_ad2.py /path/to/alarmdecoder-export-*.tar.gz
  ```

Portable settings (zones, notifications, templates) live in the `data/` directory as
JSON mirroring the AlarmDecoder tables. The EnvisaLink `host`, `password`,
`evl_version`, web login and alarm code stay in `config.toml` (they aren't part of
the AlarmDecoder export), so set those by hand.

> **Single process only.** The EnvisaLink allows one TPI client, so the app runs
> as a single `waitress` process. Don't launch it under a multi-worker server.

## Remote access (phone / computer away from home)

Pick one — don't just port-forward 8080 to the internet for an alarm:

- **Tailscale** (free, recommended): install on this box and your devices, reach
  the app at its tailnet IP from anywhere. Nothing exposed publicly.
- **Reverse proxy + HTTPS** (Caddy/nginx + Let's Encrypt) if you want a public
  hostname. Put TLS and a strong password in front of it.

The UI is a responsive web page, so a phone browser works fine; add it to your
home screen for an app-like shortcut.

## What it does / doesn't do (yet)

Does: live partition state (ready / armed away / stay / night / exit+entry delay /
alarm), keypad alpha line, trouble/AC/fire/battery badges, per-zone open/alarm/
bypass, arm-away / arm-stay / disarm, email notifications (with throttle), and
AlarmDecoder-compatible import/export. Panic and zone-bypass endpoints exist in the API.

Not yet: non-email notification backends (preserved by import/export but not sent),
multi-user accounts, event history, multiple partitions in the UI (the API carries
all partitions; the banner shows partition 1). These are straightforward to add.

## Security notes

- One shared web password (plaintext-compared from `config.toml`) plus the alarm
  code held server-side. Fine for a LAN/VPN; harden (hashed users, HTTPS) before
  any public exposure.
- Command POSTs carry a CSRF token tied to your session.
- `config.toml` holds your alarm code and passwords — keep it readable only by you
  (`chmod 600 config.toml`). The auto-generated `.secret_key` is created `600`.
