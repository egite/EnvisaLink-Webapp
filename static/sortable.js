"use strict";

// Click-to-sort for <table class="sortable" data-sort-key="...">. Headings with
// data-sort become buttons; click again to reverse. Text compares naturally
// ("2 Door" before "10 Window"). The choice is remembered per browser.
(function () {
  var collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  function load(key) {
    try { return JSON.parse(localStorage.getItem("evl.sort." + key)) || null; } catch (e) { return null; }
  }
  function save(key, v) {
    try { localStorage.setItem("evl.sort." + key, JSON.stringify(v)); } catch (e) { /* private mode */ }
  }

  document.querySelectorAll("table.sortable").forEach(function (table) {
    var key = table.getAttribute("data-sort-key") || "table";
    var tbody = table.tBodies[0];
    var heads = Array.prototype.slice.call(table.tHead.rows[0].cells);

    function cellText(row, col) {
      var c = row.cells[col];
      return c ? (c.getAttribute("data-sort-value") || c.textContent).trim() : "";
    }

    function apply(col, dir) {
      var rows = Array.prototype.slice.call(tbody.rows);
      rows.sort(function (a, b) {
        return dir * collator.compare(cellText(a, col), cellText(b, col));
      });
      rows.forEach(function (r) { tbody.appendChild(r); });
      heads.forEach(function (th, i) {
        th.setAttribute("aria-sort", i === col ? (dir > 0 ? "ascending" : "descending") : "none");
      });
    }

    heads.forEach(function (th, col) {
      if (!th.hasAttribute("data-sort")) return;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sort-btn";
      btn.innerHTML = th.innerHTML + '<span class="sort-ind" aria-hidden="true"></span>';
      th.innerHTML = "";
      th.appendChild(btn);
      btn.addEventListener("click", function () {
        var cur = load(key);
        var dir = (cur && cur.col === col) ? -cur.dir : 1;
        save(key, { col: col, dir: dir });
        apply(col, dir);
      });
    });

    var saved = load(key);
    if (saved && heads[saved.col] && heads[saved.col].hasAttribute("data-sort")) apply(saved.col, saved.dir);
  });
})();
