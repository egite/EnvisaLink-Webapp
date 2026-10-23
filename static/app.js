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
  if (!el) return;
  // A rejected password is a real error; a timeout just means it hasn't
  // reached the panel yet and is retrying (pyenvisalink reconnects every 30s).
  if (state.login_state === "failed") { el.className = "conn down"; el.textContent = "login failed"; return; }
  if (state.login_state === "timeout") { el.className = "conn pending"; el.textContent = "reconnecting…"; return; }
  if (!state.connected) { el.className = "conn pending"; el.textContent = "connecting…"; return; }
  if (state.stale_seconds != null && state.stale_seconds > 90) { el.className = "conn pending"; el.textContent = "reconnecting…"; return; }
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

  var clr = document.getElementById("btn-clear-trouble");
  var armed = ps.armed_away || ps.armed_stay || ps.armed_zero_entry_delay;
  clr.disabled = !!armed;
  clr.classList.toggle("attention", !armed && !!(ps.trouble || ps.bat_trouble || ps.alarm_in_memory || ps.ac_present === false));

  lastState = state;
  renderZones(state.zones || {});
}

// ---- zones: grouped by kind, collapsible, filterable ----------------------

var KINDS = [
  ["door", "Doors"], ["garage", "Garage"], ["window", "Windows"], ["glass", "Glass break"],
  ["motion", "Motion"], ["water", "Water"], ["temp", "Temperature"], ["smoke", "Smoke / fire"],
  ["mail", "Mailbox"], ["other", "Other"]
];

var ICONS = {
  door: '<path d="M6 3h12v18H6z"/><circle cx="14.5" cy="12" r="1"/>',
  garage: '<path d="M3 10l9-6 9 6v11H3z"/><path d="M7 21v-8h10v8M7 16h10"/>',
  window: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M12 3v18M4 12h16"/>',
  glass: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M12 3l-2 6 4 3-2 9M10 9L4 11M14 12l6-2"/>',
  motion: '<circle cx="13" cy="4.5" r="2"/><path d="M9 21l2.5-6 3 3v3M11.5 15l1-5.5 3.5 3h3M12.5 9.5L9 11l-1 3"/>',
  water: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
  temp: '<path d="M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0z"/><path d="M12 9v7"/>',
  smoke: '<path d="M12 3c1 4 5 6 5 11a5 5 0 0 1-10 0c0-3 2-4 2-7 2 1 3 3 3 5"/>',
  mail: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 7l9 6 9-6"/>',
  other: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/>'
};

function icon(kind) {
  return '<svg class="zicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
         'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[kind] || ICONS.other) + '</svg>';
}

// Per-browser view preferences.
function pref(key, dflt) {
  try { var v = localStorage.getItem("evl." + key); return v === null ? dflt : JSON.parse(v); }
  catch (e) { return dflt; }
}
function setPref(key, v) {
  try { localStorage.setItem("evl." + key, JSON.stringify(v)); } catch (e) { /* private mode */ }
}

var lastState = null;
var optFaulted = document.getElementById("opt-faulted");
var optUnnamed = document.getElementById("opt-unnamed");
optFaulted.checked = pref("faultedOnly", true);
optUnnamed.checked = pref("showUnnamed", false);
[[optFaulted, "faultedOnly"], [optUnnamed, "showUnnamed"]].forEach(function (p) {
  p[0].addEventListener("change", function () {
    setPref(p[1], p[0].checked);
    if (lastState) renderZones(lastState.zones || {});
  });
});

function zoneStatus(z) {
  if (z.alarm) return ["zone-alarm", "ALARM"];
  if (z.bypassed) return ["zone-bypassed", "BYPASS"];
  if (z.open || z.fault) return ["zone-open", "OPEN"];
  return ["zone-ok", "OK"];
}

function renderZones(zones) {
  var wrap = document.getElementById("zone-groups");
  var faultedOnly = optFaulted.checked, showUnnamed = optUnnamed.checked;
  var collapsed = pref("collapsed", {});
  var groups = {}, totalShown = 0, totalZones = 0;

  Object.keys(zones).sort(function (a, b) { return a - b; }).forEach(function (n) {
    var z = zones[n];
    if (!z.named && !showUnnamed) return;
    totalZones++;
    var st = zoneStatus(z);
    var g = groups[z.kind] || (groups[z.kind] = { all: 0, faulted: 0, items: [] });
    g.all++;
    if (st[0] !== "zone-ok") g.faulted++;
    if (faultedOnly && st[0] === "zone-ok") return;
    g.items.push([n, z, st]);
    totalShown++;
  });

  wrap.innerHTML = "";
  KINDS.forEach(function (k) {
    var g = groups[k[0]];
    if (!g || !g.items.length) return;
    var sec = document.createElement("section");
    sec.className = "zgroup" + (collapsed[k[0]] ? " collapsed" : "") + (g.faulted ? " has-faults" : "");
    var head = document.createElement("button");
    head.type = "button";
    head.className = "zgroup-head";
    head.innerHTML = icon(k[0]) + '<span class="zgroup-name"></span><span class="zgroup-count"></span><span class="chev">&#9662;</span>';
    head.querySelector(".zgroup-name").textContent = k[1];
    head.querySelector(".zgroup-count").textContent =
      g.faulted ? (g.faulted + " of " + g.all + " not OK") : (g.all + " OK");
    head.addEventListener("click", function () {
      var c = pref("collapsed", {});
      c[k[0]] = !c[k[0]];
      setPref("collapsed", c);
      sec.classList.toggle("collapsed", !!c[k[0]]);
    });
    sec.appendChild(head);

    var ul = document.createElement("ul");
    ul.className = "zone-list";
    g.items.forEach(function (it) {
      var z = it[1], st = it[2];
      var li = document.createElement("li");
      li.className = st[0];
      li.innerHTML = icon(z.kind) + '<span class="zone-name"></span><span class="zone-tag"></span>';
      li.querySelector(".zone-name").textContent = z.name;
      li.querySelector(".zone-tag").textContent = st[1];
      ul.appendChild(li);
    });
    sec.appendChild(ul);
    wrap.appendChild(sec);
  });

  if (!totalShown) {
    var p = document.createElement("p");
    p.className = "zones-empty";
    p.textContent = faultedOnly
      ? "All " + totalZones + " zones are closed."
      : "No zones to show.";
    wrap.appendChild(p);
  }
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

document.querySelectorAll("button[data-action]").forEach(function (btn) {
  btn.addEventListener("click", function () { sendCommand(btn.getAttribute("data-action")); });
});

// ---- keypad ----------------------------------------------------------------

function sendKey(k) {
  var msg = document.getElementById("kp-msg");
  fetch("/api/command", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": CSRF },
    body: JSON.stringify({ action: "keys", keys: k, partition: PARTITION, csrf: CSRF })
  })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      msg.textContent = res.ok ? ("sent " + k) : ("error: " + (res.j.error || "failed"));
      setTimeout(poll, 300);
      setTimeout(function () { if (msg.textContent.indexOf("error") !== 0) msg.textContent = ""; }, 2500);
    })
    .catch(function () { msg.textContent = "network error"; });
}

document.querySelectorAll(".key").forEach(function (btn) {
  btn.addEventListener("click", function () {
    btn.classList.add("pressed");
    setTimeout(function () { btn.classList.remove("pressed"); }, 120);
    sendKey(btn.getAttribute("data-key"));
  });
});

// physical keyboard support
document.addEventListener("keydown", function (e) {
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^[0-9*#]$/.test(e.key)) {
    var btn = document.querySelector('.key[data-key="' + e.key + '"]');
    if (btn) { btn.click(); e.preventDefault(); }
  }
});

poll();
setInterval(poll, POLL_MS);
