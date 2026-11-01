"""webzer helper: the local half of the Razer web app.

Talks HID to the Viper V3 Pro (wired 0x00C0 / dongle 0x00C1) and the
BlackShark V2 Pro 2023 (receiver 0x0555), serves their status as JSON and
serves the web page in web/.

    uv run razer_helper.py        then open http://localhost:8137

Chrome can't send Razer's mouse commands (Windows protects mouse interfaces),
so the browser goes through this helper for everything.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

if sys.platform.startswith("linux"):
    # hidapi's default Linux backend is libusb, which detaches the kernel driver
    # (the mouse would stop moving). hidraw talks through the kernel instead.
    import hidraw as hid
else:
    import hid

HOST = os.environ.get("WEBZER_HOST", "127.0.0.1")
PORT = int(os.environ.get("WEBZER_PORT", "8137"))
ROOT = Path(__file__).resolve().parent / "web"
RAZER_VID = 0x1532
MICE = {0x00C0: "wired", 0x00C1: "wireless"}
HEADSETS = {0x0555, 0x0556, 0x0557}

# One HID conversation at a time: replies are read back from a shared buffer.
lock = threading.Lock()


class DeviceError(Exception):
    pass


class HidDevice:
    def __init__(self, path: bytes):
        self.dev = hid.device()
        self.dev.open_path(path)

    def close(self):
        self.dev.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


# 90-byte feature report on report ID 0, as documented by openrazer.

MOUSE_TID = 0x1F
MOUSE_STATUS = {0x01: "busy", 0x03: "failed", 0x04: "asleep or out of range", 0x05: "not supported"}
POLL = {0x01: 1000, 0x02: 500, 0x08: 125}
POLL2 = {0x01: 8000, 0x02: 4000, 0x04: 2000, 0x08: 1000, 0x10: 500, 0x40: 125}


def mouse_packet(cmd_class: int, cmd_id: int, size: int, args: bytes = b"") -> bytes:
    p = bytearray(90)
    p[1] = MOUSE_TID
    p[5] = size
    p[6] = cmd_class
    p[7] = cmd_id
    p[8:8 + len(args)] = args
    crc = 0
    for b in p[2:88]:
        crc ^= b
    p[88] = crc
    return bytes(p)


class Mouse(HidDevice):
    # path that answered last time, per PID, so later calls skip the search
    paths: dict[int, bytes] = {}

    def cmd(self, cmd_class: int, cmd_id: int, size: int, args: bytes = b"") -> list[int]:
        self.dev.send_feature_report(b"\x00" + mouse_packet(cmd_class, cmd_id, size, args))
        deadline = time.time() + 1.0
        time.sleep(0.03)
        while True:
            data = list(self.dev.get_feature_report(0, 91))
            if len(data) >= 91:
                data = data[1:91]  # hidapi on Windows keeps the report ID byte
            if len(data) < 90:
                raise DeviceError(f"short reply ({len(data)} bytes)")
            status = data[0]
            ours = data[6] == cmd_class and data[7] == cmd_id
            if time.time() < deadline and (status == 0x01 or (status == 0x02 and not ours)):
                time.sleep(0.03)
                continue
            if not ours:
                raise DeviceError("reply belongs to another app (is Synapse running?)")
            if status != 0x02:
                raise DeviceError(MOUSE_STATUS.get(status, f"status 0x{status:02x}"))
            return data[8:88]

    @classmethod
    def open(cls, pid: int) -> "Mouse":
        """Open the interface of this PID that answers Razer commands."""
        candidates = [d["path"] for d in hid.enumerate(RAZER_VID, pid)]
        if pid in cls.paths and cls.paths[pid] in candidates:
            candidates.remove(cls.paths[pid])
            candidates.insert(0, cls.paths[pid])
        last = "no interfaces"
        for path in candidates:
            try:
                m = cls(path)
            except OSError as e:
                last = str(e)
                continue
            try:
                m.cmd(0x00, 0x81, 0x02)  # firmware version: cheap, answered even when asleep
                cls.paths[pid] = path
                return m
            except (OSError, ValueError, DeviceError) as e:
                last = str(e)
                m.close()
        raise DeviceError(f"no interface answered ({last})")


def be16(a: list[int], i: int) -> int:
    return (a[i] << 8) | a[i + 1]


def read_mouse(pid: int) -> dict:
    out: dict = {"connection": MICE[pid], "pid": f"0x{pid:04X}"}
    with Mouse.open(pid) as m:
        fw = m.cmd(0x00, 0x81, 0x02)
        out["firmware"] = f"v{fw[0]}.{fw[1]}"

        def field(name, fn):
            try:
                out[name] = fn()
            except DeviceError as e:
                out.setdefault("errors", {})[name] = str(e)

        field("battery", lambda: round(m.cmd(0x07, 0x80, 0x02)[1] / 255 * 100))
        field("charging", lambda: bool(m.cmd(0x07, 0x84, 0x02)[1]))
        field("dpi", lambda: (lambda a: [be16(a, 1), be16(a, 3)])(m.cmd(0x04, 0x85, 0x07, b"\x01")))
        field("dpiStages", lambda: dpi_stages(m.cmd(0x04, 0x86, 0x26, b"\x01")))
        field("pollingRate", lambda: polling_rate(m))
        # Class 0x05 is undocumented. On a Viper V3 Pro with one stored profile,
        # 0x05:0x8A reads 1 and 0x05:0x81 reads "1 entry: profile 1". The DPI
        # storage byte (1-5) addresses the same slots.
        field("profile", lambda: m.cmd(0x05, 0x8A, 0x0A)[0])
        field("profiles", lambda: (lambda a: list(a[1:1 + a[0]]))(m.cmd(0x05, 0x81, 0x0A)))
    return out


def dpi_stages(a: list[int]) -> dict:
    stages = []
    for i in range(min(a[2], 5)):
        o = 3 + i * 7
        stages.append({"id": a[o], "x": be16(a, o + 1), "y": be16(a, o + 3)})
    return {"active": a[1], "stages": stages}


def polling_rate(m: Mouse) -> int | None:
    try:
        a = m.cmd(0x00, 0xC0, 0x01)  # HyperPolling-capable mice
        if a[1] in POLL2:
            return POLL2[a[1]]
    except DeviceError:
        pass
    return POLL.get(m.cmd(0x00, 0x85, 0x01)[0])


# "PA" protocol on the 0xFF00 interface, report ID 2, 64-byte frames.
# Layout from HaloBattery (providers/blackshark.py) / OpenRazer PR #2862.

PA_REPORT = 0x02
PA_LEN = 64
PA_REMOTE = 0xE1
PA_BATTERY = 0x21
PA_CHARGING = 0x2A
PA_FIRMWARE = 0x02
PA_PRESET = 0x13       # query: active EQ preset
PA_PREP = 0x1E         # query Synapse sends before audio writes
PA_SET_PRESET = 0x93   # audio write: EQ preset selector
PA_ENHANCE = 0x9D      # audio write: 2 for the esports presets, 1 otherwise
TYPE_QUERY, TYPE_AUDIO = 0x03, 0x04

# Wire value -> name, in Synapse's order. The five esports presets are listed in
# Synapse's order too (OpenRazer's game1..game5); their wire values aren't sequential.
# Game names are a guess: reviews list these five games, assumed alphabetical in Synapse.
PRESETS = {7: "Game", 8: "Music", 9: "Movie",
           0xFA: "Apex Legends", 0xFE: "Call of Duty", 0xFB: "Counter-Strike", 0xFD: "Fortnite", 0xFC: "Valorant",
           0xFF: "Custom"}
ESPORTS = range(0xFA, 0xFF)


def pa_remote(on: bool) -> bytes:
    b = bytearray(PA_LEN)
    b[0], b[1], b[2], b[5], b[6], b[7] = PA_REPORT, 0x80, 0x07, 0x50, 0x41, 0x0E
    b[9], b[10], b[11] = 0x02, PA_REMOTE, 1 if on else 0
    return bytes(b)


def pa_cmd(cmd_type: int, cmd: int, data: bytes = b"") -> bytes:
    b = bytearray(PA_LEN)
    b[0], b[1], b[2], b[5], b[6], b[7] = PA_REPORT, 0x80, 0x08 + len(data), 0x50, 0x41, 0x08
    b[9], b[10], b[12] = cmd_type, cmd, len(data)
    b[13:13 + len(data)] = data
    return bytes(b)


def pa_query(cmd: int) -> bytes:
    return pa_cmd(TYPE_QUERY, cmd)


class Headset(HidDevice):
    @classmethod
    def open(cls) -> tuple["Headset", int]:
        for d in hid.enumerate(RAZER_VID):
            if d["product_id"] in HEADSETS and d["usage_page"] == 0xFF00:
                return cls(d["path"]), d["product_id"]
        raise DeviceError("receiver not found")

    def _write(self, frame: bytes):
        if self.dev.write(frame) < 0:
            raise DeviceError("receiver rejected the write")

    def query(self, cmd: int) -> list[int] | None:
        """Payload of the reply to `cmd`, or None if the headset didn't answer."""
        while self.dev.read(PA_LEN, 5):  # drop stale status frames
            pass
        self._write(pa_remote(True))  # the first frame only wakes the radio link
        time.sleep(0.035)
        try:
            for _ in range(3):
                self._write(pa_remote(True))
                time.sleep(0.035)
                self._write(pa_query(cmd))
                deadline = time.time() + 0.2
                while time.time() < deadline:
                    d = self.dev.read(PA_LEN, 50)
                    if len(d) > 15 and d[0] == PA_REPORT and d[12] == cmd and d[13] == 0x01:
                        return d[15:15 + max(d[14], 1)]
            return None
        finally:
            self._write(pa_remote(False))

    def _send_remote_then(self, frame: bytes | None = None):
        self._write(pa_remote(True))
        time.sleep(0.035)
        if frame:
            self._write(frame)
            time.sleep(0.02)

    def set_preset(self, value: int) -> int:
        """Switch EQ preset; returns the preset the headset reports afterwards.

        Sequence captured from Synapse (via OpenRazer PR #2862). The headset
        remembers a "classic" and an "esports" preset separately, and a switch
        across the two only changes family on the first try, so repeat until
        the read-back matches.
        """
        got = None
        for _ in range(4):
            self._send_remote_then()
            self._send_remote_then(pa_query(PA_PREP))
            self._send_remote_then(pa_cmd(TYPE_AUDIO, PA_SET_PRESET, bytes([value])))
            self._send_remote_then(pa_cmd(TYPE_AUDIO, PA_ENHANCE, bytes([2 if value in ESPORTS else 1])))
            self._send_remote_then()
            time.sleep(0.1)
            reply = self.query(PA_PRESET)
            got = reply[0] if reply else None
            if got == value:
                break
        return got


def read_headset() -> dict:
    h, pid = Headset.open()
    out: dict = {"pid": f"0x{pid:04X}"}
    with h:
        bat = h.query(PA_BATTERY)
        if bat is None:
            out["online"] = False
            return out
        out["online"] = True
        out["battery"] = min(bat[0], 100)
        chg = h.query(PA_CHARGING)
        out["charging"] = bool(chg and chg[0])
        preset = h.query(PA_PRESET)
        if preset:
            out["presetId"] = preset[0]
            out["preset"] = PRESETS.get(preset[0], f"Unknown ({preset[0]})")
        out["presets"] = [{"id": k, "name": v} for k, v in PRESETS.items()]
        fw = h.query(PA_FIRMWARE)
        if fw and len(fw) >= 2:
            out["firmware"] = f"v{fw[0]}.{fw[1]}"
    return out



def status() -> dict:
    present = {d["product_id"] for d in hid.enumerate(RAZER_VID)}
    mice = []
    for pid in MICE:
        if pid not in present:
            continue
        try:
            mice.append(read_mouse(pid))
        except (OSError, ValueError, DeviceError) as e:
            mice.append({"connection": MICE[pid], "pid": f"0x{pid:04X}", "error": str(e)})
    headset = None
    if present & HEADSETS:
        try:
            headset = read_headset()
        except (OSError, ValueError, DeviceError) as e:
            headset = {"error": str(e)}
    return {"time": time.time(), "mice": mice, "headset": headset}


def hexbytes(s: str) -> bytes:
    return bytes.fromhex(s.replace("0x", "").replace(",", " "))


def mouse_raw(q: dict) -> dict:
    """Probe endpoint for reverse-engineering. Read commands (id >= 0x80) only."""
    num = lambda k, d=None: int(q[k][0], 16) if k in q else d
    cls, cid, size = num("class"), num("id"), num("size", 0x10)
    if cls is None or cid is None:
        raise DeviceError("class and id are required (hex)")
    if cid < 0x80:
        raise DeviceError("only read commands (id >= 0x80) are allowed")
    pid = next((p for p, c in MICE.items() if c == q.get("conn", ["wired"])[0]), 0x00C0)
    with Mouse.open(pid) as m:
        args = m.cmd(cls, cid, size, hexbytes(q.get("args", [""])[0]))
    return {"args": bytes(args).hex(" ")}


def headset_raw(q: dict) -> dict:
    """Probe endpoint: one PA query (type 0x03, read-only)."""
    cmd = int(q["cmd"][0], 16)
    with Headset.open()[0] as h:
        payload = h.query(cmd)
    return {"payload": None if payload is None else bytes(payload).hex(" ")}


def headset_preset(q: dict) -> dict:
    value = int(q["id"][0])
    if value not in PRESETS:
        raise DeviceError(f"unknown preset {value}")
    with Headset.open()[0] as h:
        got = h.set_preset(value)
    if got != value:
        raise DeviceError(f"headset stayed on {PRESETS.get(got, got)}")
    return {"presetId": got, "preset": PRESETS[got]}


ROUTES = {"/api/status": lambda q: status(), "/api/mouse/raw": mouse_raw, "/api/headset/raw": headset_raw}
POST_ROUTES = {"/api/headset/preset": headset_preset}

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def _from_own_page(self) -> bool:
        """Only this helper's own page (or a local tool like curl) may talk to it.

        Any website open in the browser can send requests to localhost, and DNS
        rebinding lets one pose as a local host name. So: the Host must be a local
        name, and a browser request must come from the same origin.
        """
        host = self.headers.get("Host", "")
        if urlparse("//" + host).hostname not in LOCAL_HOSTS:
            return False
        origin = self.headers.get("Origin")
        if origin is not None and urlparse(origin).netloc != host:
            return False
        # Browsers omit Origin on cross-site GETs, but always send Sec-Fetch-Site.
        return self.headers.get("Sec-Fetch-Site", "none") in ("same-origin", "none")

    def do_GET(self):
        self._handle(ROUTES, super().do_GET)

    def do_POST(self):
        self._handle(POST_ROUTES, lambda: self.send_error(404))

    def _handle(self, routes, fallback):
        if not self._from_own_page():
            return self.send_error(403)
        url = urlparse(self.path)
        route = routes.get(url.path)
        if route is None:
            return fallback()
        try:
            with lock:
                body, code = route(parse_qs(url.query)), 200
        except (OSError, ValueError, KeyError, DeviceError) as e:
            body, code = {"error": str(e)}, 500
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_request(self, code="-", size="-"):
        if self.path.startswith("/api/") and str(code).startswith("2"):
            return  # the page polls; keep the console quiet, but log failures and blocks
        super().log_request(code, size)


if __name__ == "__main__":
    if "--once" in sys.argv:
        print(json.dumps(status(), indent=2))
        sys.exit()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"webzer on http://localhost:{PORT}  (Ctrl+C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
