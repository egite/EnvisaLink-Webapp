# EnvisaLink webapp

A small, self-contained web UI for a **Honeywell / Ademco Vista** alarm panel through
an **EnvisaLink** (EVL3/EVL4) module. Shows the panel's status and zones, arms and
disarms, and has a virtual keypad, an event log and email alerts - from a phone or a
computer. Runs natively on any Linux box (Python 3.11+) - no Docker, no Home Assistant.

It's built and tested on a Honeywell Vista. `panel_type = "DSC"` connects to DSC
panels too (pyenvisalink supports both), but the chime and clear-trouble quick keys
send Honeywell key sequences and are refused on DSC (zone bypass uses pyenvisalink's
own DSC command), and DSC hasn't been tested.

It's the EnvisaLink counterpart to the AlarmDecoder webapp: a Flask app on top of
a protocol library ([`pyenvisalink`](https://pypi.org/project/pyenvisalink/),
which speaks the EnvisaLink TPI protocol), instead of the AlarmDecoder board and
the `alarmdecoder` library.

## How it's put together

| File | What it is |
|------|-----------|
| `app.py` | Flask app: login, status page, JSON state API, command endpoints, settings pages |
| `evlpanel.py` | Runs `pyenvisalink` in a background asyncio thread; keeps a state snapshot; schedules commands; watches that the panel is reachable |
| `events.py` | Event types and the state-diff that turns panel changes into events |
| `notifier.py` | Email alerts (subscriptions, zone filter, time window, throttle) |
| `eventlog.py` | The event log (SQLite, `data/eventlog.db`) with retention purge |
| `store.py`, `adio.py` | Settings store (JSON in `data/`) and AlarmDecoder-format import/export |
| `config.toml` | Your settings (copied from `config.example.toml`) |
| `templates/`, `static/` | The web UI (status banner, zones, arm/disarm buttons, live polling) |
| `requirements.txt` | `pyenvisalink`, `async_timeout`, `Flask`, `waitress` |
| `run.sh` | Makes the venv, installs deps, runs the app |
| `envisalink-webapp.service` | systemd unit to run it at boot |
| `tpi-proxy/` | Optional proxy so several clients (this app, Home Assistant, …) can share the one EnvisaLink connection |

Config is TOML, read with Python 3.11+'s built-in `tomllib` — no extra dependency.

## Before you start — on the EnvisaLink

1. **Change its local password** from the default `user` to something 4+ chars.
   The TPI firewall on port 4025 blocks all clients until you do. EVL3 max 6 chars.
2. Give the EnvisaLink a **static IP / DHCP reservation**.
3. The EnvisaLink accepts **only one TPI client** on port 4025. If anything else
   (Home Assistant, another app) also needs it, run the proxy in
   [`tpi-proxy/`](tpi-proxy/README.md) and point every client, this one included, at
   the proxy instead.

## Set up

1. Edit `config.toml` for the initial values:
   - `[envisalink] host` (the EnvisaLink, or the proxy), `password`,
     `panel_type` (`HONEYWELL` or `DSC`), `evl_version` (3 or 4)
   - `[alarm] code` (arm/disarm code), `num_zones`
   - `[web] login_password` (password for this web UI)
   - `[[zones]]` blocks to name your zones

   After first run you can also change the EnvisaLink host, port, username,
   password, EVL version, code and zone count in the browser at **Settings →
   Connection** (it saves to `data/connection.json`, which overrides `config.toml`,
   and restarts to reconnect). The `[web]` login and listen host/port stay in
   `config.toml`.
2. Run it:
   ```bash
   ./run.sh
   ```
   First run builds the venv and installs deps, then serves on the `[web] port`
   (default **8080**). Open `http://<this-box-ip>:8080`, log in with the web
   password, and you should see the panel connect.

`./run.sh` runs the app in the foreground - it stops when you close the terminal. To
keep it running, install it as a service (below).

## Run it as a service (start at boot)

[`envisalink-webapp.service`](envisalink-webapp.service) is a systemd unit that starts
the app at boot and restarts it if it stops.

1. Run `./run.sh` once (then Ctrl+C) so the `venv` exists.
2. Edit the unit's `User=`, `WorkingDirectory=` and `ExecStart=` to your user and the
   folder you cloned into. As shipped they're `pi` and
   `/home/pi/shared/Workspace/Claude/EnvisaLink/envisalink-webapp`.
3. Stop any copy you started by hand (the service needs the port), then install it:
   ```bash
   sudo cp envisalink-webapp.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now envisalink-webapp
   ```
4. Check it:
   ```bash
   systemctl status envisalink-webapp
   journalctl -u envisalink-webapp -f
   ```
   You should see `EnvisaLink login successful` in the log.

Day to day:

| To | Run |
|----|-----|
| Restart (e.g. after `git pull` or editing `config.toml`) | `sudo systemctl restart envisalink-webapp` |
| Stop / start | `sudo systemctl stop envisalink-webapp` / `start` |
| Don't start at boot | `sudo systemctl disable envisalink-webapp` |
| See the log | `journalctl -u envisalink-webapp -f` |

If you edit the unit file, copy it again and run `sudo systemctl daemon-reload` before
restarting. Changes made in the browser (Settings) don't need a restart - saving the
Connection page restarts the app by itself.

The version - the date and time of the last commit, e.g. `October 26, 2026  07:19` - is shown
at the bottom of every page, so you can tell which code a running copy has. It's read when the app
starts, so restart after `git pull`.

## Status page

- **Zones are grouped by type** - Doors, Garage, Windows, Glass break, Motion, Water,
  Temperature, Smoke / fire, Mailbox, Other - each with its own icon. The type is
  worked out from the zone name (e.g. "Overhead Garage Door" -> Garage, "Office
  Glassbreak" -> Glass break), so name zones descriptively. Click a group's header to
  collapse or expand it.
- **Faulted only** (on by default) shows just zones that are open, in alarm or bypassed;
  when everything is closed you see "All N zones are closed."
- **Unnamed zones** (off by default) also shows zones that have no name ("Zone 29").
- These toggles and collapsed groups are remembered per browser.
- **Bypass** on each zone row bypasses that zone (asks first). Honeywell: sends code +
  BYPASS + zone number. Only while disarmed; a Vista can't un-bypass a single zone, so
  bypasses last until the next disarm. The panel doesn't report bypassed zones directly,
  so the app picks them up from the keypad's `BYPAS NN` text and shows them as BYPASS.
- **Chime** (left of Clear trouble) shows whether chime is on and toggles it (code +
  CHIME).
- **Clear trouble** sends your alarm code + OFF (Honeywell), which acknowledges troubles
  and clears alarm memory. It's disabled while armed, because code + OFF would disarm.
  It's highlighted when the panel reports a trouble, low battery, AC loss or alarm memory.
- Once you sign in you stay signed in on that browser until you sign out or clear its
  cookies.

## Keypad

Below the zones on the main page is a virtual **keypad** (1-9, `*`, 0, `#`), each key
labelled with its Honeywell function (OFF, AWAY, STAY, MAX, TEST, BYPASS, INSTANT, CODE,
CHIME, READY). Keys go straight to the panel - type your code to arm/disarm, or use `*`
sequences (`*72`, etc.) just like the physical keypad. Your computer's number keys work
too. The panel's own display text and trouble/AC/chime badges are in the status banner
at the top. (The old `/keypad` URL now jumps here.)

## Program (guided panel programming)

**Program** (top nav) walks you through installer programming of a **VISTA-15P / VISTA-20P**
(and SIA versions), based on the Programming Guide K5305-1PRV5. It only sends ordinary keypad
keys through the EnvisaLink, so it works with any Vista the TPI can type at, and it shows the
panel's own 2x16 display at the top so you can check every step. A small keypad is there for
anything the guided steps don't cover.

- **Programming mode**: pick the panel model, type the installer code (factory 4112) and press
  *Enter programming mode* (code + 800; refused while armed). Leave with **Exit (✱99)** - never
  ✱98, which locks out installer-code re-entry until the panel is power-cycled.
- **Data fields**: every field in the guide's programming form (✱20-✱199), searchable and grouped,
  with its factory default, plain-language choices (per partition on the 20P) and the exact keys
  that will be sent. *View current value* sends # + field. Phone and account fields can be cleared.
- **Zones (✱56)**: zone type, partition, report code, wiring and response time, or wireless
  enrollment (trip the sensor or type its serial), as a numbered list of steps. Each step says what
  the display should show and ticks when it does.
- **Zone names (✱82)**: keypad zone descriptors, filled in from the zone names in this app using the
  panel's vocabulary (words it doesn't have are flagged).
- **Zone lists (✱81)**: add, replace, remove or delete the zones on a list (e.g. list 3 for
  chime-by-zone).
- **Reference**: programming-mode commands and display messages.

Each step is recorded in the Log as *Programming: ...* (never the keys, so never the installer
code). While the panel is in programming mode it isn't protecting the house, and the status page
may show odd states.

## Log

**Log** (top nav) lists every panel event the app sees - arm/disarm, zone faults and
restores, alarms, bypass, power, ready/chime changes, (re)connects, panel offline/online -
newest first, with the same wording as the notification message templates.

It also records **what was done from the web app, and from where**: sign-ins (and failed
attempts), arm/disarm, bypass, chime, clear trouble, and settings changes, each with the
device's IP and type (e.g. `Arm away from the web app (192.168.4.20, iPhone).`). Keypad
use is logged once per burst as *Keypad used* - never the keys, since they include your
code. Filter on *web action* to see just these. Filter by event type or search
the text; **Clear log** empties it.

At the bottom of the page, **Keep log history for N days** sets how long entries are
kept (default 30; 0 = forever). Older entries are removed at startup, once a day, and
when you change the setting. The log is stored in `data/eventlog.db` and isn't part of
the settings export.

## Connection status / "login timeout"

The badge top-right shows **connected**, **reconnecting…**, or **login failed**:

- **login failed** = the EnvisaLink rejected the password. Fix it under Settings → Connection.
- **reconnecting…** = it can't complete the TPI login yet and is retrying every ~30s
  (the app reconnects automatically). The usual causes, in order:
  1. The EnvisaLink's local password is still the default `user` - its firewall then
     blocks all TPI clients. Change it (4+ chars; EVL3 max 6) and set it in `config.toml`.
  2. Wrong `host`, `port`, `panel_type` or `evl_version`. A wrong `panel_type` looks
     exactly like this: Honeywell greets with `Login:`, DSC with a `505` message.
  3. Another TPI client is already connected straight to the EnvisaLink (only one
     is allowed - use the proxy to share it).

If the panel stays unreachable, the app can email you - see *Panel offline alert* below.

Verify the EnvisaLink itself is reachable by opening its own web page at `http://<host>`.

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

**Email alerts ON/OFF** at the top of the page turns every alert off at once (the Test
button still works).

**Panel offline alert**: if the app can't reach the panel - login failing, connection
dropped, or no data for 2 minutes - for *N* minutes (default 5; 0 = off), it raises a
*Lost contact with the panel* event, and *Contact with the panel restored* when it's
back. Both are logged; tick them in a notification to get them by email (new
notifications have them ticked). This covers the EnvisaLink, the proxy or the network
going down - though if the network is down the email may not get out either.

Use the **Test** button on the notifications list to send a test message. Click a column
heading (Description, Type, Enabled) to sort the list; click again to reverse it. It
starts sorted by Description, A-Z. Only email
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
alarm), keypad alpha line, trouble/AC/fire/battery badges, zones grouped by type with
open/alarm/bypass status, arm-away / arm-stay / disarm, quick keys (chime, clear trouble,
per-zone bypass), a virtual keypad, an event log (panel events and web actions), email
notifications (with throttle and a panel-offline alert), and AlarmDecoder-compatible
import/export, and guided installer programming for VISTA-15P/20P panels. A panic endpoint
exists in the API.

Not yet: non-email notification backends (preserved by import/export but not sent),
multi-user accounts, multiple partitions in the UI (the API carries
all partitions; the banner shows partition 1). These are straightforward to add.

## Security notes

- One shared web password (plaintext-compared from `config.toml`) plus the alarm
  code held server-side. Fine for a LAN/VPN; harden (hashed users, HTTPS) before
  any public exposure.
- Once signed in, a browser stays signed in until it signs out or clears cookies.
  Sign-ins and failed attempts are recorded in the Log with the device's IP.
- Command POSTs carry a CSRF token tied to your session.
- `config.toml` holds your alarm code and passwords — keep it readable only by you
  (`chmod 600 config.toml`). The auto-generated `.secret_key` is created `600`.

## License

Public domain, under [The Unlicense](LICENSE): use, copy, modify and distribute it for
any purpose, with no conditions. No warranty.
