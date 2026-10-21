"use strict";

var CSRF = document.body.getAttribute("data-csrf");
var POLL_MS = 1500;
var PARTITION = 1; // primary partition shown in the banner

function deriveState(s) {
  if (!s) return { cls: "state-unknown", label: "—" };
  if (s.alarm) return { cls: "state-alarm", label: "ALARM" };
  if (s.armed_away) return { cls: "state-armed", label: "ARMED — AWAY" };
  if (s.armed_stay) return { cls: "state-armed", label: "ARMED — STAY" };
  if (s.armed_zero_entry_delay) return { cls: "state-armed", label: "ARMED — NIGHT" };
  if (s.exit_delay) return { cls: "state-delay", label: "EXIT DELAY" };
  if (s.entry_delay) return { cls: "state-delay", label: "ENTRY DELAY" };
  if (s.ready) return { cls: "state-ready", label: "READY" };
  return { cls: "state-notready", label: "NOT READY" };
}

function badges(s) {
  var out = [];
  if (s) {
    if (s.fire) out.push(['bad', 'FIRE']);
    if (s.trouble) out.push(['warn', 'TROUBLE']);
    if (s.bat_trouble) out.push(['warn', 'BATTERY']);
    if (s.ac_present === false) out.push(['warn', 'AC LOST']);
    if (s.chime) out.push(['', 'CHIME']);
    if (s.alarm_in_memory) out.push(['warn', 'ALARM IN MEMORY']);
  }
  return out;
}

function setConn(state) {
  var el = document.getElementById("conn");
  if (state.login_state === "failed") { el.className = "conn down"; el.textContent = "login failed"; return; }
  if (state.login_state === "timeout") { el.className = "conn down"; el.textContent = "login timeout"; return; }
  if (!state.connected) { el.className = "conn pending"; el.textContent = "connecting…"; return; }
  if (state.stale_seconds != null && state.stale_seconds > 90) { el.className = "conn down"; el.textContent = "no data"; return; }
  el.className = "conn ok"; el.textContent = "connected";
}

function render(state) {
  setConn(state);

  var ps = (state.partitions && state.partitions[PARTITION]) || {};
  var d = deriveState(ps);

  var panel = document.getElementById("partition");
  panel.className = "panel " + d.cls;
  document.getElementById("state-label").textContent = d.label;

  var alpha = (ps.alpha && ps.alpha !== "N/A") ? ps.alpha : "";
  var alphaEl = document.getElementById("alpha");
  alphaEl.innerHTML = "";
  alphaEl.appendChild(document.createTextNode(alpha));
  var bs = badges(ps);
  if (bs.length) {
    var wrap = document.createElement("div");
    wrap.className = "badges";
    bs.forEach(function (b) {
      var span = document.createElement("span");
      span.className = "badge " + b[0];
      span.textContent = b[1];
      wrap.appendChild(span);
    });
    alphaEl.appendChild(wrap);
  }

  var list = document.getElementById("zone-list");
  list.innerHTML = "";
  var zones = state.zones || {};
  Object.keys(zones).forEach(function (n) {
    var z = zones[n];
    var li = document.createElement("li");
    var cls = "zone-ok", tag = "OK";
    if (z.alarm) { cls = "zone-alarm"; tag = "ALARM"; }
    else if (z.open || z.fault) { cls = "zone-open"; tag = "OPEN"; }
    if (z.bypassed) { cls += " zone-bypassed"; tag = "BYPASS"; }
    li.className = cls;

    var dot = document.createElement("span"); dot.className = "dot";
    var name = document.createElement("span"); name.className = "zone-name"; name.textContent = z.name;
    var t = document.createElement("span"); t.className = "zone-tag"; t.textContent = tag;
    li.appendChild(dot); li.appendChild(name); li.appendChild(t);
    list.appendChild(li);
  });
}

function poll() {
  fetch("/api/state", { credentials: "same-origin" })
    .then(function (r) { if (r.status === 401) { location.href = "/login"; return null; } return r.json(); })
    .then(function (s) { if (s) render(s); })
    .catch(function () { document.getElementById("conn").className = "conn down"; document.getElementById("conn").textContent = "offline"; });
}

function sendCommand(action, extra) {
  var msg = document.getElementById("cmd-msg");
  msg.textContent = "Sending…";
  var body = Object.assign({ action: action, partition: PARTITION, csrf: CSRF }, extra || {});
  fetch("/api/command", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": CSRF },
    body: JSON.stringify(body)
  })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      msg.textContent = res.ok ? ("Sent: " + action.replace("_", " ")) : ("Error: " + (res.j.error || "failed"));
      setTimeout(poll, 400);
      setTimeout(function () { msg.textContent = ""; }, 4000);
    })
    .catch(function () { msg.textContent = "Network error."; });
}

document.querySelectorAll(".btn[data-action]").forEach(function (btn) {
  btn.addEventListener("click", function () { sendCommand(btn.getAttribute("data-action")); });
});

poll();
setInterval(poll, POLL_MS);
