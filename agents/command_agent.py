"""freebuff as the OS command agent.

freebuff has no headless mode, so chat/skill requests are bridged onto
its TUI: a managed singleton panel (visible on the Terminal page — the
work is never hidden) receives tasks by file handoff, and the agent is
instructed to write its final answer to an outbox file. Completion is
the outbox appearing (or the panel settling back to ready); if the
agent answered only on screen, the rendered pyte screen is returned as
a labeled fallback.
"""
import re
import threading
import time
import uuid
from pathlib import Path

from agents.pty_driver import registry, INBOX_DIR

BASE_DIR = Path(__file__).resolve().parent.parent

SPAWN_TIMEOUT = 90       # cold start: login-check + picker + ready
TASK_TIMEOUT = 180
READY_HOLD_SECS = 2.5    # 'ready' must hold this long before dispatch
MIN_TASK_SECS = 15       # never declare settle-completion earlier than this
SCREEN_STABLE_SECS = 12  # screen unchanged this long + ready = done

_lock = threading.Lock()  # one TUI — requests queue, never interleave


class CommandAgentError(RuntimeError):
    pass


def _ensure_panel():
    panel = registry.find("freebuff")
    if panel is None:
        panel = registry.open("freebuff")
    deadline = time.time() + SPAWN_TIMEOUT
    ready_since = None
    while time.time() < deadline:
        if panel.state == "ready":
            # boot screens can transiently match the ready pattern —
            # only dispatch once ready has held steady
            ready_since = ready_since or time.time()
            if time.time() - ready_since >= READY_HOLD_SECS:
                return panel
        else:
            ready_since = None
        if panel.state == "exited":
            raise CommandAgentError("freebuff panel exited during startup")
        if panel.state == "login":
            raise CommandAgentError(
                f"freebuff needs a one-time browser login: {panel.login_url or 'open the Terminal page'}")
        time.sleep(0.5)
    raise CommandAgentError(
        f"freebuff did not reach ready in {SPAWN_TIMEOUT}s (state: {panel.state}) — check the Terminal page")


def run_task(text: str, timeout: int = TASK_TIMEOUT) -> str:
    with _lock:
        panel = _ensure_panel()
        task_id = uuid.uuid4().hex[:8]
        outbox = INBOX_DIR / f"{task_id}.out.md"
        brief = (
            f"{text}\n\n"
            f"---\n"
            f"IMPORTANT: When you are fully done, write your complete final "
            f"answer (just the answer, no preamble) into a new file at "
            f"`data/terminal-inbox/{task_id}.out.md`, then stop."
        )
        screen_before = panel.screen_text()
        panel.task(brief)

        started = time.time()
        deadline = started + timeout
        last_screen, stable_since = None, None
        while time.time() < deadline:
            if outbox.exists():
                time.sleep(0.8)          # let the write finish
                answer = outbox.read_text(encoding="utf-8",
                                          errors="replace").strip()
                _cleanup(task_id)
                if answer:
                    return answer
            if panel.state == "exited":
                _cleanup(task_id)
                raise CommandAgentError("freebuff exited mid-task")
            # settle-completion: enough elapsed + prompt back + screen frozen
            screen = panel.screen_text()
            if screen != last_screen:
                last_screen, stable_since = screen, time.time()
            if (time.time() - started >= MIN_TASK_SECS
                    and panel.state == "ready"
                    and stable_since
                    and time.time() - stable_since >= SCREEN_STABLE_SECS):
                break                     # done but no outbox → fallback
            time.sleep(0.5)
        else:
            _cleanup(task_id)
            raise CommandAgentError(
                f"Task still running after {timeout}s — it continues live "
                f"on the Terminal page (panel {panel.id})")

        # fallback: rendered screen, filtered to content lines
        screen = panel.screen_text()
        _cleanup(task_id)
        lines = []
        for line in screen.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            # drop pure box-drawing/border lines and ad footers
            if re.fullmatch(r"[─│╭╮╰╯═║┌┐└┘\s╞╡┤├]+", stripped):
                continue
            if re.search(r"\bAd\b\s*$|Runware|GitLab", stripped):
                continue
            lines.append(stripped)
        tail = "\n".join(lines[-25:])
        return f"(screen capture — agent finished without writing the outbox)\n\n{tail}"


def _cleanup(task_id: str):
    for suffix in (".out.md",):
        try:
            (INBOX_DIR / f"{task_id}{suffix}").unlink(missing_ok=True)
        except OSError:
            pass
