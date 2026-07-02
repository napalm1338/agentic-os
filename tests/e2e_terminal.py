"""E2E test: open freebuff panel via API, drive it over the WebSocket."""
import asyncio
import json
import re
import sys
import urllib.request

import websockets

BASE = "http://127.0.0.1:8080"


def post(path, body):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())


async def main():
    panel = post("/api/terminals", {"agent": "freebuff"})
    print(f"[E2E] panel opened: {panel['id']} state={panel['state']}", flush=True)

    task_sent = False
    output = ""
    async with websockets.connect(
            f"ws://127.0.0.1:8080/ws/terminal/{panel['id']}") as ws:
        async def timeline():
            nonlocal task_sent, output
            async for raw in ws:
                msg = json.loads(raw)
                if msg["type"] == "state":
                    print(f"[E2E] state -> {msg['state']}", flush=True)
                    if msg["state"] == "ready" and not task_sent:
                        task_sent = True
                        await ws.send(json.dumps({
                            "type": "task",
                            "text": "Reply with the single word PONG and "
                                    "nothing else. Do not run any commands "
                                    "or edit any files."}))
                        print("[E2E] task sent via file handoff", flush=True)
                elif msg["type"] == "out":
                    output += msg["data"]
                    if task_sent and re.search(r"PONG", output):
                        print("[E2E] PONG received — full loop verified ✅",
                              flush=True)
                        await ws.send(json.dumps({"type": "kill"}))
                        return 0
        try:
            return await asyncio.wait_for(timeline(), timeout=150)
        except asyncio.TimeoutError:
            print("[E2E] TIMEOUT — last state/task_sent:", task_sent, flush=True)
            tail = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", output)[-400:]
            print(tail, flush=True)
            return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()) or 0)
