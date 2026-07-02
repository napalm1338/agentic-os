"""Memory Galaxy graph builder.

Scans the markdown memory stores (vault/ for notes, brain/ for agent
memory incl. journal) and builds a note graph: nodes = files, links =
[[wikilinks]] and relative markdown links. Unresolved wikilinks become
dim "ghost" nodes — ideas referenced but not yet written.

Scan-on-request with a short TTL cache; at local-vault scale a rescan
is milliseconds, which keeps the stack free of watcher threads.
"""
import re
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
SCAN_DIRS = ["vault", "brain"]
CACHE_TTL = 2.0

WIKILINK = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]")
MDLINK = re.compile(r"\]\(([^)]+\.md)\)")
H1 = re.compile(r"^#\s+(.+)$", re.MULTILINE)

_cache = {"at": 0.0, "graph": None}


def _scan_files():
    for d in SCAN_DIRS:
        root = BASE_DIR / d
        if not root.exists():
            continue
        for p in sorted(root.rglob("*.md")):
            if p.name.startswith("."):
                continue
            yield p


def _resolve(target: str, by_stem: dict, by_path: dict):
    t = target.strip().lower()
    if t.endswith(".md"):
        t = t[:-3]
    return by_path.get(t) or by_stem.get(t.split("/")[-1])


def build_graph() -> dict:
    now = time.time()
    if _cache["graph"] and now - _cache["at"] < CACHE_TTL:
        return _cache["graph"]

    notes = {}
    by_stem, by_path = {}, {}
    for p in _scan_files():
        rel = p.relative_to(BASE_DIR).as_posix()
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        m = H1.search(text)
        title = m.group(1).strip() if m else p.stem.replace("-", " ")
        notes[rel] = {
            "id": rel,
            "title": title,
            "group": rel.split("/")[0],
            "mtime": p.stat().st_mtime,
            "raw_links": WIKILINK.findall(text) + MDLINK.findall(text),
        }
        by_stem[p.stem.lower()] = rel
        by_path[rel[:-3].lower()] = rel

    links, ghosts, degree = [], {}, {}
    for rel, note in notes.items():
        for raw in note.pop("raw_links"):
            target = _resolve(raw, by_stem, by_path)
            if target is None:
                gid = f"ghost:{raw.strip().lower()}"
                if gid not in ghosts:
                    ghosts[gid] = {"id": gid, "title": raw.strip(),
                                   "group": "ghost", "mtime": 0}
                target = gid
            if target == rel:
                continue
            links.append({"source": rel, "target": target})
            degree[rel] = degree.get(rel, 0) + 1
            degree[target] = degree.get(target, 0) + 1

    nodes = []
    for n in list(notes.values()) + list(ghosts.values()):
        age_days = (now - n["mtime"]) / 86400 if n["mtime"] else 999
        nodes.append({**n, "degree": degree.get(n["id"], 0),
                      "age_days": round(age_days, 2)})

    graph = {"nodes": nodes, "links": links, "generatedAt": now,
             "counts": {"notes": len(notes), "ghosts": len(ghosts),
                        "links": len(links)}}
    _cache.update(at=now, graph=graph)
    return graph


def read_note(note_id: str):
    """Read one note by graph id, guarding against path traversal."""
    if note_id.startswith("ghost:"):
        return None
    path = (BASE_DIR / note_id).resolve()
    allowed = any(path.is_relative_to((BASE_DIR / d).resolve())
                  for d in SCAN_DIRS if (BASE_DIR / d).exists())
    if not allowed or not path.is_file() or path.suffix != ".md":
        return None
    text = path.read_text(encoding="utf-8", errors="replace")
    m = H1.search(text)
    return {"id": note_id,
            "title": m.group(1).strip() if m else path.stem.replace("-", " "),
            "markdown": text,
            "mtime": path.stat().st_mtime}
