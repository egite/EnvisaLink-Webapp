"""
EnvisaLink panel wrapper.

pyenvisalink is asyncio-based. We run its event loop in a dedicated background
thread, assign our callbacks, and keep a snapshot of the panel state that the
(synchronous) Flask app can read at any time. Commands from Flask are scheduled
onto the loop thread with call_soon_threadsafe so we never touch asyncio objects
from the wrong thread.

State changes are diffed into logical events (events.detect) and handed to the
notifier on a separate worker thread, so slow e-mail sends never block the
asyncio loop.

Each of these holds one TPI connection (the EnvisaLink itself accepts only one
client unless you put tpi-proxy/ in front of it), so there must be exactly one
per process, and the app must run as a single process.
"""

import asyncio
import copy
import logging
import queue
import re
import threading
import time

from pyenvisalink import EnvisalinkAlarmPanel

import events

log = logging.getLogger("evlpanel")

# No message from the panel for this long = not reachable. It normally sends
# keypad updates every ~10s, and answers our keepalive poll every 30s.
STALE_SECONDS = 120
WATCHDOG_INTERVAL = 15

# Honeywell keypad text for a bypassed zone while disarmed, e.g. "BYPAS 08 MAIN ROOM".
_BYPAS_RE = re.compile(r"^\s*BYPAS\s+(\d{1,3})\b")

# Zone kind from its name, first match wins (order matters: "Overhead Garage
# Door" is garage, "Office Glassbreak" is glass, not window).
_ZONE_KINDS = [
    ("glass", ("glassbreak", "glass break", "glass")),
    ("motion", ("motion", "pir")),
    ("water", ("water", "flood", "leak")),
    ("temp", ("temperature", "temp", "freez", "freeze")),
    ("smoke", ("smoke", "fire", "heat", "co detector", "carbon")),
    ("mail", ("mailbox", "mail")),
    ("garage", ("garage",)),
    ("window", ("window",)),
    ("door", ("door",)),
]


def zone_kind(name):
    n = (name or "").lower()
    for kind, words in _ZONE_KINDS:
        if any(w in n for w in words):
            return kind
    return "other"


class EVLPanel(object):
    def __init__(self, config, store=None, notifier=None, eventlog=None):
        self.cfg = config
        self.store = store
        self.notifier = notifier
        self.eventlog = eventlog
        self._loop = None
        self._panel = None
        self._thread = None
        self._ready = threading.Event()

        self.login_state = "pending"
        self.connected = False
        self.last_update = 0.0          # last state change
        self.last_heard = 0.0           # last message of any kind (heartbeat)
        self._started = time.time()
        self._offline_since = None
        self._offline_alerted = False

        self._prev_state = None
        # Honeywell's TPI has no per-zone bypass report; we collect bypassed
        # zones from the keypad's "BYPAS NN" text and forget them when the
        # panel's bypass light goes off (disarm clears all bypasses).
        self._bypassed = set()
        self._evq = queue.Queue()
        self._booted = False

        self.conn = self._conn_dict()

    def _conn_dict(self):
        """Merge config.toml defaults with editable store.connection overrides."""
        evl = self.cfg.get("envisalink", {})
        alarm = self.cfg.get("alarm", {})
        c = {
            "host": evl.get("host", ""),
            "port": evl.get("port", 4025),
            "username": evl.get("username", "user"),
            "password": evl.get("password", ""),
            "panel_type": evl.get("panel_type", "HONEYWELL"),
            "evl_version": evl.get("evl_version", 3),
            "keepalive_interval": evl.get("keepalive_interval", 30),
            "zone_timer_interval": evl.get("zone_timer_interval", 20),
            "code": alarm.get("code", ""),
            "num_zones": alarm.get("num_zones", 0),
            "num_partitions": alarm.get("num_partitions", 1),
        }
        if self.store is not None:
            for k, v in getattr(self.store, "connection", {}).items():
                if v not in (None, ""):
                    c[k] = v
        for k in ("port", "evl_version", "keepalive_interval",
                  "zone_timer_interval", "num_zones", "num_partitions"):
            try:
                c[k] = int(c[k])
            except (TypeError, ValueError):
                c[k] = 0
        if c["num_partitions"] < 1:
            c["num_partitions"] = 1
        c["code"] = str(c["code"])
        return c

    # ---- lifecycle ----------------------------------------------------------

    def start(self):
        if self.notifier is not None or self.eventlog is not None:
            threading.Thread(target=self._event_worker, name="evl-notify", daemon=True).start()
        self._thread = threading.Thread(target=self._run, name="evl-loop", daemon=True)
        self._thread.start()
        self._ready.wait(timeout=5)
        threading.Thread(target=self._watchdog, name="evl-watchdog", daemon=True).start()

    def _run(self):
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)

        self.conn = self._conn_dict()
        c = self.conn
        panel = EnvisalinkAlarmPanel(
            host=c["host"],
            port=c["port"],
            panelType=c["panel_type"],
            envisalinkVersion=c["evl_version"],
            userName=c["username"],
            password=c["password"],
            keepAliveInterval=c["keepalive_interval"],
            zoneTimerInterval=c["zone_timer_interval"],
            eventLoop=self._loop,
        )
        panel.callback_login_success = self._on_login_success
        panel.callback_login_failure = self._on_login_failure
        panel.callback_login_timeout = self._on_login_timeout
        panel.callback_zone_state_change = self._on_activity
        panel.callback_partition_state_change = self._on_activity
        panel.callback_keypad_update = self._on_activity
        panel.callback_realtime_cid_event = self._on_activity
        # Not state changes, but proof the link is alive.
        panel.callback_poll_response = self._on_heard
        panel.callback_command_response = self._on_heard
        panel.callback_zone_timer_dump = self._on_heard

        self._panel = panel
        self._ready.set()

        panel.start()
        self._loop.run_forever()

    # ---- callbacks (loop thread) --------------------------------------------

    def _on_login_success(self, *a, **k):
        log.info("EnvisaLink login successful")
        self.login_state = "ok"
        self.connected = True
        self.last_update = self.last_heard = time.time()
        if not self._booted:
            self._booted = True
            self._queue_events([(events.BOOT, {})])

    def _on_login_failure(self, *a, **k):
        log.warning("EnvisaLink login failed - check the password")
        self.login_state = "failed"
        self.connected = False

    def _on_login_timeout(self, *a, **k):
        log.warning("EnvisaLink login timed out")
        self.login_state = "timeout"
        self.connected = False

    def _on_heard(self, *a, **k):
        self.last_heard = time.time()

    def _on_activity(self, *a, **k):
        self.connected = True
        self.last_update = self.last_heard = time.time()
        self._track_bypass()
        try:
            snapshot = self.get_state()
            detected = events.detect(self._prev_state, snapshot)
            self._prev_state = snapshot
            if detected:
                self._queue_events(detected)
        except Exception:
            log.exception("event detection failed")

    def _track_bypass(self):
        if self._panel is None:
            return
        try:
            parts = self._panel.alarm_state.get("partition", {})
        except Exception:
            return
        any_bypass = False
        for p in parts.values():
            st = p.get("status", {})
            if st.get("armed_bypass") or st.get("bypass"):
                any_bypass = True
            m = _BYPAS_RE.match(str(st.get("alpha") or ""))
            if m:
                self._bypassed.add(int(m.group(1)))
        if not any_bypass:
            self._bypassed.clear()

    # ---- reachability watchdog (own thread) ---------------------------------

    def _offline_reason(self):
        """None when the panel is reachable, else a short reason."""
        if self.login_state == "failed":
            return "login failed - check the EnvisaLink password"
        client = getattr(self._panel, "_client", None)
        if self.login_state != "ok" or getattr(client, "_loggedin", True) is False:
            return "not connected"
        if time.time() - self.last_heard > STALE_SECONDS:
            return "no data received"
        return None

    def _watchdog(self):
        while True:
            time.sleep(WATCHDOG_INTERVAL)
            try:
                self._check_reachable()
            except Exception:
                log.exception("watchdog failed")

    def _check_reachable(self, now=None):
        now = now or time.time()
        reason = self._offline_reason()
        if reason is None:
            if self._offline_alerted:
                gone = now - (self._offline_since or now)
                log.info("panel reachable again after %s", _duration(gone))
                self._queue_events([(events.PANEL_ONLINE, {"duration": _duration(gone)})])
            self._offline_since = None
            self._offline_alerted = False
            return
        if self._offline_since is None:
            self._offline_since = self.last_heard or self._started
        minutes = self.store.offline_alert_minutes() if self.store is not None else 5
        if minutes > 0 and not self._offline_alerted and now - self._offline_since >= minutes * 60:
            self._offline_alerted = True
            log.warning("panel unreachable for %d+ minutes (%s)", minutes, reason)
            self._queue_events([(events.PANEL_OFFLINE, {"minutes": minutes, "reason": reason})])

    def _queue_events(self, detected):
        if self.notifier is not None or self.eventlog is not None:
            self._evq.put((time.time(), detected))

    def _event_worker(self):
        while True:
            ts, batch = self._evq.get()
            if self.eventlog is not None:
                for etype, kwargs in batch:
                    try:
                        self.eventlog.add(etype, self.store.render_message(etype, kwargs), ts)
                    except Exception:
                        log.exception("event log write failed")
            if self.notifier is not None:
                try:
                    self.notifier.handle_events(batch)
                except Exception:
                    log.exception("notifier failed")

    # ---- state read ---------------------------------------------------------

    def _zone_name(self, n):
        """(name, named) - named is False for zones nobody gave a name."""
        if self.store is not None:
            name = self.store.zone_name(n)
            if name:
                return name, True
        for z in self.cfg.get("zones", []):
            if int(z.get("number", -1)) == n and z.get("name"):
                return z.get("name"), True
        return "Zone %d" % n, False

    def get_state(self):
        num_zones = int(self.conn.get("num_zones", 0))
        num_parts = int(self.conn.get("num_partitions", 1))
        if self.store is not None and self.store.zones:
            num_zones = max(num_zones, max(self.store.zones))

        raw = {}
        if self._panel is not None:
            try:
                raw = copy.deepcopy(self._panel.alarm_state)
            except Exception:
                raw = {}

        partitions = {}
        for p in range(1, num_parts + 1):
            partitions[p] = (raw.get("partition", {}) or {}).get(p, {}).get("status", {})

        zones = {}
        for n in range(1, num_zones + 1):
            zdata = (raw.get("zone", {}) or {}).get(n, {})
            status = zdata.get("status", {})
            name, named = self._zone_name(n)
            zones[n] = {
                "name": " ".join(name.split()),
                "named": named,
                "kind": zone_kind(name),
                "open": bool(status.get("open", False)),
                "fault": bool(status.get("fault", False)),
                "alarm": bool(status.get("alarm", False)),
                "tamper": bool(status.get("tamper", False)),
                "bypassed": bool(zdata.get("bypassed", False)) or n in self._bypassed,
                "last_fault": zdata.get("last_fault", 0),
            }

        stale = (time.time() - self.last_heard) if self.last_heard else None
        client = getattr(self._panel, "_client", None)
        return {
            "connected": bool(self.connected) and getattr(client, "_loggedin", True) is not False,
            "login_state": self.login_state,
            "last_update": self.last_update,
            "stale_seconds": stale,
            "partitions": partitions,
            "zones": zones,
        }

    # ---- commands (scheduled onto the loop thread) --------------------------

    def _schedule(self, fn, *args):
        if self._loop is None or self._panel is None:
            raise RuntimeError("panel not started")
        self._loop.call_soon_threadsafe(fn, *args)

    def arm_away(self, partition=1):
        self._schedule(self._panel.arm_away_partition, self._code(), int(partition))

    def arm_stay(self, partition=1):
        self._schedule(self._panel.arm_stay_partition, self._code(), int(partition))

    def arm_night(self, partition=1):
        self._schedule(self._panel.arm_night_partition, self._code(), int(partition))

    def disarm(self, partition=1):
        self._schedule(self._panel.disarm_partition, self._code(), int(partition))

    def panic(self, panic_type="Police"):
        self._schedule(self._panel.panic_alarm, panic_type)

    def _honeywell(self):
        return str(self.conn.get("panel_type", "")).upper() == "HONEYWELL"

    def _armed(self, partition):
        s = self.get_state()["partitions"].get(int(partition), {})
        return bool(s.get("armed_away") or s.get("armed_stay") or s.get("armed_zero_entry_delay"))

    def bypass_zone(self, zone, partition=1):
        """Bypass one zone. Honeywell: code + BYPASS (6) + zone number.

        Vista panels can't un-bypass a single zone; disarming (code + OFF)
        clears all bypasses. Refused while armed (the panel rejects it).
        """
        zone = int(zone)
        if zone < 1:
            raise RuntimeError("bad zone number")
        if not self._honeywell():
            self._schedule(self._panel.toggle_zone_bypass, zone)
            return
        if not self._code():
            raise RuntimeError("no alarm code configured")
        if self._armed(partition):
            raise RuntimeError("panel is armed - zones can only be bypassed while disarmed")
        self.send_keys(self._code() + "6" + ("%02d" % zone if zone < 100 else "%03d" % zone), partition)

    def send_keys(self, keys, partition=1):
        keys = str(keys)
        # DSC's keypress command takes at most 6 keys; Honeywell sends one per key.
        keys = keys[:6] if not self._honeywell() else keys[:16]
        self._schedule(self._panel.keypresses_to_partition, int(partition), keys)

    def program_keys(self, keys, partition=1, enter=False):
        """Keys for installer programming (the Program page), up to 16 per call.

        `enter` marks the installer code + 800 sequence, refused while armed:
        a Vista only enters programming mode when disarmed, and a wrong code
        there would just be keys typed at an armed panel.
        """
        if not self._honeywell():
            raise RuntimeError("guided programming is only for Honeywell Vista panels")
        keys = str(keys)
        if not re.fullmatch(r"[0-9*#]{1,16}", keys):
            raise RuntimeError("keys must be 1-16 of 0-9, * and #")
        if enter and self._armed(partition):
            raise RuntimeError("panel is armed - disarm before entering programming mode")
        self.send_keys(keys, partition)

    def toggle_chime(self, partition=1):
        """Honeywell: user code + CHIME (9) toggles chime mode."""
        if not self._honeywell():
            raise RuntimeError("chime toggle is only supported on Honeywell panels")
        if not self._code():
            raise RuntimeError("no alarm code configured")
        self.send_keys(self._code() + "9", partition)

    def clear_trouble(self, partition=1):
        """Honeywell: user code + OFF acknowledges troubles / alarm memory.

        Refused while armed, because code + OFF would also disarm.
        """
        if not self._honeywell():
            raise RuntimeError("clear trouble is only supported on Honeywell panels")
        if not self._code():
            raise RuntimeError("no alarm code configured")
        if self._armed(partition):
            raise RuntimeError("panel is armed - disarm first (code + OFF would disarm it)")
        self.send_keys(self._code() + "1", partition)

    def _code(self):
        return str(self.conn.get("code", ""))


def _duration(seconds):
    seconds = int(seconds)
    if seconds < 90:
        return "%d seconds" % seconds
    if seconds < 90 * 60:
        return "%d minutes" % round(seconds / 60)
    return "%.1f hours" % (seconds / 3600)
