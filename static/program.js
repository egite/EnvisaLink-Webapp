"use strict";

// Guided installer programming (Program page). Everything here becomes plain
// keypad keys sent through /api/command action "program"; the panel's own
// display (alpha text from /api/state) is shown so each step can be checked.

var CSRF = document.body.getAttribute("data-csrf");
var ZONES = JSON.parse(document.getElementById("zones-data").textContent);
var PARTITION = 1;
var CHUNK = 16;          // keys per request (the server's limit)
var CHUNK_GAP_MS = 700;  // pause between chunks so the panel keeps up

function pref(key, dflt) {
  try { var v = localStorage.getItem("evl." + key); return v === null ? dflt : JSON.parse(v); }
  catch (e) { return dflt; }
}
function setPref(key, v) {
  try { localStorage.setItem("evl." + key, JSON.stringify(v)); } catch (e) { /* private mode */ }
}

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function pad(n, w) { n = String(n); while (n.length < w) n = "0" + n; return n; }
function showKeys(keys) { return keys.replace(/\*/g, "✱"); }

// ---- panel model -------------------------------------------------------------

var modelSel = document.getElementById("pg-model");
modelSel.value = pref("pgModel", "20P");
function is20() { return modelSel.value.indexOf("20") === 0; }
function isSia() { return /SIA$/.test(modelSel.value); }
modelSel.addEventListener("change", function () {
  setPref("pgModel", modelSel.value);
  renderFieldList();
  if (currentField) openField(currentField);
  fillZoneSelects();
  renderNames();
  fillListForm();
});

function zoneNumbers() {
  var out = [], i;
  if (is20()) { for (i = 1; i <= 64; i++) out.push(i); }
  else {
    for (i = 1; i <= 6; i++) out.push(i);
    for (i = 9; i <= 34; i++) out.push(i);
    for (i = 49; i <= 56; i++) out.push(i);
  }
  return out;
}
function zoneName(n) {
  for (var i = 0; i < ZONES.length; i++) if (ZONES[i].number === n) return ZONES[i].name;
  return "";
}

// ---- live display --------------------------------------------------------------

var alpha = "", armed = false;
var runners = [];

function setConn(state) {
  var c = document.getElementById("conn");
  if (state.login_state === "failed") { c.className = "conn down"; c.textContent = "login failed"; return; }
  if (!state.connected) { c.className = "conn pending"; c.textContent = "connecting…"; return; }
  c.className = "conn ok"; c.textContent = "connected";
}

function render(state) {
  setConn(state);
  var ps = (state.partitions && state.partitions[PARTITION]) || {};
  alpha = (ps.alpha && ps.alpha !== "N/A") ? String(ps.alpha) : "";
  document.getElementById("lcd1").textContent = alpha.slice(0, 16) || " ";
  document.getElementById("lcd2").textContent = alpha.slice(16, 32) || " ";
  armed = !!(ps.armed_away || ps.armed_stay || ps.armed_zero_entry_delay);
  var st = document.getElementById("pg-state");
  st.textContent = !state.connected ? "not connected" : armed ? "ARMED" : ps.ready ? "ready" : "not ready";
  st.className = "pg-state" + (armed ? " armed" : "");
  document.getElementById("pg-enter").disabled = armed || !state.connected;
  runners.forEach(function (r) { r.refresh(); });
}

function poll() {
  fetch("/api/state", { credentials: "same-origin" })
    .then(function (r) { if (r.status === 401) { location.href = "/login"; return null; } return r.json(); })
    .then(function (s) { if (s) render(s); })
    .catch(function () { var c = document.getElementById("conn"); c.className = "conn down"; c.textContent = "offline"; });
}

function displayShows(words) {
  var text = alpha.toUpperCase().replace(/\s+/g, " ");
  return words.some(function (w) { return text.indexOf(w) >= 0; });
}

// ---- sending -------------------------------------------------------------------

function post(body) {
  return fetch("/api/command", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": CSRF },
    body: JSON.stringify(Object.assign({ action: "program", partition: PARTITION, csrf: CSRF }, body))
  })
    .then(function (r) { return r.json().then(function (j) { return r.ok ? null : (j.error || "failed"); }); })
    .catch(function () { return "network error"; });
}

// Send keys in chunks; resolves to null on success or an error string.
// `label` (what the step does) goes in the log with the first chunk; `secret`
// hides the keys on the page too.
var sending = false;
function sendProgram(keys, label, opts) {
  opts = opts || {};
  if (sending) return Promise.resolve("still sending the previous keys");
  sending = true;
  var last = document.getElementById("pg-last");
  last.textContent = "sending " + (opts.secret ? "code" : showKeys(keys)) + "…";
  var chunks = [];
  for (var i = 0; i < keys.length; i += CHUNK) chunks.push(keys.slice(i, i + CHUNK));
  var p = Promise.resolve(null);
  chunks.forEach(function (c, idx) {
    p = p.then(function (err) {
      if (err) return err;
      var body = { keys: c, label: idx === 0 ? label : "", enter: !!opts.enter && idx === 0 };
      if (opts.action) body.action = opts.action;
      var go = function () { return post(body); };
      return idx === 0 ? go() : new Promise(function (res) { setTimeout(res, CHUNK_GAP_MS); }).then(go);
    });
  });
  return p.then(function (err) {
    sending = false;
    last.textContent = err ? ("error: " + err) : ("sent " + (opts.secret ? "code" : showKeys(keys)));
    last.className = "pg-last" + (err ? " err" : "");
    setTimeout(poll, 400);
    setTimeout(poll, 1500);
    return err;
  });
}

// ---- mini keypad -----------------------------------------------------------------

var kpToggle = document.getElementById("pg-kp-toggle");
var kp = document.getElementById("pg-keypad");
function setKeypad(open) {
  kp.hidden = !open;
  kpToggle.setAttribute("aria-expanded", String(open));
  kpToggle.classList.toggle("on", open);
}
setKeypad(pref("pgKeypad", true));
kpToggle.addEventListener("click", function () { setPref("pgKeypad", kp.hidden); setKeypad(kp.hidden); });
kp.querySelectorAll(".key").forEach(function (btn) {
  btn.addEventListener("click", function () {
    btn.classList.add("pressed");
    setTimeout(function () { btn.classList.remove("pressed"); }, 120);
    // Plain keypad keys: logged once per burst like the main keypad.
    sendProgram(btn.getAttribute("data-key"), "", { action: "keys" });
  });
});

// ---- programming mode ------------------------------------------------------------

var codeIn = document.getElementById("pg-code");
var modeMsg = document.getElementById("pg-mode-msg");
document.getElementById("pg-enter").addEventListener("click", function () {
  var code = codeIn.value.trim();
  if (!/^\d{4}$/.test(code)) { modeMsg.textContent = "Enter the 4-digit installer code (factory default 4112)."; return; }
  sendProgram(code + "800", "entered programming mode", { secret: true, enter: true }).then(function (err) {
    modeMsg.textContent = err ? ("Error: " + err)
      : "Sent. The display should now show a field number or 'Program Mode'. If it says 'Installer Code' or nothing changed, check the code.";
  });
});
document.getElementById("pg-exit").addEventListener("click", function () {
  sendProgram("*99", "left programming mode").then(function (err) {
    modeMsg.textContent = err ? ("Error: " + err)
      : "Sent ✱99. The panel may show 'Busy Standby' or 'AC' for about a minute before it's ready.";
  });
});

// ---- tabs ----------------------------------------------------------------------

var tabs = document.querySelectorAll(".pg-tabs [data-tab]");
function showTab(name) {
  tabs.forEach(function (t) {
    var on = t.getAttribute("data-tab") === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
    document.getElementById("tab-" + t.getAttribute("data-tab")).hidden = !on;
  });
  setPref("pgTab", name);
}
tabs.forEach(function (t) { t.addEventListener("click", function () { showTab(t.getAttribute("data-tab")); }); });

// ---- step runner -------------------------------------------------------------------
// A step: {label, keys, show, expect: [words on the display before sending],
// expectText, note, secret}. Steps with no keys are things to do by hand ("trip the
// sensor"); their button just moves on.

function Runner(container) {
  this.box = container;
  this.steps = [];
  this.cur = 0;
  runners.push(this);
}
Runner.prototype.set = function (title, steps) {
  this.title = title;
  this.steps = steps;
  this.done = steps.map(function () { return false; });
  this.cur = 0;
  this.render();
  this.box.scrollIntoView({ behavior: "smooth", block: "start" });
};
Runner.prototype.advance = function (i) {
  this.done[i] = true;
  if (i === this.cur) this.cur = i + 1;
  this.render();
};
Runner.prototype.render = function () {
  var self = this;
  this.box.innerHTML = "";
  if (!this.steps.length) return;
  var head = el("div", "runner-head");
  head.appendChild(el("h3", null, this.title));
  var reset = el("button", "btn-sm", "Start over");
  reset.type = "button";
  reset.addEventListener("click", function () { self.cur = 0; self.done = self.steps.map(function () { return false; }); self.render(); });
  head.appendChild(reset);
  this.box.appendChild(head);
  this.box.appendChild(el("p", "hint", "Do one step at a time and watch the display. If the panel shows a prompt that isn't listed, press ✱ on the keypad to keep its current value."));

  var ol = el("ol", "steps");
  this.steps.forEach(function (s, i) {
    var li = el("li", "step" + (i === self.cur ? " current" : "") + (self.done[i] ? " done" : ""));
    var main = el("div", "step-main");
    main.appendChild(el("span", "step-label", s.label));
    if (s.keys) main.appendChild(el("code", "step-keys", s.secret ? "••••" : showKeys(s.show || s.keys)));
    li.appendChild(main);
    if (s.expect) {
      var ex = el("div", "step-expect");
      ex.appendChild(el("span", null, "Display should show: "));
      ex.appendChild(el("strong", null, s.expectText || s.expect[0]));
      ex.appendChild(el("span", "step-match"));
      li.appendChild(ex);
    }
    if (s.note) li.appendChild(el("div", "step-note", s.note));
    var acts = el("div", "step-actions");
    var go = el("button", "btn-sm" + (i === self.cur ? " primary" : ""),
                s.keys ? (self.done[i] ? "Send again" : "Send") : "Done");
    go.type = "button";
    go.addEventListener("click", function () {
      if (!s.keys) { self.advance(i); return; }
      go.disabled = true;
      sendProgram(s.keys, self.title + ": " + s.label, { secret: s.secret }).then(function (err) {
        go.disabled = false;
        if (err) { li.querySelector(".step-err") || li.appendChild(el("div", "step-err")); li.querySelector(".step-err").textContent = err; return; }
        self.advance(i);
      });
    });
    acts.appendChild(go);
    if (i === self.cur && !self.done[i]) {
      var skip = el("button", "btn-sm", "Skip");
      skip.type = "button";
      skip.addEventListener("click", function () { self.cur = i + 1; self.render(); });
      acts.appendChild(skip);
    }
    li.appendChild(acts);
    ol.appendChild(li);
  });
  this.box.appendChild(ol);
  if (this.cur >= this.steps.length) this.box.appendChild(el("p", "runner-done", "All steps done. Check the display, then carry on or exit with ✱99."));
  this.refresh();
};
Runner.prototype.refresh = function () {
  var self = this;
  this.box.querySelectorAll(".step").forEach(function (li, i) {
    var s = self.steps[i], m = li.querySelector(".step-match");
    if (!m || !s || !s.expect) return;
    var on = displayShows(s.expect);
    m.textContent = on ? "✓ showing now" : "";
    li.classList.toggle("expect-ok", on);
  });
};

// ---- data fields -----------------------------------------------------------------

function fieldVisible(f) {
  return !(f.only20 && !is20()) && !(f.sia && !isSia()) && !(f.nosia && isSia());
}
function entryVisible(e) { return !(e.p2 && !is20()) && !(e.sia && !isSia()); }
function entryOpts(e) { return (!is20() && e.opts15) || e.opts; }

var searchIn = document.getElementById("pg-search");
var currentField = null;

function renderFieldList() {
  var wrap = document.getElementById("pg-field-groups");
  var q = searchIn.value.trim().toLowerCase().replace(/^[*✱]/, "");
  wrap.innerHTML = "";
  PGM.sections.forEach(function (sec) {
    var items = sec.fields.filter(function (f) {
      return fieldVisible(f) && (!q || String(f.num).indexOf(q) === 0 || f.name.toLowerCase().indexOf(q) >= 0);
    });
    if (!items.length) return;
    var g = el("div", "pg-group");
    g.appendChild(el("div", "pg-group-title", sec.title));
    items.forEach(function (f) {
      var b = el("button", "pg-field" + (currentField === f ? " active" : ""));
      b.type = "button";
      b.appendChild(el("span", "pg-field-num", "✱" + f.num));
      b.appendChild(el("span", null, f.name));
      b.addEventListener("click", function () { openField(f); renderFieldList(); });
      g.appendChild(b);
    });
    wrap.appendChild(g);
  });
  if (!wrap.children.length) wrap.appendChild(el("p", "note", "No fields match."));
}
searchIn.addEventListener("input", renderFieldList);

function keyVal(v) { v = Number(v); return v >= 10 ? "#" + v : String(v); }

var PHONE_KEYS = { "*": "#11", "#": "#12", "P": "#13", ",": "#13" };
var ACCT_KEYS = { B: "#11", C: "#12", D: "#13", E: "#14", F: "#15" };

// Returns {keys} or {err}.
function encodeEntry(e, input) {
  var v, s, i, out;
  switch (e.t) {
    case "sel":
      return { keys: e.raw ? String(input.value) : keyVal(input.value) };
    case "bits":
      v = 0;
      input.querySelectorAll("input:checked").forEach(function (c) { v += Number(c.value); });
      return { keys: keyVal(v) };
    case "dd":
      s = input.value.trim();
      if (!/^\d{1,2}$/.test(s) || Number(s) < e.min || Number(s) > e.max) return { err: "Enter " + pad(e.min, 2) + "-" + e.max + "." };
      return { keys: pad(s, 2) };
    case "digits":
      s = input.value.trim();
      if (!new RegExp("^\\d{" + e.len + "}$").test(s)) return { err: "Enter exactly " + e.len + " digits." };
      return { keys: s };
    case "phone":
      s = input.value.toUpperCase().replace(/[\s\-().]/g, "");
      if (!s) return { err: "Enter a number (or use Clear field)." };
      if (!/^[0-9*#P,]+$/.test(s)) return { err: "Use 0-9, * , # and P (2-second pause)." };
      if (e.len && s.length !== e.len) return { err: "Enter exactly " + e.len + " keys." };
      if (e.max && s.length > e.max) return { err: "At most " + e.max + " positions." };
      out = "";
      for (i = 0; i < s.length; i++) out += PHONE_KEYS[s[i]] || s[i];
      return { keys: out + (!e.len && s.length < e.max ? "*" : "") };
    case "acct":
      s = input.value.toUpperCase().replace(/\s/g, "");
      if (!/^[0-9B-F]+$/.test(s)) return { err: "Use 0-9 and B-F." };
      if ([3, 4, 10].indexOf(s.length) < 0) return { err: "Enter 3, 4 or 10 characters (10 for 10-digit Contact ID)." };
      out = "";
      for (i = 0; i < s.length; i++) out += ACCT_KEYS[s[i]] || s[i];
      return { keys: out + (s.length === 3 ? "*" : "") };
  }
  return { err: "unknown entry type" };
}

function entryControl(e, dflt) {
  var c, opts;
  switch (e.t) {
    case "sel":
      c = el("select");
      opts = entryOpts(e);
      opts.forEach(function (o) {
        var op = el("option", null, o[1] + "  (" + o[0] + ")");
        op.value = o[0];
        c.appendChild(op);
      });
      if (dflt != null && opts.some(function (o) { return String(o[0]) === dflt; })) c.value = dflt;
      return c;
    case "bits":
      c = el("div", "chks");
      e.opts.forEach(function (o) {
        var l = el("label", "chk"), cb = el("input");
        cb.type = "checkbox"; cb.value = o[0];
        cb.checked = dflt != null && (Number(dflt) & o[0]) !== 0;
        l.appendChild(cb); l.appendChild(document.createTextNode(o[1]));
        c.appendChild(l);
      });
      return c;
    default:
      c = el("input");
      c.type = "text";
      if (e.t === "dd" || e.t === "digits") c.inputMode = "numeric";
      if (e.t === "dd" && dflt != null) c.value = dflt;
      if (e.hint) c.placeholder = e.hint;
      else if (e.t === "phone") c.placeholder = e.len ? e.len + " keys" : "up to " + e.max + " - * # and P for a pause allowed";
      else if (e.t === "acct") c.placeholder = "e.g. 1234 (B-F allowed)";
      return c;
  }
}

function openField(f) {
  currentField = f;
  var ed = document.getElementById("pg-editor");
  ed.innerHTML = "";
  var h = el("h3", null, "✱" + f.num + " " + f.name);
  ed.appendChild(h);
  ed.appendChild(el("div", "pg-default", "Factory default: " + f.dflt));
  if (f.help) ed.appendChild(el("p", "note", f.help));
  if (f.warn) ed.appendChild(el("p", "pg-warn", f.warn));

  var form = el("form", "form pg-entries");
  form.setAttribute("autocomplete", "off");
  var dflts = String(f.dflt).split(",");
  var controls = [];
  f.entries.forEach(function (e, i) {
    if (!entryVisible(e)) return;
    var l = el("label");
    if (f.entries.length > 1 || e.label) l.appendChild(el("span", null, e.label || ("Entry " + (i + 1))));
    var c = entryControl(e, dflts[i]);
    l.appendChild(c);
    if (e.t === "dd" && e.hint) l.appendChild(el("span", "hint", e.hint));
    form.appendChild(l);
    controls.push([e, c]);
  });

  var rawWrap = el("label", "chk"), rawCb = el("input"), rawIn = el("input");
  rawCb.type = "checkbox";
  rawWrap.appendChild(rawCb);
  rawWrap.appendChild(document.createTextNode("Type the entry keys myself"));
  rawIn.type = "text"; rawIn.hidden = true; rawIn.placeholder = "keys after ✱" + f.num + ", e.g. 30 or #12";
  form.appendChild(rawWrap);
  form.appendChild(rawIn);

  var preview = el("div", "pg-preview");
  form.appendChild(preview);
  var acts = el("div", "form-actions");
  var view = el("button", "btn-sm", "View current value (#" + f.num + ")"); view.type = "button";
  var send = el("button", "btn-sm primary", "Send to panel"); send.type = "submit";
  acts.appendChild(send);
  acts.appendChild(view);
  if (f.clearable) {
    var clr = el("button", "btn-sm danger", "Clear field (✱" + f.num + "✱)"); clr.type = "button";
    clr.addEventListener("click", function () {
      if (!confirm("Clear ✱" + f.num + " " + f.name + "?")) return;
      sendProgram("*" + f.num + "*", "cleared *" + f.num + " " + f.name).then(result);
    });
    acts.appendChild(clr);
  }
  form.appendChild(acts);
  var msg = el("div", "cmd-msg");
  form.appendChild(msg);
  ed.appendChild(form);

  function build() {
    if (rawCb.checked) {
      var r = rawIn.value.replace(/\s/g, "");
      if (!/^[0-9*#]+$/.test(r)) return { err: "Keys can be 0-9, * and #." };
      return { keys: "*" + f.num + r, show: "*" + f.num + " " + r };
    }
    var parts = ["*" + f.num];
    for (var i = 0; i < controls.length; i++) {
      var r2 = encodeEntry(controls[i][0], controls[i][1]);
      if (r2.err) return { err: (controls[i][0].label ? controls[i][0].label + ": " : "") + r2.err };
      parts.push(r2.keys);
    }
    return { keys: parts.join(""), show: parts.join(" ") };
  }
  function update() {
    var b = build();
    preview.innerHTML = "";
    if (b.err) { preview.appendChild(el("span", "pg-err", b.err)); send.disabled = true; return; }
    preview.appendChild(el("span", null, "Keys to send: "));
    preview.appendChild(el("code", null, showKeys(b.show)));
    send.disabled = false;
  }
  function result(err) {
    msg.textContent = err ? ("Error: " + err) : "Sent. The panel beeps three times and moves to the next field when the entry is complete.";
  }
  rawCb.addEventListener("change", function () { rawIn.hidden = !rawCb.checked; update(); });
  form.addEventListener("input", update);
  form.addEventListener("change", update);
  view.addEventListener("click", function () {
    sendProgram("#" + f.num, "viewed *" + f.num).then(function (err) {
      msg.textContent = err ? ("Error: " + err) : "The display shows the field's current value (nothing is changed in view mode).";
    });
  });
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var b = build();
    if (b.err) return;
    if (f.warn && !confirm(f.warn + "\n\nSend it?")) return;
    sendProgram(b.keys, "set *" + f.num + " " + f.name, { secret: f.num === 20 }).then(result);
  });
  update();
}

// ---- zones (*56) -------------------------------------------------------------------

var zoneRunner = new Runner(document.getElementById("zone-runner"));
var zNum = document.getElementById("z-num"), zType = document.getElementById("z-type");
var zInput = document.getElementById("z-input"), zEnroll = document.getElementById("z-enroll");

function fillSelect(sel, opts, keep) {
  var old = sel.value;
  sel.innerHTML = "";
  opts.forEach(function (o) { var op = el("option", null, o[1]); op.value = o[0]; sel.appendChild(op); });
  if (keep && opts.some(function (o) { return String(o[0]) === old; })) sel.value = old;
}

function fillZoneSelects() {
  var nums = zoneNumbers().map(function (n) {
    var nm = zoneName(n);
    return [n, pad(n, 2) + (nm ? " - " + nm : "")];
  }).concat([[91, "91 - addressable device reporting"], [92, "92 - duress"],
             [95, "95 - keypad 1 + ✱ panic"], [96, "96 - keypad 3 + # panic"], [99, "99 - keypad ✱ + # panic"]]);
  fillSelect(zNum, nums, true);
  fillSelect(zType, PGM.ZONE_TYPES.map(function (t) { return [t[0], pad(t[0], 2) + " - " + t[1]]; }), true);
  fillSelect(document.getElementById("z-hw"), PGM.HARDWIRE.filter(function (h) { return is20() || h[0] < 3; }), true);
  fillSelect(document.getElementById("z-rt"), PGM.RESPONSE, true);
  if (!document.getElementById("z-rt").dataset.init) { document.getElementById("z-rt").value = "1"; document.getElementById("z-rt").dataset.init = "1"; }
  document.getElementById("z-part-wrap").hidden = !is20();
  updateZoneForm();
}

function zoneDefaultType(z) { return z === 1 ? 9 : z === 2 ? 1 : z <= 8 ? 3 : z === 99 ? 6 : z >= 91 ? 0 : 3; }

function updateZoneForm() {
  var z = Number(zNum.value);
  var special = z >= 91, wired = z <= 8;
  document.getElementById("z-wired").hidden = !wired;
  document.getElementById("z-hw-wrap").hidden = z === 1;
  document.getElementById("z-rf").hidden = wired || special;
  fillSelect(zInput, PGM.INPUT_TYPES.filter(function (t) { return z >= 49 ? t[0] === 5 : t[0] !== 5; }), true);
  var rf = !wired && !special && zInput.value !== "2";
  document.getElementById("z-enroll-wrap").hidden = !rf;
  document.getElementById("z-serial-wrap").hidden = !rf || zEnroll.value !== "type";
  document.getElementById("z-confirm-wrap").hidden = !rf;
}
zNum.addEventListener("change", function () { zType.value = zoneDefaultType(Number(zNum.value)); updateZoneForm(); });
zInput.addEventListener("change", updateZoneForm);
zEnroll.addEventListener("change", updateZoneForm);

document.getElementById("zone-form").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var z = Number(zNum.value), zz = pad(z, 2), msg = document.getElementById("z-msg");
  var special = z >= 91, wired = z <= 8;
  var rf = !wired && !special && zInput.value !== "2";
  var typed = rf && zEnroll.value === "type";
  var confirmIt = rf && document.getElementById("z-confirm").checked;
  var serial = document.getElementById("z-serial").value.trim();
  if (typed && !/^\d{7}$/.test(serial)) { msg.textContent = "The serial number is the 7 digits on the sensor's label."; return; }
  msg.textContent = "";
  var tName = zType.options[zType.selectedIndex].text;

  var s = [
    { label: "Open zone programming", keys: "*56", note: "Needs programming mode. Skip this and the next step if the display already shows ENTER ZN NUM." },
    { label: "Set to confirm? " + (confirmIt ? "Yes" : "No"), keys: confirmIt ? "1*" : "0*", expect: ["CONFIRM"], expectText: "SET TO CONFIRM?" },
    { label: "Zone " + zz, keys: zz + "*", expect: ["ZN NUM", "ZONE NUM"], expectText: "ENTER ZN NUM." },
    { label: "Continue past the summary", keys: "*", note: "The display summarises zone " + zz + "'s current settings." },
    { label: "Zone type " + tName, keys: pad(zType.value, 2) + "*", expect: ["TYPE"], expectText: "ZONE TYPE" }
  ];
  if (is20()) s.push({ label: "Partition " + document.getElementById("z-part").value, keys: document.getElementById("z-part").value + "*", expect: ["PARTITION"] });
  var rc = document.getElementById("z-rc").value;
  s.push({ label: "Report code " + (rc === "00" ? "disabled" : "enabled"), keys: rc + "*", expect: ["REPORT"], expectText: "REPORT CODE" });
  if (wired) {
    if (z !== 1) {
      var hw = document.getElementById("z-hw");
      s.push({ label: "Hardwire type " + hw.options[hw.selectedIndex].text, keys: hw.value + "*", expect: ["HARDWIRE", "HW TYPE"], expectText: "HARDWIRE TYPE" });
    }
    var rt = document.getElementById("z-rt");
    s.push({ label: "Response time " + rt.options[rt.selectedIndex].text, keys: rt.value + "*", expect: ["RESPONSE", "RESP"], expectText: "RESPONSE TIME" });
  } else if (!special) {
    s.push({ label: "Input type " + zInput.options[zInput.selectedIndex].text, keys: zInput.value + "*", expect: ["INPUT"], expectText: "INPUT TYPE" });
    if (rf) {
      if (typed) {
        s.push({ label: "Serial " + serial + ", loop " + document.getElementById("z-loop").value,
                 keys: serial + "*" + document.getElementById("z-loop").value, expect: ["S/N", "SN"], expectText: "INPUT S/N",
                 note: "✱ between them moves the cursor to the loop (L) position." });
      } else {
        s.push({ label: "Trip the sensor twice", keys: "", expect: ["S/N", "SN"], expectText: "INPUT S/N",
                 note: "Open and close it twice (for a button, press it twice about 4 seconds apart). The display fills in the serial and loop." });
      }
      s.push({ label: "Accept the serial (duplicate check)", keys: "*" });
      s.push({ label: "Continue", keys: "*" });
      if (confirmIt) {
        s.push({ label: "Trip the sensor again to confirm", keys: "", expect: ["XMIT", "CONFIRM"], expectText: "XMIT TO CONFIRM",
                 note: "The keypad beeps 3 times when it matches. If it shows two different serial numbers, press # twice on the keypad and enroll again." });
        s.push({ label: "Continue", keys: "*" });
      }
    }
  }
  s.push({ label: "Accept the zone summary", keys: "*",
           note: "Skip this if the display already shows PROGRAM ALPHA?" });
  s.push({ label: "Program alpha? No (use the Zone names tab)", keys: "0*", expect: ["ALPHA"], expectText: "PROGRAM ALPHA?" });
  s.push({ label: "Leave zone programming", keys: "00", expect: ["ZN NUM", "ZONE NUM"], expectText: "ENTER ZN NUM.",
           note: "Or skip this and build the steps for another zone - the panel is waiting for a zone number. If the display doesn't change, press ✱." });
  zoneRunner.set("Zone " + zz, s);
});

// ---- zone names (*82) ------------------------------------------------------------

var namesRunner = new Runner(document.getElementById("names-runner"));
var VOCAB_WORDS = Object.keys(PGM.VOCAB).sort();
(function () {
  var dl = document.getElementById("vocab-list");
  VOCAB_WORDS.forEach(function (w) { var o = el("option"); o.value = w; dl.appendChild(o); });
})();

function vocabWord(w) {
  w = (w || "").trim().toUpperCase();
  if (PGM.VOCAB_ALIASES[w]) w = PGM.VOCAB_ALIASES[w];
  return Object.prototype.hasOwnProperty.call(PGM.VOCAB, w) ? w : null;
}

// Up to three vocabulary words from a web-app zone name, plus the words that didn't fit.
function suggestWords(n, name) {
  var toks = name.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  if (toks.length && Number(toks[0]) === n) toks.shift();
  var words = [], missing = [];
  toks.forEach(function (t) {
    var w = vocabWord(t);
    if (w && words.length < 3) words.push(w);
    else if (!w) missing.push(t);
  });
  return { words: words, missing: missing };
}

function renderNames() {
  var body = document.getElementById("names-body");
  body.innerHTML = "";
  var valid = zoneNumbers();
  ZONES.filter(function (z) { return valid.indexOf(z.number) >= 0; }).forEach(function (z) {
    var sug = suggestWords(z.number, z.name || "");
    var tr = el("tr");
    tr.dataset.zone = z.number;
    var tdc = el("td"), cb = el("input");
    cb.type = "checkbox"; cb.checked = !!z.name && sug.words.length > 0; cb.className = "nm-use";
    cb.setAttribute("aria-label", "Program zone " + z.number);
    tdc.appendChild(cb); tr.appendChild(tdc);
    var tdn = el("td", "nm-zone");
    tdn.appendChild(el("strong", null, pad(z.number, 2)));
    tdn.appendChild(el("span", null, " " + (z.name || "(no name)")));
    if (sug.missing.length) tdn.appendChild(el("div", "hint", "Not in the vocabulary: " + sug.missing.join(", ")));
    tr.appendChild(tdn);
    for (var i = 0; i < 3; i++) {
      var td = el("td"), inp = el("input", "nm-word");
      inp.type = "text"; inp.setAttribute("list", "vocab-list");
      inp.value = sug.words[i] || "";
      inp.setAttribute("aria-label", "Zone " + z.number + " word " + (i + 1));
      td.appendChild(inp);
      td.appendChild(el("span", "nm-code"));
      tr.appendChild(td);
    }
    body.appendChild(tr);
  });
  body.querySelectorAll(".nm-word").forEach(checkWord);
  if (!body.children.length) {
    var tr2 = el("tr"), td2 = el("td", "note", "No zones.");
    td2.colSpan = 5; tr2.appendChild(td2); body.appendChild(tr2);
  }
}
function checkWord(inp) {
  var w = vocabWord(inp.value), code = inp.parentNode.querySelector(".nm-code");
  var bad = inp.value.trim() && !w;
  inp.classList.toggle("bad", !!bad);
  code.textContent = bad ? "not a vocabulary word" : w ? pad(PGM.VOCAB[w], 3) : "";
}
document.getElementById("names-body").addEventListener("input", function (ev) {
  if (ev.target.classList.contains("nm-word")) checkWord(ev.target);
});

document.getElementById("names-build").addEventListener("click", function () {
  var rows = [], bad = false;
  document.querySelectorAll("#names-body tr[data-zone]").forEach(function (tr) {
    if (!tr.querySelector(".nm-use").checked) return;
    var words = [];
    tr.querySelectorAll(".nm-word").forEach(function (inp) {
      if (!inp.value.trim()) return;
      var w = vocabWord(inp.value);
      if (!w) bad = true; else words.push(w);
    });
    if (words.length) rows.push({ zone: Number(tr.dataset.zone), words: words });
  });
  if (bad) { alert("Some words aren't in the panel's vocabulary (marked in red). Pick words from the list."); return; }
  if (!rows.length) { alert("Tick at least one zone with words."); return; }
  var s = [
    { label: "Open descriptor programming", keys: "*82", note: "Needs programming mode." },
    { label: "Program alpha? Yes", keys: "1*", expect: ["ALPHA"], expectText: "PROGRAM ALPHA?" },
    { label: "Custom words? No", keys: "0*", expect: ["CUSTOM"], expectText: "CUSTOM WORDS?" }
  ];
  rows.forEach(function (r) {
    var zz = pad(r.zone, 2), keys = "", show = [];
    // Unused word slots get word 000 (blank) so old words don't linger.
    for (var i = 0; i < 3; i++) {
      var code = pad(r.words[i] ? PGM.VOCAB[r.words[i]] : 0, 3);
      keys += "#" + code + "6";
      show.push("#" + code + " 6");
    }
    s.push({ label: "Select zone " + zz, keys: "*" + zz + "*" + zz, show: "*" + zz + " *" + zz, expect: ["ZN"], expectText: "✱ ZN " + zz,
             note: "Shows the zone's current name, then a flashing cursor." });
    s.push({ label: "Name it " + r.words.join(" ") + " and save", keys: keys + "8", show: show.join(" ") + " 8",
             note: "Each word is # + its 3-digit number + 6; 8 saves." });
  });
  s.push({ label: "Back to Program alpha?", keys: "#" });
  s.push({ label: "Program alpha? No - back to data fields", keys: "0*", expect: ["ALPHA"], expectText: "PROGRAM ALPHA?" });
  namesRunner.set("Zone names", s);
});

// ---- zone lists (*81) -------------------------------------------------------------

var listRunner = new Runner(document.getElementById("list-runner"));

function fillListForm() {
  fillSelect(document.getElementById("l-num"), PGM.ZONE_LISTS.filter(function (l) { return is20() || l[0] <= 10; })
    .map(function (l) { return [l[0], pad(l[0], 2) + " - " + l[1]]; }), true);
  var box = document.getElementById("l-zones"), ticked = {};
  box.querySelectorAll("input:checked").forEach(function (c) { ticked[c.value] = true; });
  box.innerHTML = "";
  var valid = zoneNumbers();
  ZONES.filter(function (z) { return valid.indexOf(z.number) >= 0; }).forEach(function (z) {
    var l = el("label", "chk"), cb = el("input");
    cb.type = "checkbox"; cb.value = z.number; cb.checked = !!ticked[z.number];
    l.appendChild(cb);
    l.appendChild(document.createTextNode(pad(z.number, 2) + (z.name ? " " + z.name : "")));
    box.appendChild(l);
  });
}
document.getElementById("l-mode").addEventListener("change", function () {
  document.getElementById("l-zones-wrap").hidden = this.value === "delete";
});

document.getElementById("list-form").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var ll = pad(document.getElementById("l-num").value, 2), mode = document.getElementById("l-mode").value;
  var zones = [];
  document.querySelectorAll("#l-zones input:checked").forEach(function (c) { zones.push(pad(c.value, 2)); });
  var msg = document.getElementById("l-msg");
  if (mode !== "delete" && !zones.length) { msg.textContent = "Tick the zones."; return; }
  msg.textContent = "";
  var zkeys = zones.map(function (z) { return z + "*"; }).join("");
  var listStep = { label: "Zone list " + ll, keys: ll + "*", expect: ["LIST"], expectText: "ZONE LIST NO." };
  var doneAdding = { label: "Finish entering zones", keys: "00", expect: ["ZN NUM", "ZONE NUM"], expectText: "ENTER ZN NUM.",
                     note: "If the display doesn't move on to DEL ZN LIST?, press ✱." };
  var s = [{ label: "Open zone list programming", keys: "*81", note: "Needs programming mode." }];
  if (mode === "replace" || mode === "delete") {
    s.push(listStep, Object.assign({}, doneAdding, { label: "No zones to add" }),
           { label: "Delete zone list? Yes", keys: "1*", expect: ["DEL"], expectText: "DEL ZN LIST?" });
  }
  if (mode === "add" || mode === "replace") {
    s.push(Object.assign({}, listStep, mode === "replace" ? { note: "Skip if the display already shows ENTER ZN NUM." } : {}),
           { label: "Add zones " + zones.join(", "), keys: zkeys, show: zones.join("* ") + "*", expect: ["ZN NUM", "ZONE NUM"], expectText: "ENTER ZN NUM." },
           doneAdding,
           { label: "Delete zone list? No", keys: "0*", expect: ["DEL"], expectText: "DEL ZN LIST?" },
           { label: "Delete zones? No", keys: "0*", expect: ["DELETE"], expectText: "DELETE ZONE?" });
  }
  if (mode === "remove") {
    s.push(listStep, Object.assign({}, doneAdding, { label: "No zones to add" }),
           { label: "Delete zone list? No", keys: "0*", expect: ["DEL"], expectText: "DEL ZN LIST?" },
           { label: "Delete zones? Yes", keys: "1*", expect: ["DELETE"], expectText: "DELETE ZONE?" },
           { label: "Remove zones " + zones.join(", "), keys: zkeys, show: zones.join("* ") + "*", expect: ["DELETE", "DEL"], expectText: "ZN TO DELETE?" },
           { label: "Finish removing", keys: "00", note: "If the display doesn't change, press ✱." });
  }
  s.push({ label: "Leave zone lists", keys: "00", expect: ["LIST"], expectText: "ZONE LIST NO.",
           note: "Or skip this to change another list. If the display doesn't go back to a field number, press ✱." });
  listRunner.set("Zone list " + ll, s);
});

// ---- start ---------------------------------------------------------------------------

showTab(pref("pgTab", "fields"));
renderFieldList();
fillZoneSelects();
zType.value = zoneDefaultType(Number(zNum.value));
renderNames();
fillListForm();
poll();
setInterval(poll, 1000);
