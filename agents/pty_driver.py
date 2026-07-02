"""Generic PTY driver for interactive CLI agents (freebuff, Claude Code, any TUI).

Any CLI can be registered via data/cli-agents.json — launch command plus
regex patterns for its lifecycle screens (login, model picker, ready prompt).
A Panel spawns the CLI on a Linux PTY, streams raw output to WebSocket
subscribers (rendered by xterm.js), and runs a pyte terminal emulator in
parallel to detect lifecycle state from the *actual screen*, not the raw
byte stream (TUI redraws make raw-stream matching unreliable).

Task handoff follows the file-handoff recipe: the full task is written to a
file and a short directive is typed into the TUI in small chunks — large
pastes get dropped by TUI input handling.
"""
import asyncio
import json
import re
import threading
import time
import uuid
from pathlib import Path

import pexpect
import pyte

BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = BASE_DIR / "data" / "cli-agents.json"
INBOX_DIR = BASE_DIR / "data" / "terminal-inbox"

CHUNK_BYTES = 24
CHUNK_DELAY = 0.012
PICKER_SETTLE = 1.5

DEFAULT_AGENTS = [
    {
        "id": "freebuff",
        "label": "freebuff",
        "command": "freebuff",
        "login_prompt": r"Press ENTER to login",
        "login_url": r"https://freebuff\.com/login\?auth_code=\S+",
        "picker": r"(select|choose|pick).{0,40}model|RECOMMENDED",
        # single-instance guard screen: "Take over" is preselected, Enter accepts
        "recover_prompt": r"already running",
        "ready": r"Enter a coding task|❯",
        "handoff": "file",
        "ctrl_c_twice": True,
        # freebuff allows only one instance per machine — reuse the live panel
        "singleton": True,
    },
    {
        "id": "claude",
        "label": "Claude Code",
        "command": "claude",
        "login_prompt": None,
        "login_url": r"https://claude\.ai/oauth\S+|https://console\.anthropic\.com/\S+",
        "picker": None,
        "ready": r"\? for shortcuts|>\s*$|Try \"",
        "handoff": "file",
        "ctrl_c_twice": True,
    },
]


def load_agent_configs() -> list:
    """Built-in defaults merged with user-registered CLIs (by id)."""
    configs = {c["id"]: dict(c) for c in DEFAULT_AGENTS}
    if CONFIG_PATH.exists():
        try:
            for c in json.loads(CONFIG_PATH.read_text()):
                if isinstance(c, dict) and c.get("id") and c.get("command"):
                    configs[c["id"]] = {**configs.get(c["id"], {}), **c}
        except Exception:
            pass
    return list(configs.values())


def get_agent_config(agent_id: str):
    for c in load_agent_configs():
        if c["id"] == agent_id:
            return c
    return None


class Panel:
    """One running CLI agent on a PTY."""

    def __init__(self, config: dict, cols: int = 120, rows: int = 30):
        self.id = f"{config['id']}-{uuid.uuid4().hex[:6]}"
        self.config = config
        self.state = "launching"
        self.login_url = None
        self.started_at = time.time()
        self.cols, self.rows = cols, rows

        self._screen = pyte.Screen(cols, rows)
        self._stream = pyte.Stream(self._screen)
        self._subscribers = []          # list[(asyncio.Queue, loop)]
        self._replay = bytearray()      # raw bytes for late joiners
        self._lock = threading.Lock()
        self._sent_login_enter = False
        self._picker_seen = None
        self._recover_seen = None
        self._alive = True

        self._child = pexpect.spawn(
            config["command"], encoding=None, timeout=5,
            dimensions=(rows, cols), cwd=str(BASE_DIR),
        )
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    # ── output fan-out ────────────────────────────────────────────

    def subscribe(self, queue: asyncio.Queue, loop) -> bytes:
        """Register a WS subscriber; returns replay buffer for repaint."""
        with self._lock:
            self._subscribers.append((queue, loop))
            return bytes(self._replay)

    def unsubscribe(self, queue: asyncio.Queue):
        with self._lock:
            self._subscribers = [(q, l) for (q, l) in self._subscribers if q is not queue]

    def _emit(self, msg: dict):
        with self._lock:
            subs = list(self._subscribers)
        for q, loop in subs:
            try:
                loop.call_soon_threadsafe(q.put_nowait, msg)
            except RuntimeError:
                pass

    # ── reader thread: stream + screen-state machine ─────────────

    def _read_loop(self):
        while self._alive:
            try:
                chunk = self._child.read_nonblocking(size=8192, timeout=0.5)
            except pexpect.TIMEOUT:
                self._tick()
                continue
            except (pexpect.EOF, OSError):
                break
            if not chunk:
                continue
            with self._lock:
                self._replay.extend(chunk)
                if len(self._replay) > 262144:
                    del self._replay[: len(self._replay) - 262144]
            try:
                self._stream.feed(chunk.decode("utf-8", errors="replace"))
            except Exception:
                pass
            self._emit({"type": "out", "data": chunk.decode("utf-8", errors="replace")})
            self._tick()
        self._set_state("exited")
        self._alive = False

    def _screen_text(self) -> str:
        return "\n".join(l.rstrip() for l in self._screen.display if l.strip())

    def screen_text(self) -> str:
        """Current rendered screen (public — used for output fallback)."""
        return self._screen_text()

    def _set_state(self, state: str, **extra):
        if state != self.state:
            self.state = state
            self._emit({"type": "state", "state": state, **extra})

    def _tick(self):
        """Evaluate lifecycle patterns against the rendered screen."""
        cfg, text = self.config, self._screen_text()

        if cfg.get("login_prompt") and not self._sent_login_enter and \
                re.search(cfg["login_prompt"], text, re.I):
            self._sent_login_enter = True
            self._set_state("login")
            time.sleep(0.5)
            self._child.send(b"\r")
            return

        if cfg.get("login_url") and self.state in ("launching", "login"):
            m = re.search(cfg["login_url"], text)
            if m and m.group(0) != self.login_url:
                self.login_url = m.group(0)
                self._set_state("login", login_url=self.login_url)
                self._emit({"type": "login_url", "url": self.login_url})

        if cfg.get("ready") and re.search(cfg["ready"], text):
            self._picker_seen = None
            self._set_state("ready")
            return

        if cfg.get("picker") and self.state != "task" and \
                re.search(cfg["picker"], text, re.I):
            now = time.time()
            if self._picker_seen is None:
                self._picker_seen = now
                self._set_state("picker")
            elif now - self._picker_seen >= PICKER_SETTLE:
                self._picker_seen = None
                self._child.send(b"\r")

        # single-instance guard screen (e.g. freebuff "already running"):
        # the recover option is preselected — settle, then Enter to take over
        if cfg.get("recover_prompt") and self.state != "task" and \
                re.search(cfg["recover_prompt"], text, re.I):
            now = time.time()
            if self._recover_seen is None:
                self._recover_seen = now
                self._set_state("recovering")
            elif now - self._recover_seen >= PICKER_SETTLE:
                self._recover_seen = None
                self._child.send(b"\r")

    # ── input / tasks / lifecycle ─────────────────────────────────

    def write(self, data: str):
        self._child.send(data.encode())

    def resize(self, cols: int, rows: int):
        self.cols, self.rows = cols, rows
        self._child.setwinsize(rows, cols)
        self._screen.resize(rows, cols)

    def _type_chunked(self, text: str):
        data = text.encode()
        for i in range(0, len(data), CHUNK_BYTES):
            self._child.send(data[i:i + CHUNK_BYTES])
            time.sleep(CHUNK_DELAY)
        self._child.send(b"\r")

    def task(self, text: str):
        """File-handoff: write full task to inbox, type a short directive."""
        self._set_state("task")
        if self.config.get("handoff") == "file":
            INBOX_DIR.mkdir(parents=True, exist_ok=True)
            inbox = INBOX_DIR / f"{self.id}.md"
            inbox.write_text(text, encoding="utf-8")
            rel = inbox.relative_to(BASE_DIR)
            directive = f"Read the file {rel} and do exactly what it says."
            threading.Thread(target=self._type_chunked, args=(directive,),
                             daemon=True).start()
        else:
            threading.Thread(target=self._type_chunked, args=(text,),
                             daemon=True).start()

    def interrupt(self):
        self._child.sendcontrol("c")

    def kill(self):
        self._alive = False
        try:
            self._child.sendcontrol("c")
            if self.config.get("ctrl_c_twice"):
                time.sleep(0.4)
                self._child.sendcontrol("c")
            time.sleep(0.4)
            self._child.close(force=True)
        except Exception:
            pass
        self._set_state("exited")

    def info(self) -> dict:
        return {
            "id": self.id,
            "agent": self.config["id"],
            "label": self.config.get("label", self.config["id"]),
            "state": self.state,
            "login_url": self.login_url,
            "started_at": self.started_at,
        }


class PanelRegistry:
    def __init__(self):
        self._panels = {}

    def open(self, agent_id: str) -> Panel:
        config = get_agent_config(agent_id)
        if not config:
            raise KeyError(f"No CLI agent config for '{agent_id}'")
        if config.get("singleton"):
            existing = self.find(agent_id)
            if existing:
                return existing
        panel = Panel(config)
        self._panels[panel.id] = panel
        return panel

    def find(self, agent_id: str):
        """Live (non-exited) panel for an agent, if any."""
        for p in self._panels.values():
            if p.config["id"] == agent_id and p.state != "exited":
                return p
        return None

    def get(self, panel_id: str):
        return self._panels.get(panel_id)

    def close(self, panel_id: str):
        panel = self._panels.pop(panel_id, None)
        if panel:
            panel.kill()

    def list(self) -> list:
        return [p.info() for p in self._panels.values()]

    def shutdown(self):
        for pid in list(self._panels):
            self.close(pid)


registry = PanelRegistry()
