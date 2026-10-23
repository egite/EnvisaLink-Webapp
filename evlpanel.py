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

The EnvisaLink only accepts ONE TPI client, so there must be exactly one of
these per process (and the app must run as a single process).
"""

import asyncio
import copy
import logging
import queue
import threading
import time

from pyenvisalink import EnvisalinkAlarmPanel

import events

log = logging.getLogger("evlpanel")


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
        self.last_update = 0.0

        self._prev_state = None
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
            "panel_type": evl.get("panel_type", "DSC"),
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

        self._panel = panel
        self._ready.set()

        panel.start()
        self._loop.run_forever()

    # ---- callbacks (loop thread) --------------------------------------------

    def _on_login_success(self, *a, **k):
        log.info("EnvisaLink login successful")
        self.login_state = "ok"
        self.connected = True
        self.last_update = time.time()
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

    def _on_activity(self, *a, **k):
        self.connected = True
        self.last_update = time.time()
        try:
            snapshot = self.get_state()
            detected = events.detect(self._prev_state, snapshot)
            self._prev_state = snapshot
            if detected:
                self._queue_events(detected)
        except Exception:
            log.exception("event detection failed")

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
        if self.store is not None:
            name = self.store.zone_name(n)
            if name:
                return name
        for z in self.cfg.get("zones", []):
            if int(z.get("number", -1)) == n:
                return z.get("name")
        return "Zone %d" % n

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
            zones[n] = {
                "name": self._zone_name(n),
                "open": bool(status.get("open", False)),
                "fault": bool(status.get("fault", False)),
                "alarm": bool(status.get("alarm", False)),
                "tamper": bool(status.get("tamper", False)),
                "bypassed": bool(zdata.get("bypassed", False)),
                "last_fault": zdata.get("last_fault", 0),
            }

        stale = (time.time() - self.last_update) if self.last_update else None
        return {
            "connected": bool(self.connected),
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

    def toggle_bypass(self, zone):
        self._schedule(self._panel.toggle_zone_bypass, int(zone))

    def send_keys(self, keys, partition=1):
        # keypresses_to_partition(partitionNumber, keypresses); max 6 per call.
        self._schedule(self._panel.keypresses_to_partition, int(partition), str(keys)[:6])

    def _code(self):
        return str(self.conn.get("code", ""))
