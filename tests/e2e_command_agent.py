"""E2E: freebuff as command agent via /api/chat (spawns real panel)."""
import json
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:8080"


def post(path, body, timeout=300):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())


def get(path):
    return json.loads(urllib.request.urlopen(BASE + path, timeout=10).read())


def main() -> int:
    print("[E2E] chat -> freebuff (cold spawn)", flush=True)
    t0 = time.time()
    r = post("/api/chat", {
        "agent": "freebuff",
        "message": "Your entire answer must be exactly the single word "
                   "COMMAND-OK. Do not run shell commands."})
    answer = r["response"]["content"]
    print(f"[E2E] answer after {time.time()-t0:.0f}s: {answer[:200]}", flush=True)
    if "COMMAND-OK" not in answer:
        print("[E2E] FAIL — expected COMMAND-OK", flush=True)
        return 1

    panels = get("/api/terminals")["panels"]
    fb = [p for p in panels if p["agent"] == "freebuff"]
    print(f"[E2E] freebuff panels after first task: {len(fb)}", flush=True)

    print("[E2E] second chat (must reuse panel)", flush=True)
    t0 = time.time()
    r2 = post("/api/chat", {
        "agent": "freebuff",
        "message": "Your entire answer must be exactly the single word "
                   "SECOND-OK. Do not run shell commands."})
    answer2 = r2["response"]["content"]
    print(f"[E2E] answer after {time.time()-t0:.0f}s: {answer2[:200]}", flush=True)
    panels2 = [p for p in get("/api/terminals")["panels"] if p["agent"] == "freebuff"]
    if "SECOND-OK" not in answer2:
        print("[E2E] FAIL — expected SECOND-OK", flush=True)
        return 1
    if len(panels2) != len(fb):
        print(f"[E2E] FAIL — panel count changed {len(fb)} -> {len(panels2)}", flush=True)
        return 1
    print("[E2E] command agent verified: outbox answers + singleton reuse ✅", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
