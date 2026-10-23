"""
Event log.

Every event that events.detect() reports (plus the connect/boot event) is kept
here with its rendered message, like the original AlarmDecoder webapp's Log
page. It lives in its own SQLite file in the data dir; it's history, not
settings, so it is not part of the import/export archive.

Entries older than the retention setting (days, store setting
`log_retention_days`, default 30, 0 = keep forever) are purged at startup,
once a day, and whenever the setting changes.
"""

import logging
import os
import sqlite3
import threading
import time

log = logging.getLogger("eventlog")

DB_FILE = "eventlog.db"
DEFAULT_RETENTION_DAYS = 30


class EventLog(object):
    def __init__(self, data_dir):
        os.makedirs(data_dir, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(os.path.join(data_dir, DB_FILE), check_same_thread=False)
        with self._lock:
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS events ("
                " id INTEGER PRIMARY KEY AUTOINCREMENT,"
                " ts REAL NOT NULL,"
                " type INTEGER NOT NULL,"
                " message TEXT NOT NULL)")
            self._db.execute("CREATE INDEX IF NOT EXISTS events_ts ON events (ts)")
            self._db.commit()

    def add(self, etype, message, ts=None):
        with self._lock:
            self._db.execute("INSERT INTO events (ts, type, message) VALUES (?, ?, ?)",
                             (ts or time.time(), int(etype), message))
            self._db.commit()

    def query(self, etype=None, text=None, limit=100, offset=0):
        """Newest first. Returns (rows, total) - rows are dicts."""
        where, args = [], []
        if etype is not None:
            where.append("type = ?")
            args.append(int(etype))
        if text:
            where.append("message LIKE ? ESCAPE '\\'")
            args.append("%" + text.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_") + "%")
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        with self._lock:
            total = self._db.execute("SELECT COUNT(*) FROM events" + clause, args).fetchone()[0]
            cur = self._db.execute("SELECT id, ts, type, message FROM events" + clause +
                                   " ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?",
                                   args + [int(limit), int(offset)])
            rows = [{"id": r[0], "ts": r[1], "type": r[2], "message": r[3]} for r in cur]
        return rows, total

    def purge(self, days):
        """Delete entries older than `days` days (0 or less = keep everything)."""
        if days <= 0:
            return 0
        cutoff = time.time() - days * 86400
        with self._lock:
            n = self._db.execute("DELETE FROM events WHERE ts < ?", (cutoff,)).rowcount
            self._db.commit()
        if n:
            log.info("purged %d log entries older than %d days", n, days)
        return n

    def clear(self):
        with self._lock:
            self._db.execute("DELETE FROM events")
            self._db.commit()

    def start_purger(self, days_fn, interval=86400):
        """Purge now and then every `interval` seconds, using days_fn() each time."""
        def _run():
            while True:
                try:
                    self.purge(days_fn())
                except Exception:
                    log.exception("log purge failed")
                time.sleep(interval)
        threading.Thread(target=_run, name="eventlog-purge", daemon=True).start()
