#!/usr/bin/env python3
"""
EnvisaLink TPI multiplexing proxy.

The EnvisaLink accepts only one TPI client on port 4025. This proxy holds that one
connection and presents its own listening port that several clients (Home Assistant,
this webapp, ...) connect to and share.

Panel traffic (zone, partition and keypad messages) is fanned out to all logged-in
clients verbatim, and every command a client sends is forwarded upstream verbatim.
The protocol-specific parts are:

- The *session login*, which the proxy emulates for each client (Honeywell
  `Login:`/`OK`, or DSC `505`/`005`). When a new client logs in, the proxy replays
  the last cached state messages so it has current state right away.
- *Command replies* (Honeywell `^xx,yy$`, DSC `500`/`501`/`502`). The EnvisaLink
  answers commands one at a time, in order, so the proxy remembers who sent each
  command and hands the reply to that client only. Clients that pair replies with
  their own commands (e.g. Home Assistant's envisalink_new, whose keepalive drops
  the connection if its `^00` poll goes unanswered) never see another client's
  replies. Replies to the proxy's own keepalive and refresh go to nobody.
- *EnvisaLink link down or hung.* The proxy never lets a client's command go
  unanswered: if the EnvisaLink hasn't replied within REPLY_TIMEOUT seconds (less
  than Home Assistant's 5 s command timeout), or the link is down, the proxy answers
  it itself (keepalive polls: OK; anything else: a retryable "busy" error). The
  EnvisaLink sometimes goes silent for a couple of minutes while the TCP connection
  still looks open; without this, Home Assistant's envisalink_new drops its
  connection, every zone goes "unavailable", and every zone's last-changed time
  resets. A link that is closed, or has left a command unanswered for STALL_TIMEOUT
  seconds, counts as down. If it stays down longer than DOWN_GRACE seconds, the
  proxy disconnects its clients and refuses new ones until the EnvisaLink is back,
  so they see the outage instead of a fake "alive".

Pure standard library (asyncio) - no dependencies. Runs on an OpenWrt router
(python3-light) or any always-on LAN host. Configure with flags or env vars:

  EVL_HOST, EVL_PORT, EVL_PASS, LISTEN_HOST, LISTEN_PORT, CLIENT_PASS, PANEL,
  KEEPALIVE, DOWN_GRACE, REPLY_TIMEOUT, STALL_TIMEOUT

  tpi_proxy.py --evl-host 192.168.21.123 --evl-pass SECRET --panel honeywell
"""

import argparse
import asyncio
import collections
import logging
import os
import time

log = logging.getLogger("tpi-proxy")

CRLF = b"\r\n"

# reply_code() returns this for a reply that names no command (DSC 501/502): it
# belongs to the oldest command still waiting.
OLDEST = object()

# Forget a command after this long without a reply (the EVL dropped it).
PENDING_MAX_AGE = 15.0


def _dsc_checksum(payload: bytes) -> bytes:
    total = sum(payload) & 0xFF
    return ("%02X" % total).encode("ascii")


def _dsc_frame(cmd: str, data: str = "") -> bytes:
    payload = (cmd + data).encode("ascii")
    return payload + _dsc_checksum(payload) + CRLF


class HoneywellProfile:
    """Text login: EVL sends 'Login:', client sends password, EVL replies 'OK'."""
    name = "honeywell"
    # Messages whose latest copy is worth replaying to a new client (current state).
    cache_prefixes = (b"%00", b"%02", b"%FF")
    refresh_cmd = b"^02,$" + CRLF        # dump zone timers -> fresh %FF
    poll_cmd = b"^00,$" + CRLF           # keepalive / watchdog poll
    poll_code = b"00"

    def cache_key(self, line: bytes):
        head = line.split(b",", 1)[0].strip()
        return head if head in self.cache_prefixes else None

    @staticmethod
    def _code(line: bytes):
        # "^03,1,5$" -> b"03";  "^00,$" -> b"00";  "^00,00$" -> b"00"
        if not line.startswith(b"^"):
            return None
        return line[1:].split(b",", 1)[0].split(b"$", 1)[0].strip() or None

    def cmd_code(self, line: bytes):
        """Command code of a client line, or None if it isn't a command."""
        return self._code(line)

    def reply_code(self, line: bytes):
        """Command code an EVL reply answers, or None if it isn't a reply."""
        return self._code(line)

    def local_reply(self, code: bytes) -> bytes:
        """What the proxy answers itself while the EVL link is down."""
        if code == b"00":
            return b"^00,00$" + CRLF              # poll: accepted
        return b"^" + code + b",01$" + CRLF       # 01 = receive buffer overrun (retry)

    async def login_upstream(self, reader, writer, password):
        # Read line-by-line so the stream buffer keeps any state message the EVL
        # sends immediately after "OK" for the main read loop.
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=15)
            if not line:
                raise ConnectionError("EVL closed during login")
            if b"Login:" in line:
                break
        writer.write(password.encode("ascii") + CRLF)
        await writer.drain()
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=15)
            if not line:
                raise ConnectionError("EVL closed during login")
            if b"OK" in line:
                return
            if b"FAILED" in line or b"Timed Out" in line:
                raise ConnectionError("EVL rejected password")

    async def login_downstream(self, reader, writer, client_pass):
        writer.write(b"Login:" + CRLF)
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), timeout=30)
        if not line:
            return False
        given = line.strip().decode("ascii", "ignore")
        if client_pass and given != client_pass:
            writer.write(b"FAILED" + CRLF)
            await writer.drain()
            return False
        writer.write(b"OK" + CRLF)
        await writer.drain()
        return True


class DscProfile:
    """Numeric login: EVL sends 505|3, client sends 005|pass, EVL replies 505|1."""
    name = "dsc"
    cache_prefixes = ()
    refresh_cmd = _dsc_frame("001")      # status report -> rebroadcast of state
    poll_cmd = _dsc_frame("000")         # keepalive / watchdog poll
    poll_code = b"000"

    def cache_key(self, line: bytes):
        return None

    def cmd_code(self, line: bytes):
        head = line[:3]
        return head if len(line) >= 5 and head.isdigit() else None

    def reply_code(self, line: bytes):
        if line.startswith(b"500"):
            return line[3:6]                      # 500 + the acknowledged command
        if line.startswith(b"501") or line.startswith(b"502"):
            return OLDEST                         # checksum / system error, no command
        return None

    def local_reply(self, code: bytes) -> bytes:
        if code == b"000":
            return _dsc_frame("500", "000")       # poll: acknowledged
        return _dsc_frame("502", "001")           # 001 = receive buffer overrun (retry)

    async def login_upstream(self, reader, writer, password):
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=15)
            if not line:
                raise ConnectionError("EVL closed during login")
            if line.startswith(b"505") and line[3:4] == b"3":
                break
        writer.write(_dsc_frame("005", password))
        await writer.drain()
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=15)
            if not line:
                raise ConnectionError("EVL closed during login")
            if line.startswith(b"505"):
                if line[3:4] == b"1":
                    return
                if line[3:4] in (b"0", b"2"):
                    raise ConnectionError("EVL rejected password")

    async def login_downstream(self, reader, writer, client_pass):
        writer.write(_dsc_frame("505", "3"))
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), timeout=30)
        if not line or not line.startswith(b"005"):
            writer.write(_dsc_frame("505", "0"))
            await writer.drain()
            return False
        given = line[3:-4].decode("ascii", "ignore")   # strip 005 ... CKS CRLF
        if client_pass and given != client_pass:
            writer.write(_dsc_frame("505", "0"))
            await writer.drain()
            return False
        writer.write(_dsc_frame("505", "1"))
        await writer.drain()
        return True


PROFILES = {"honeywell": HoneywellProfile, "dsc": DscProfile}


class Proxy:
    def __init__(self, evl_host, evl_port, evl_pass, listen_host, listen_port,
                 client_pass, profile, keepalive, down_grace=300,
                 reply_timeout=3.0, stall_timeout=10.0):
        self.evl_host = evl_host
        self.evl_port = evl_port
        self.evl_pass = evl_pass
        self.listen_host = listen_host
        self.listen_port = listen_port
        self.client_pass = client_pass
        self.profile = profile
        self.keepalive = keepalive
        self.down_grace = down_grace
        self.reply_timeout = reply_timeout
        self.stall_timeout = stall_timeout

        self.clients = set()             # writers of logged-in clients
        self.upstream_writer = None
        self.down_since = time.monotonic()   # None while the EVL link is connected
        self.stall_logged = False
        self.last_reply = 0.0            # when the EVL last answered any command
        self.cache = {}                  # prefix -> last raw line
        # Commands sent upstream and not yet answered by the EVL, oldest first:
        # [owner writer, command code, time sent]. owner is None for the proxy's own
        # commands, and for ones the proxy already answered itself after
        # reply_timeout; the entry stays so a late EVL reply is matched and dropped.
        self.pending = collections.deque()

    # ---- upstream (the one real EnvisaLink connection) ----------------------

    async def upstream_loop(self):
        while True:
            try:
                await self._run_upstream()
            except Exception as e:  # noqa: BLE001
                log.warning("upstream connection failed: %s", e)
            self._upstream_down()
            await asyncio.sleep(5)

    def _upstream_down(self):
        self.upstream_writer = None
        if self.down_since is None:
            self.down_since = time.monotonic()
        # Those commands' replies are lost with the connection; answer them now so
        # the clients aren't left waiting.
        while self.pending:
            owner, code, _ = self.pending.popleft()
            if owner is not None and code is not None:
                self._write(owner, self.profile.local_reply(code))

    async def _run_upstream(self):
        log.info("connecting to EnvisaLink %s:%s", self.evl_host, self.evl_port)
        reader, writer = await asyncio.open_connection(self.evl_host, self.evl_port)
        try:
            await self.profile.login_upstream(reader, writer, self.evl_pass)
        except BaseException:
            writer.close()
            raise
        self.pending.clear()
        self.upstream_writer = writer
        self.down_since = None
        self.stall_logged = False
        log.info("logged in to EnvisaLink; %d client(s) connected", len(self.clients))
        ka = asyncio.create_task(self._keepalive(writer))
        try:
            while True:
                line = await reader.readline()
                if not line:
                    raise ConnectionError("EVL closed the connection")
                key = self.profile.cache_key(line)
                if key:
                    self.cache[key] = line
                code = self.profile.reply_code(line)
                if code is None:
                    self._broadcast(line)
                else:
                    self.last_reply = time.monotonic()
                    self._route_reply(code, line)
                    if self.stall_logged and not self._stalled():
                        self.stall_logged = False
                        log.info("EnvisaLink answering commands again")
        finally:
            ka.cancel()
            self._upstream_down()
            writer.close()

    async def _keepalive(self, writer):
        # Clients send their own keepalives (forwarded upstream); this is a backstop
        # so the EnvisaLink watchdog never fires even if every client is idle.
        while True:
            await asyncio.sleep(self.keepalive)
            if not self._send_upstream(None, self.profile.poll_cmd):
                return
            try:
                await writer.drain()
            except Exception:  # noqa: BLE001
                return

    def _send_upstream(self, owner, line):
        """Forward a line to the EVL, remembering who to give the reply to.
        Returns False if the EVL link is down."""
        w = self.upstream_writer
        if w is None:
            return False
        code = self.profile.cmd_code(line)
        if code is not None:
            self.pending.append([owner, code, time.monotonic()])
        try:
            w.write(line)
        except Exception:  # noqa: BLE001
            if code is not None:
                self.pending.pop()
            return False
        return True

    def _route_reply(self, code, line):
        """Give a command reply to the client that sent that command, only."""
        now = time.monotonic()
        while self.pending and now - self.pending[0][2] > PENDING_MAX_AGE:
            owner, old, _ = self.pending.popleft()
            log.debug("no reply to %r from %s; forgetting it", old, self._peer(owner))
        entry = None
        if code is OLDEST:
            if self.pending:
                entry = self.pending.popleft()
        else:
            for e in self.pending:
                if e[1] == code:
                    entry = e
                    break
            if entry is not None:
                self.pending.remove(entry)
        if entry is None:
            log.debug("reply %r matches no pending command; dropped", line.strip())
            return
        owner = entry[0]
        if owner is not None and owner in self.clients:
            self._write(owner, line)

    @staticmethod
    def _peer(writer):
        if writer is None:
            return "proxy"
        try:
            return writer.get_extra_info("peername")
        except Exception:  # noqa: BLE001
            return "?"

    def _write(self, w, line):
        try:
            w.write(line)
        except Exception:  # noqa: BLE001
            self.clients.discard(w)

    def _broadcast(self, line):
        for w in list(self.clients):
            self._write(w, line)

    def _stalled(self, now=None):
        """True when the link is open but the EVL has answered no command for
        stall_timeout seconds while one is waiting (it has gone quiet without
        closing the socket). One lost reply doesn't count while others arrive."""
        if self.upstream_writer is None or not self.pending:
            return False
        now = time.monotonic() if now is None else now
        return (now - self.pending[0][2] > self.stall_timeout
                and now - self.last_reply > self.stall_timeout)

    def _unhealthy_since(self, now=None):
        """When the link went down or hung, or None if it's working."""
        if self.upstream_writer is None:
            return self.down_since
        if self._stalled(now):
            return self.pending[0][2]
        return None

    def _down_too_long(self, now=None):
        now = time.monotonic() if now is None else now
        since = self._unhealthy_since(now)
        return since is not None and now - since > self.down_grace

    def _answer_overdue(self, now):
        """Answer, on the EVL's behalf, client commands it hasn't answered in
        reply_timeout seconds, so no client hits its own command timeout."""
        for e in self.pending:
            owner, code, sent = e
            if owner is not None and now - sent > self.reply_timeout:
                e[0] = None          # keep the slot: a late EVL reply lands here
                if owner in self.clients:
                    log.debug("no EVL reply to %r in %ss; answering %s locally",
                              code, self.reply_timeout, self._peer(owner))
                    self._write(owner, self.profile.local_reply(code))

    async def down_watchdog(self):
        # Every half second: answer overdue commands; log a hung link; and if the
        # link stays down or hung past the grace period, drop the clients so they
        # see the outage (they reconnect, and are refused until the EVL is back).
        while True:
            await asyncio.sleep(0.5)
            now = time.monotonic()
            self._answer_overdue(now)
            if self._stalled(now) and not self.stall_logged:
                self.stall_logged = True
                log.warning("EnvisaLink has not answered a command for %ss; answering "
                            "clients locally (up to %ss)", self.stall_timeout, self.down_grace)
            if self._down_too_long(now):
                if self.upstream_writer is not None:
                    log.warning("EnvisaLink hung for over %ss; reconnecting", self.down_grace)
                    # Keep the outage's start time (so new clients are refused
                    # now, not after another grace period) and drop the socket.
                    self.down_since = self._unhealthy_since(now)
                    try:
                        self.upstream_writer.transport.abort()
                    except Exception:  # noqa: BLE001
                        pass
                if self.clients:
                    log.warning("EnvisaLink down for over %ss; disconnecting %d client(s)",
                                self.down_grace, len(self.clients))
                    for w in list(self.clients):
                        self.clients.discard(w)
                        try:
                            w.close()
                        except Exception:  # noqa: BLE001
                            pass

    # ---- downstream (clients sharing the connection) ------------------------

    async def handle_client(self, reader, writer):
        peer = writer.get_extra_info("peername")
        if self._down_too_long():
            log.info("client %s refused: EnvisaLink not connected", peer)
            writer.close()
            return
        try:
            ok = await self.profile.login_downstream(reader, writer, self.client_pass)
            if not ok:
                log.info("client %s failed login", peer)
                writer.close()
                return
            self.clients.add(writer)
            log.info("client %s logged in (%d total)", peer, len(self.clients))

            # Give the new client current state: replay cached messages and ask
            # the panel to re-send state.
            for line in self.cache.values():
                writer.write(line)
            await writer.drain()
            self._send_upstream(None, self.profile.refresh_cmd)

            while True:
                line = await reader.readline()
                if not line:
                    break
                if writer not in self.clients:
                    break                       # dropped by the down watchdog
                code = self.profile.cmd_code(line)
                if (code is not None and code != self.profile.poll_code
                        and self._stalled()):
                    # EVL hung: don't queue keypresses/commands it might act on
                    # much later; tell the client to retry. Polls still go up so
                    # we notice when it answers again.
                    writer.write(self.profile.local_reply(code))
                    await writer.drain()
                elif self._send_upstream(writer, line):
                    try:
                        await self.upstream_writer.drain()
                    except Exception:  # noqa: BLE001
                        pass
                else:
                    # EVL link down (reconnecting): answer it ourselves so the
                    # client's command doesn't just vanish and time out.
                    if code is not None:
                        log.debug("upstream down; answering %r locally", line.strip())
                        writer.write(self.profile.local_reply(code))
                        await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError, asyncio.TimeoutError):
            pass
        except Exception:  # noqa: BLE001
            log.exception("client %s error", peer)
        finally:
            self.clients.discard(writer)
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass
            log.info("client %s disconnected (%d left)", peer, len(self.clients))

    async def run(self):
        server = await asyncio.start_server(self.handle_client, self.listen_host, self.listen_port)
        asyncio.create_task(self.upstream_loop())
        asyncio.create_task(self.down_watchdog())
        log.info("listening on %s:%s (panel=%s)", self.listen_host, self.listen_port, self.profile.name)
        async with server:
            await server.serve_forever()


def main(argv=None):
    ap = argparse.ArgumentParser(description="EnvisaLink TPI multiplexing proxy")
    ap.add_argument("--evl-host", default=os.environ.get("EVL_HOST"))
    ap.add_argument("--evl-port", type=int, default=int(os.environ.get("EVL_PORT", "4025")))
    ap.add_argument("--evl-pass", default=os.environ.get("EVL_PASS"))
    ap.add_argument("--listen-host", default=os.environ.get("LISTEN_HOST", "0.0.0.0"))
    ap.add_argument("--listen-port", type=int, default=int(os.environ.get("LISTEN_PORT", "4025")))
    ap.add_argument("--client-pass", default=os.environ.get("CLIENT_PASS"),
                    help="password clients must send (default: same as --evl-pass)")
    ap.add_argument("--panel", default=os.environ.get("PANEL", "honeywell"), choices=list(PROFILES))
    ap.add_argument("--keepalive", type=int, default=int(os.environ.get("KEEPALIVE", "120")))
    ap.add_argument("--down-grace", type=int, default=int(os.environ.get("DOWN_GRACE", "300")),
                    help="seconds the EnvisaLink link may be down or hung before clients "
                         "are disconnected (until then the proxy answers their commands itself)")
    ap.add_argument("--reply-timeout", type=float,
                    default=float(os.environ.get("REPLY_TIMEOUT", "3")),
                    help="seconds to wait for the EnvisaLink to answer a command before the "
                         "proxy answers it itself (keep below Home Assistant's 5 s)")
    ap.add_argument("--stall-timeout", type=float,
                    default=float(os.environ.get("STALL_TIMEOUT", "10")),
                    help="seconds without any command reply (while one is waiting) before "
                         "the link counts as hung")
    ap.add_argument("--log-level", default=os.environ.get("LOG_LEVEL", "INFO"))
    args = ap.parse_args(argv)

    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    if not args.evl_host or not args.evl_pass:
        ap.error("--evl-host and --evl-pass are required (or set EVL_HOST / EVL_PASS)")

    proxy = Proxy(
        evl_host=args.evl_host, evl_port=args.evl_port, evl_pass=args.evl_pass,
        listen_host=args.listen_host, listen_port=args.listen_port,
        client_pass=args.client_pass if args.client_pass is not None else args.evl_pass,
        profile=PROFILES[args.panel](), keepalive=args.keepalive,
        down_grace=args.down_grace, reply_timeout=args.reply_timeout,
        stall_timeout=args.stall_timeout,
    )
    try:
        asyncio.run(proxy.run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
