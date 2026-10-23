"""
EnvisaLink webapp - a small Flask UI for a DSC alarm via an EnvisaLink module.

Single process by design: the EnvisaLink allows only one TPI client, so run this
with waitress (below) or `python app.py`, NOT under a multi-worker server.
"""

import functools
import io
import json
import logging
import os
import secrets
import sys
import threading
import time
import tomllib
from datetime import timedelta

from flask import (Flask, Response, flash, jsonify, redirect, render_template,
                   request, session, url_for)

import adio
import events
from eventlog import EventLog
from evlpanel import EVLPanel
from notifier import Notifier
from store import EMAIL, Store

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.environ.get("EVL_CONFIG", os.path.join(HERE, "config.toml"))
DATA_DIR = os.environ.get("EVL_DATA", os.path.join(HERE, "data"))

# E-mail notification form field -> setting name (text/number fields).
EMAIL_TEXT_FIELDS = ["destination", "source", "subject", "server", "username", "password"]
EMAIL_INT_FIELDS = ["port", "throttle_count", "throttle_minutes", "delay"]
EMAIL_BOOL_FIELDS = ["ssl", "tls", "authentication_required", "suppress_timestamp", "suppress"]


def load_config():
    with open(CONFIG_PATH, "rb") as f:
        return tomllib.load(f)


def get_secret_key():
    path = os.path.join(HERE, ".secret_key")
    if os.path.exists(path):
        with open(path) as f:
            return f.read().strip()
    key = secrets.token_hex(32)
    with open(path, "w") as f:
        f.write(key)
    os.chmod(path, 0o600)
    return key


config = load_config()

app = Flask(__name__)
app.secret_key = get_secret_key()
# Stay signed in until the browser's cookies are cleared (or Sign out). The
# secret key is persisted in .secret_key, so restarts don't log anyone out.
app.permanent_session_lifetime = timedelta(days=3650)

store = Store(DATA_DIR).load()
# seed zones from config.toml the first time, if the store has none
if not store.zones and config.get("zones"):
    for z in config["zones"]:
        store.zones[int(z["number"])] = {"name": z.get("name", "Zone %d" % int(z["number"])), "description": ""}
    store.save()

notifier = Notifier(store)
eventlog = EventLog(DATA_DIR)
eventlog.start_purger(store.log_retention_days)
panel = EVLPanel(config, store=store, notifier=notifier, eventlog=eventlog)
panel.start()


# ---- auth -------------------------------------------------------------------

def login_required(view):
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("authed"):
            if request.path.startswith("/api/"):
                return jsonify({"error": "unauthorized"}), 401
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)
    return wrapped


def check_csrf():
    token = session.get("csrf")
    body = request.get_json(silent=True) or {}
    sent = (request.headers.get("X-CSRF-Token") or request.form.get("csrf") or body.get("csrf"))
    return token and sent and secrets.compare_digest(str(token), str(sent))


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        pw = request.form.get("password", "")
        expected = str(config["web"].get("login_password", ""))
        if expected and secrets.compare_digest(pw, expected):
            session.permanent = True
            session["authed"] = True
            session["csrf"] = secrets.token_hex(16)
            dest = request.args.get("next") or url_for("index")
            if not dest.startswith("/"):
                dest = url_for("index")
            return redirect(dest)
        error = "Incorrect password."
    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


# ---- status page / api ------------------------------------------------------

@app.route("/")
@login_required
def index():
    return render_template("index.html", csrf=session.get("csrf"))


@app.route("/keypad")
@login_required
def keypad():
    return render_template("keypad.html", csrf=session.get("csrf"))


LOG_PAGE_SIZE = 100


@app.route("/log")
@login_required
def event_log():
    etype = request.args.get("type", "")
    etype = int(etype) if etype.lstrip("-").isdigit() else None
    text = request.args.get("q", "").strip()
    page = max(1, request.args.get("page", 1, type=int))
    rows, total = eventlog.query(etype, text, LOG_PAGE_SIZE, (page - 1) * LOG_PAGE_SIZE)
    for r in rows:
        r["when"] = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(r["ts"]))
        r["type_name"] = events.EVENT_TYPES.get(r["type"], "event %d" % r["type"])
    pages = max(1, (total + LOG_PAGE_SIZE - 1) // LOG_PAGE_SIZE)
    return render_template("log.html", rows=rows, total=total, page=page, pages=pages,
                           etype=etype, q=text, event_types=[(t, events.EVENT_TYPES[t]) for t in events.SUBSCRIPTIONS],
                           retention=store.log_retention_days(), csrf=session.get("csrf"))


@app.route("/log/retention", methods=["POST"])
@login_required
def event_log_retention():
    if not check_csrf():
        flash("Bad CSRF token.", "error")
        return redirect(url_for("event_log"))
    try:
        days = int(request.form.get("days", ""))
        if days < 0:
            raise ValueError
    except ValueError:
        flash("Enter a whole number of days (0 = keep forever).", "error")
        return redirect(url_for("event_log"))
    store.set_log_retention_days(days)
    purged = eventlog.purge(days)
    flash("Keeping %s of log history.%s" % (
        "all" if days == 0 else "%d day%s" % (days, "" if days == 1 else "s"),
        " Removed %d older entr%s." % (purged, "y" if purged == 1 else "ies") if purged else ""),
        "success")
    return redirect(url_for("event_log"))


@app.route("/log/clear", methods=["POST"])
@login_required
def event_log_clear():
    if not check_csrf():
        flash("Bad CSRF token.", "error")
    else:
        eventlog.clear()
        flash("Log cleared.", "success")
    return redirect(url_for("event_log"))


@app.route("/api/state")
@login_required
def api_state():
    return jsonify(panel.get_state())


COMMANDS = {
    "arm_away": lambda part, body: panel.arm_away(part),
    "arm_stay": lambda part, body: panel.arm_stay(part),
    "arm_night": lambda part, body: panel.arm_night(part),
    "disarm": lambda part, body: panel.disarm(part),
    "panic": lambda part, body: panel.panic(body.get("panic_type", "Police")),
    "bypass": lambda part, body: panel.toggle_bypass(int(body.get("zone", 0))),
    "keys": lambda part, body: panel.send_keys(body.get("keys", ""), part),
    "clear_trouble": lambda part, body: panel.clear_trouble(part),
}


@app.route("/api/command", methods=["POST"])
@login_required
def api_command():
    if not check_csrf():
        return jsonify({"error": "bad csrf token"}), 403
    body = request.get_json(silent=True) or {}
    action = body.get("action")
    partition = int(body.get("partition", 1))
    fn = COMMANDS.get(action)
    if fn is None:
        return jsonify({"error": "unknown action: %s" % action}), 400
    if not panel.connected:
        return jsonify({"error": "not connected to the EnvisaLink"}), 503
    try:
        fn(partition, body)
    except Exception as e:  # noqa: BLE001
        log.exception("command failed")
        return jsonify({"error": str(e)}), 500
    return jsonify({"ok": True, "action": action})


# ---- settings: notifications ------------------------------------------------

def _zone_choices():
    nums = set(store.zones.keys())
    nums.update(range(1, int(config["alarm"].get("num_zones", 0)) + 1))
    return [(n, store.zone_name(n) or ("Zone %d" % n)) for n in sorted(nums)]


@app.route("/settings")
@login_required
def settings_home():
    return render_template("settings/home.html", csrf=session.get("csrf"))


def _restart_soon():
    """Re-exec the process so the EnvisaLink reconnects with new settings.

    A restart (rather than a live reconnect) guarantees the old TPI socket is
    released first - the EnvisaLink allows only one client.
    """
    def _do():
        time.sleep(1.2)
        os.execv(sys.executable, [sys.executable] + sys.argv)
    threading.Thread(target=_do, daemon=True).start()


CONN_INT_FIELDS = ["port", "evl_version", "num_zones"]
CONN_TEXT_FIELDS = ["host", "username", "code", "panel_type"]


@app.route("/settings/connection", methods=["GET", "POST"])
@login_required
def settings_connection():
    if request.method == "POST":
        if not check_csrf():
            flash("Bad CSRF token.", "error")
            return redirect(request.url)
        updates = {}
        for f in CONN_TEXT_FIELDS:
            updates[f] = request.form.get(f, "").strip()
        for f in CONN_INT_FIELDS:
            try:
                updates[f] = int(request.form.get(f) or 0)
            except ValueError:
                updates[f] = 0
        # Only change the password when a new one is typed (blank = keep current).
        pw = request.form.get("password", "")
        if pw:
            updates["password"] = pw
        store.connection.update(updates)
        store.save_connection()
        flash("Connection settings saved - reconnecting (give it a few seconds).", "success")
        _restart_soon()
        return redirect(url_for("index"))

    return render_template("settings/connection.html", c=panel.conn, csrf=session.get("csrf"))


@app.route("/settings/notifications")
@login_required
def settings_notifications():
    return render_template("settings/notifications.html",
                           notifications=store.notifications,
                           type_names={EMAIL: "Email"},
                           alerts_enabled=store.email_alerts_enabled(),
                           csrf=session.get("csrf"))


@app.route("/settings/notifications/alerts", methods=["POST"])
@login_required
def settings_email_alerts():
    if not check_csrf():
        flash("Bad CSRF token.", "error")
    else:
        on = request.form.get("enabled") == "1"
        store.set_email_alerts_enabled(on)
        flash("Email alerts %s." % ("enabled" if on else "disabled - no alert emails will be sent"),
              "success")
    return redirect(url_for("settings_notifications"))


@app.route("/settings/notifications/new", methods=["GET", "POST"])
@app.route("/settings/notifications/<int:nid>", methods=["GET", "POST"])
@login_required
def settings_notification_edit(nid=None):
    n = store.get_notification(nid) if nid is not None else None
    if request.method == "POST":
        if not check_csrf():
            flash("Bad CSRF token.", "error")
            return redirect(request.url)
        settings = _email_settings_from_form(request.form)
        description = request.form.get("description", "Email")
        enabled = 1 if request.form.get("enabled") else 0
        if n is None:
            store.add_notification(description, EMAIL, settings, enabled)
        else:
            store.update_notification(n["id"], description, enabled, settings)
        flash("Notification saved.", "success")
        return redirect(url_for("settings_notifications"))

    return render_template("settings/email_form.html",
                           n=n, subscriptions=events.SUBSCRIPTIONS,
                           zone_choices=_zone_choices(),
                           current=_email_form_context(n),
                           csrf=session.get("csrf"))


@app.route("/settings/notifications/<int:nid>/delete", methods=["POST"])
@login_required
def settings_notification_delete(nid):
    if not check_csrf():
        flash("Bad CSRF token.", "error")
    else:
        store.delete_notification(nid)
        flash("Notification deleted.", "success")
    return redirect(url_for("settings_notifications"))


@app.route("/settings/notifications/<int:nid>/test", methods=["POST"])
@login_required
def settings_notification_test(nid):
    if not check_csrf():
        flash("Bad CSRF token.", "error")
        return redirect(url_for("settings_notifications"))
    ok, detail = notifier.test(nid)
    flash("Test %s: %s" % ("sent" if ok else "failed", detail), "success" if ok else "error")
    return redirect(url_for("settings_notifications"))


def _email_settings_from_form(form):
    s = {}
    for f in EMAIL_TEXT_FIELDS:
        s[f] = form.get(f, "")
    for f in EMAIL_INT_FIELDS:
        try:
            s[f] = int(form.get(f) or 0)
        except ValueError:
            s[f] = 0
    for f in EMAIL_BOOL_FIELDS:
        s[f] = 1 if form.get(f) else 0
    s["starttime"] = form.get("starttime") or "00:00:00"
    s["endtime"] = form.get("endtime") or "23:59:59"
    subs = {str(int(k)): True for k in form.getlist("subscriptions")}
    s["subscriptions"] = json.dumps(subs)
    s["zone_filter"] = json.dumps([int(z) for z in form.getlist("zone_filter")])
    return s


def _email_form_context(n):
    """Current values for the form; sensible defaults when creating."""
    s = dict(n["settings"]) if n else {}
    subs, zfilter = {}, []
    if s.get("subscriptions"):
        try:
            subs = {int(k): bool(v) for k, v in json.loads(s["subscriptions"]).items()}
        except (ValueError, TypeError):
            subs = {}
    elif not n:
        subs = {e: True for e in (events.ALARM, events.PANIC, events.FIRE, events.ARM, events.DISARM)}
    if s.get("zone_filter"):
        try:
            zfilter = [int(z) for z in json.loads(s["zone_filter"])]
        except (ValueError, TypeError):
            zfilter = []
    return {"s": s, "subs": subs, "zfilter": zfilter}


# ---- settings: message templates --------------------------------------------

@app.route("/settings/messages", methods=["GET", "POST"])
@login_required
def settings_messages():
    if request.method == "POST":
        if not check_csrf():
            flash("Bad CSRF token.", "error")
            return redirect(request.url)
        for etype in events.SUBSCRIPTIONS:
            val = request.form.get("msg_%d" % etype)
            if val is not None:
                store.messages[int(etype)] = val
        store.save()
        flash("Templates saved.", "success")
        return redirect(url_for("settings_messages"))

    rows = [(etype, label, store.message_for(etype)) for etype, label in events.SUBSCRIPTIONS.items()]
    return render_template("settings/messages.html", rows=rows, csrf=session.get("csrf"))


# ---- settings: import / export ----------------------------------------------

@app.route("/settings/export")
@login_required
def settings_export():
    filename, data = adio.export_bytes(store)
    return Response(data, mimetype="application/gzip",
                    headers={"Content-Disposition": "attachment; filename=%s" % filename})


@app.route("/settings/import", methods=["GET", "POST"])
@login_required
def settings_import():
    if request.method == "POST":
        if not check_csrf():
            flash("Bad CSRF token.", "error")
            return redirect(request.url)
        f = request.files.get("archive")
        if not f or not f.filename:
            flash("No file selected.", "error")
            return redirect(request.url)
        try:
            summary = adio.import_fileobj(store, io.BytesIO(f.read()))
        except Exception as e:  # noqa: BLE001
            log.exception("import failed")
            flash("Import failed: %s" % e, "error")
            return redirect(request.url)
        detail = ", ".join("%s=%s" % (k.replace(".json", ""), v) for k, v in sorted(summary.items()))
        flash("Import finished (%s). Restart not required." % (detail or "nothing imported"), "success")
        return redirect(url_for("settings_notifications"))
    return render_template("settings/import.html", csrf=session.get("csrf"))


if __name__ == "__main__":
    from waitress import serve
    web = config["web"]
    host = web.get("host", "0.0.0.0")
    port = int(web.get("port", 8080))
    log.info("Serving EnvisaLink webapp on http://%s:%d", host, port)
    serve(app, host=host, port=port, threads=8)
