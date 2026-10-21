"""
Portable settings store.

Holds the data that the original AlarmDecoder webapp keeps in its database and
puts in its export: zones, notifications (+ their settings), message templates
and the system settings table. We keep it in JSON files whose shape mirrors
those tables one-for-one, so import/export of an `alarmdecoder-export-*.tar.gz`
is a faithful round-trip (see adio.py).

In memory it's exposed in a friendlier form (a notification is a dict with a
`settings` sub-dict); on disk/in the archive it's the AlarmDecoder row format
(int_value / string_value columns). Connection + web config stays in config.toml.
"""

import json
import os
import threading

import events

# EXPORT_MAP equivalents -> the JSON files inside the archive / our data dir.
FILES = ("settings.json", "zones.json", "notifications.json",
         "notification_settings.json", "notification_messages.json")

EMAIL = 0  # notification type (matches AlarmDecoder)


def _value_to_columns(value):
    """Split a Python value into (int_value, string_value) AlarmDecoder-style."""
    if isinstance(value, bool):
        return (1 if value else 0), None
    if isinstance(value, int):
        return value, None
    return None, (None if value is None else str(value))


def _columns_to_value(row):
    if row.get("int_value") is not None:
        return row["int_value"]
    return row.get("string_value")


# Notification type names -> ids (for tolerant import of odd data).
_TYPE_NAMES = {"email": 0, "pushover": 2, "twilio": 3, "prowl": 5, "growl": 6,
               "custom": 7, "twiml": 8, "matrix": 9, "upnppush": 10}


def _safe_int(v, default=0):
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, int):
        return v
    if isinstance(v, str):
        if v.strip().lstrip("-").isdigit():
            return int(v)
        return _TYPE_NAMES.get(v.strip().lower(), default)
    return default


class Store(object):
    def __init__(self, data_dir):
        self.data_dir = data_dir
        self._lock = threading.RLock()
        # in-memory model
        self.settings = {}          # name -> value
        self.zones = {}             # zone_id(int) -> {"name", "description"}
        self.messages = {}          # event_type(int) -> text
        self.notifications = []     # [{id, description, type, enabled, settings:{}}]
        self._next_notif_id = 1

    # ---- load / save --------------------------------------------------------

    def load(self):
        with self._lock:
            tables = {}
            for name in FILES:
                path = os.path.join(self.data_dir, name)
                tables[name] = _read_json(path) if os.path.exists(path) else []
            self.load_tables(tables)
            if not self.messages:
                self.seed_default_messages()
            self.save()
            return self

    def save(self):
        with self._lock:
            os.makedirs(self.data_dir, exist_ok=True)
            for name, rows in self.dump_tables().items():
                _write_json(os.path.join(self.data_dir, name), rows)

    # ---- (de)serialise to the AlarmDecoder row format -----------------------

    def load_tables(self, tables):
        """Replace the in-memory model from a dict of {filename: [rows]}."""
        with self._lock:
            self.settings = {}
            for r in tables.get("settings.json", []) or []:
                if r.get("name"):
                    self.settings[r["name"]] = _columns_to_value(r)

            self.zones = {}
            for r in tables.get("zones.json", []) or []:
                zid = r.get("zone_id")
                if zid is None:
                    continue
                zid = _safe_int(zid, None)
                if zid is None:
                    continue
                self.zones[zid] = {
                    "name": r.get("name") or ("Zone %d" % zid),
                    "description": r.get("description") or "",
                }

            self.messages = {}
            for r in tables.get("notification_messages.json", []) or []:
                if r.get("id") is not None:
                    self.messages[_safe_int(r["id"])] = r.get("text", "")

            # notifications + their settings (joined by notification_id)
            settings_by_notif = {}
            for r in tables.get("notification_settings.json", []) or []:
                nid = r.get("notification_id")
                if nid is None or not r.get("name"):
                    continue
                settings_by_notif.setdefault(_safe_int(nid), {})[r["name"]] = _columns_to_value(r)

            self.notifications = []
            max_id = 0
            for r in tables.get("notifications.json", []) or []:
                nid = _safe_int(r.get("id", 0))
                max_id = max(max_id, nid)
                self.notifications.append({
                    "id": nid,
                    "description": r.get("description", ""),
                    "type": _safe_int(r.get("type", EMAIL), EMAIL),
                    "enabled": _safe_int(r.get("enabled", 1), 1),
                    "settings": settings_by_notif.get(nid, {}),
                })
            self._next_notif_id = max_id + 1

    def dump_tables(self):
        """Serialise the in-memory model back to {filename: [rows]}."""
        with self._lock:
            settings_rows = []
            for i, (name, value) in enumerate(sorted(self.settings.items()), start=1):
                iv, sv = _value_to_columns(value)
                settings_rows.append({"id": i, "name": name, "int_value": iv, "string_value": sv})

            zone_rows = []
            for i, zid in enumerate(sorted(self.zones), start=1):
                z = self.zones[zid]
                zone_rows.append({"id": i, "zone_id": zid, "name": z["name"],
                                  "description": z.get("description", "")})

            msg_rows = [{"id": k, "text": v} for k, v in sorted(self.messages.items())]

            notif_rows, setting_rows = [], []
            sid = 1
            for n in self.notifications:
                notif_rows.append({"id": n["id"], "description": n["description"],
                                   "type": n["type"], "enabled": n["enabled"],
                                   "user_id": None})
                for name, value in n["settings"].items():
                    iv, sv = _value_to_columns(value)
                    setting_rows.append({"id": sid, "notification_id": n["id"],
                                         "name": name, "int_value": iv, "string_value": sv})
                    sid += 1

            return {
                "settings.json": settings_rows,
                "zones.json": zone_rows,
                "notifications.json": notif_rows,
                "notification_settings.json": setting_rows,
                "notification_messages.json": msg_rows,
            }

    # ---- helpers ------------------------------------------------------------

    def seed_default_messages(self):
        with self._lock:
            for k, v in events.DEFAULT_EVENT_MESSAGES.items():
                self.messages.setdefault(int(k), v)

    def message_for(self, event_type):
        return self.messages.get(int(event_type)) or events.DEFAULT_EVENT_MESSAGES.get(int(event_type), "")

    def zone_name(self, number):
        z = self.zones.get(int(number))
        return z["name"] if z else None

    def get_notification(self, nid):
        for n in self.notifications:
            if n["id"] == int(nid):
                return n
        return None

    def add_notification(self, description, ntype=EMAIL, settings=None, enabled=1):
        with self._lock:
            n = {"id": self._next_notif_id, "description": description,
                 "type": int(ntype), "enabled": int(enabled), "settings": settings or {}}
            self._next_notif_id += 1
            self.notifications.append(n)
            self.save()
            return n

    def update_notification(self, nid, description=None, enabled=None, settings=None):
        with self._lock:
            n = self.get_notification(nid)
            if not n:
                return None
            if description is not None:
                n["description"] = description
            if enabled is not None:
                n["enabled"] = int(enabled)
            if settings is not None:
                n["settings"] = settings
            self.save()
            return n

    def delete_notification(self, nid):
        with self._lock:
            self.notifications = [n for n in self.notifications if n["id"] != int(nid)]
            self.save()


def _read_json(path):
    with open(path, "r") as f:
        return json.load(f)


def _write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, sort_keys=True)
    os.replace(tmp, path)
