"use strict";

var CSRF = document.body.getAttribute("data-csrf");
var POLL_MS = 1200;
var PARTITION = 1;

function setConn(state) {
  var el = document.getElementById("conn");
  if (!el) return;
  if (state.login_state === "failed") { el.className = "conn down"; el.textContent = "login failed"; return; }
  if (state.login_state === "timeout") { el.className = "conn pending"; el.textContent = "reconnecting…"; return; }
  if (!state.connected) { el.className = "conn pending"; el.textContent = "connecting…"; return; }
  if (state.stale_seconds != null && state.stale_seconds > 90) { el.className = "conn pending"; el.textContent = "reconnecting…"; return; }
  el.className = "conn ok"; el.textContent = "connected";
}

function deriveLabel(s) {
  if (!s) return "—";
  if (s.alarm) return "ALARM";
  if (s.armed_away) return "Armed — Away";
  if (s.armed_stay) return "Armed — Stay";
  if (s.armed_zero_entry_delay) return "Armed — Night";
  if (s.exit_delay) return "Exit Delay";
  if (s.entry_delay) return "Entry Delay";
  if (s.ready) return "Ready";
  return "Not Ready";
}

function setLed(name, on) {
  var el = document.querySelector('.led[data-led="' + name + '"]');
  if (el) el.classList.toggle("on", !!on);
}

function render(state) {
  setConn(state);
  var s = (state.partitions && state.partitions[PARTITION]) || {};
  // Prefer the panel's own LCD text (alpha); fall back to a derived label.
  var lcd = (s.alpha && s.alpha !== "N/A") ? s.alpha : deriveLabel(s);
  document.getElementById("lcd-line").textContent = lcd;

  setLed("ready", s.ready);
  setLed("armed", s.armed_away || s.armed_stay || s.armed_zero_entry_delay);
  setLed("memory", s.alarm_in_memory);
  setLed("bypass", s.bypass);
  setLed("trouble", s.trouble || s.bat_trouble);
  setLed("fire", s.fire);
  setLed("chime", s.chime);
  setLed("ac", s.ac_present !== false);
}

function poll() {
  fetch("/api/state", { credentials: "same-origin" })
    .then(function (r) { if (r.status === 401) { location.href = "/login"; return null; } return r.json(); })
    .then(function (s) { if (s) render(s); })
    .catch(function () {
      var el = document.getElementById("conn");
      if (el) { el.className = "conn down"; el.textContent = "offline"; }
    });
}

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
  var k = e.key;
  if (/^[0-9*#]$/.test(k)) {
    var btn = document.querySelector('.key[data-key="' + (k === "*" ? "*" : k) + '"]');
    if (btn) { btn.click(); e.preventDefault(); }
  }
});

poll();
setInterval(poll, POLL_MS);
