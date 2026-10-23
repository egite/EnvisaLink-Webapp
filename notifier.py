"""
Email notifier.

Takes the (event_type, kwargs) list from events.detect(), decides which
configured e-mail notifications should fire (subscription, zone filter, time
window, throttle, zone-fault delay/suppress), renders the message template and
sends the mail. Mirrors the behaviour of the original AlarmDecoder e-mail
notification, including the -E throttle.
"""

import collections
import json
import logging
import smtplib
import threading
import time
from datetime import datetime
from email.mime.text import MIMEText

import events

log = logging.getLogger("notifier")

EMAIL = 0


def _as_bool(v):
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes", "on")
    return bool(v)


def _as_int(v, default=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def check_time_restriction(starttime, endtime, now=None):
    """True if `now` (HH:MM:SS local) is within [start, end], wrap-aware."""
    now = now or datetime.now().strftime("%H:%M:%S")
    start = starttime or "00:00:00"
    end = endtime or "23:59:59"
    if start <= end:
        return start <= now <= end
    return now >= start or now <= end          # overnight window


class _Throttle(object):
    """At most `count` messages per `minutes`; critical events are exempt."""

    def __init__(self):
        self.lock = threading.Lock()
        self.sent = collections.deque()
        self.dropped = 0

    def allow(self, count, minutes, exempt):
        if count <= 0 or minutes <= 0:
            return True, 0
        with self.lock:
            now = time.time()
            window_start = now - minutes * 60
            while self.sent and self.sent[0] <= window_start:
                self.sent.popleft()
            if not exempt and len(self.sent) >= count:
                self.dropped += 1
                return False, self.dropped
            self.sent.append(now)
            dropped = self.dropped
            self.dropped = 0
            return True, dropped


class Notifier(object):
    def __init__(self, store, send_fn=None):
        self.store = store
        self._throttles = {}                 # notification id -> _Throttle
        self._pending = {}                   # (nid, zone) -> threading.Timer
        self._send_fn = send_fn or self._smtp_send

    # ---- public -------------------------------------------------------------

    def handle_events(self, event_list):
        if not self.store.email_alerts_enabled():
            return
        for etype, kwargs in event_list:
            for n in self.store.notifications:
                if n["type"] != EMAIL or not n.get("enabled"):
                    continue
                try:
                    self._consider(n, etype, kwargs)
                except Exception:
                    log.exception("notification %s failed", n.get("id"))

    def test(self, nid):
        """Send a test message for one notification; returns (ok, detail)."""
        n = self.store.get_notification(nid)
        if not n:
            return False, "no such notification"
        try:
            self._send(n, "Test notification from the EnvisaLink webapp.", exempt=True)
            return True, "sent"
        except Exception as e:  # noqa: BLE001
            log.exception("test notification failed")
            return False, str(e)

    # ---- decision -----------------------------------------------------------

    def _subscribes(self, n, etype, zone):
        s = n["settings"]
        subs = {}
        if s.get("subscriptions"):
            try:
                subs = {int(k): _as_bool(v) for k, v in json.loads(s["subscriptions"]).items()}
            except (ValueError, TypeError):
                subs = {}
        if not subs.get(etype):
            return False
        if etype in (events.ZONE_FAULT, events.ZONE_RESTORE, events.BYPASS):
            zfilter = []
            if s.get("zone_filter"):
                try:
                    zfilter = [int(z) for z in json.loads(s["zone_filter"])]
                except (ValueError, TypeError):
                    zfilter = []
            return int(zone) in zfilter if zone != "" and zone is not None else False
        return True

    def _consider(self, n, etype, kwargs):
        zone = kwargs.get("zone", "")
        suppress = _as_bool(n["settings"].get("suppress", True))

        # Cancel a pending delayed fault when the zone restores. This runs
        # regardless of whether ZONE_RESTORE is itself a subscribed event -
        # it's about the suppressed fault, not about sending a restore message.
        if etype == events.ZONE_RESTORE and suppress:
            pend = self._pending.pop((n["id"], zone), None)
            if pend:
                pend.cancel()

        if not self._subscribes(n, etype, zone):
            return
        if not check_time_restriction(n["settings"].get("starttime"), n["settings"].get("endtime")):
            return

        # Zone-fault delay: wait, then send only if still faulted (the restore
        # above cancels this timer).
        delay = _as_int(n["settings"].get("delay"), 0)
        if etype == events.ZONE_FAULT and delay > 0:
            key = (n["id"], zone)
            old = self._pending.pop(key, None)
            if old:
                old.cancel()
            t = threading.Timer(delay, self._fire, args=(n["id"], etype, kwargs))
            t.daemon = True
            self._pending[key] = t
            t.start()
            return

        self._fire(n["id"], etype, kwargs)

    def _fire(self, nid, etype, kwargs):
        n = self.store.get_notification(nid)
        if not n:
            return
        self._pending.pop((nid, kwargs.get("zone", "")), None)
        # A delayed zone-fault may come due after alerts were switched off.
        if not self.store.email_alerts_enabled():
            return
        text = self.store.render_message(etype, kwargs)
        exempt = etype in events.CRITICAL_EVENTS
        try:
            self._send(n, text, exempt=exempt, etype=etype)
        except Exception:
            log.exception("send failed for notification %s", nid)

    # ---- delivery -----------------------------------------------------------

    def _send(self, n, text, exempt=False, etype=None):
        s = n["settings"]
        throttle = self._throttles.setdefault(n["id"], _Throttle())
        allowed, dropped = throttle.allow(_as_int(s.get("throttle_count")),
                                          _as_int(s.get("throttle_minutes")), exempt)
        if not allowed:
            log.info('notification "%s" throttled (%s per %s min), %s dropped so far',
                     n["description"], s.get("throttle_count"), s.get("throttle_minutes"), dropped)
            return

        body = text
        if not _as_bool(s.get("suppress_timestamp", False)):
            body = "%s - %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), text)
        if dropped:
            body += ("\n\n(%d earlier alert(s) were not emailed because of the throttle "
                     "limit of %s per %s minute(s).)" % (dropped, s.get("throttle_count"),
                                                         s.get("throttle_minutes")))

        self._send_fn(s, n.get("description", "AlarmDecoder"), body)

    def _smtp_send(self, s, description, body):
        source = s.get("source") or "alarm@localhost"
        dests = [d.strip() for d in str(s.get("destination") or "").replace(";", ",").split(",") if d.strip()]
        if not dests:
            raise ValueError("no destination address configured")

        msg = MIMEText(body)
        msg["Subject"] = s.get("subject") or description
        msg["From"] = source
        msg["To"] = ", ".join(dests)

        server = s.get("server") or "localhost"
        port = _as_int(s.get("port"), 25)
        if _as_bool(s.get("ssl")):
            smtp = smtplib.SMTP_SSL(server, port, timeout=20)
        else:
            smtp = smtplib.SMTP(server, port, timeout=20)
        try:
            if _as_bool(s.get("tls")):
                smtp.starttls()
            if _as_bool(s.get("authentication_required")) and s.get("username"):
                smtp.login(s["username"], s.get("password") or "")
            smtp.sendmail(source, dests, msg.as_string())
        finally:
            smtp.quit()
