# Sharing one EnvisaLink between this webapp and Home Assistant

The EnvisaLink module **accepts only one TPI client** on port 4025 at a time (it's
a hard firmware limit; the TPI spec says any further connection "will be denied").
If Home Assistant already holds that connection, this webapp can't connect and the
status badge sits on "reconnecting…".

There are two ways to run this webapp alongside Home Assistant. This document
records both so the trade-off is clear; we chose the **TPI proxy**.

## Background: which protocol?

The EnvisaLink comes in DSC and Honeywell firmware, and the two speak different TPI
protocols:

- **DSC**: numeric frames `CCC DDD CKS\r\n` with a 2-hex-digit checksum; login is
  `505`/`005`/`505`.
- **Honeywell** (this install): text login `Login:` → `<password>` → `OK`, and
  messages are `%..$` (updates) / `^..$` (commands), no checksums.

Both run over the same TCP port 4025, and the module's **web interface is on a
separate port 80**, which matters for approach B.

---

## Approach A — TPI proxy (chosen)

A small multiplexer holds the single real TPI connection to the EnvisaLink and
presents a listening port that several clients connect to and share. Home Assistant
and this webapp both point at the proxy instead of the EnvisaLink; neither knows the
difference.

```
            ┌──────────────┐        one TPI            ┌────────────┐
 HA  ──────▶│              │◀── connection (4025) ────▶│ EnvisaLink │
 webapp ───▶│  TPI proxy   │                           └────────────┘
 (others)──▶│  (port 4025) │   emulates the EnvisaLink login to each
            └──────────────┘   client; fans out all panel messages;
                               forwards every client command upstream.
```

- **Keeps real-time TPI** for every client: instant events, and — on Honeywell —
  the live virtual-keypad display. Nothing about this webapp changes; it just points
  pyenvisalink at the proxy (with `panel_type = HONEYWELL`).
- The proxy is protocol-agnostic for message bodies (forwarded verbatim); it only
  emulates the **session login** (Honeywell `Login:`/`OK`, or DSC `505`/`005`), and
  replays the last cached state messages to a newly-connected client so it has
  current state immediately.
- Runs anywhere on the LAN that can reach the EnvisaLink — an always-on **OpenWrt
  router** (`tpi-proxy/`, with a procd init script) or the Ubuntu box next to the
  webapp.
- Cost: one more small service to run. See `tpi-proxy/README.md`.

## Approach B — Web-service (HTTP) backend

The EnvisaLink's own web interface (port 80) is **independent of the TPI port**, so
it works even while Home Assistant holds the TPI connection. This webapp could log
in to that web UI, poll its status page, parse it, and send arm/disarm — no proxy.

What the Honeywell home page (`GET /2`) exposes, confirmed on this unit:

- Every zone as a cell whose `TITLE` says `CLOSED`/`OPEN` (+ "open N hours ago").
- System/partition status (`Ready`, armed, alarm, trouble) with a colour.
- An arm/disarm control: `GET /2?A=<action>&p=<partition>&X=<user code>`.

- **Pros**: zero extra services; coexists with HA; reads all zones and can control
  the panel.
- **Cons**: **polling**, not real-time (the page self-refreshes every 60s; we'd poll
  faster but still lag); **no live keypad display**; it's **HTML scraping** of an
  undocumented, unencrypted interface that a firmware update could change; and it
  needs a separate HTTP backend in the webapp (replacing pyenvisalink).

## Why we chose the proxy

This install is Honeywell, and we specifically want the **live keypad display and
real-time events** that TPI provides and the web page can't. The proxy keeps the
webapp unchanged and gives every client — HA included — full real-time access. The
HTTP backend remains a documented fallback if a proxy host is ever unavailable.
