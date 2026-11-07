#!/usr/bin/env python3
"""Push session-cache frontmatter into ChromaDB metadata: importance, date, open_tasks.

Lets semantic search filter by urgency and recency:
    col.get(where={"importance": "critical"})

Configuration:
    OPENCLAW_WORKSPACE       workspace root (default ~/.openclaw/workspace)
    WARM_CACHE_COLLECTIONS   comma-separated collections (default "sessions")
"""
from __future__ import annotations

import glob
import os
import re

import chromadb

WORKSPACE = os.path.expanduser(
    os.environ.get("OPENCLAW_WORKSPACE", "~/.openclaw/workspace")
)
CACHE_DIR = os.path.join(WORKSPACE, "memory", "session-cache")
COLLECTIONS = [
    c.strip()
    for c in os.environ.get("WARM_CACHE_COLLECTIONS", "sessions").split(",")
    if c.strip()
]
VALID = {"critical", "important", "routine"}


def parse(path: str):
    text = open(path, encoding="utf-8").read()
    meta, body = {}, text
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            for line in parts[1].strip().splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip()] = v.strip().strip("\"'")
            body = parts[2]
    if "importance" not in meta:
        m = re.search(r"^##\s+\S.*\n+\s*(\w+)", body, re.MULTILINE)
        meta["importance"] = (m.group(1).lower() if m else "important")
    if meta["importance"] not in VALID:
        meta["importance"] = "important"
    if "date" not in meta:
        meta["date"] = os.path.basename(path)[:10]
    meta["open_tasks"] = str(sum(1 for l in body.splitlines() if l.strip().startswith("- [ ]")))
    return meta, body


def main() -> int:
    client = chromadb.HttpClient(host="localhost", port=8000)
    files = sorted(glob.glob(os.path.join(CACHE_DIR, "*.md")))
    print("cache files: %d" % len(files))

    for coll_name in COLLECTIONS:
        try:
            col = client.get_collection(coll_name)
        except Exception:
            print("  %s: collection missing, skipping" % coll_name)
            continue

        existing = set(col.get().get("ids", []))
        updated, added = 0, 0
        for path in files:
            doc_id = os.path.basename(path)[:-3]
            meta, body = parse(path)
            md = {
                "importance": meta["importance"],
                "date": meta["date"],
                "open_tasks": int(meta["open_tasks"]),
                "source": path,
                "agent": coll_name,
            }
            if doc_id in existing:
                col.update(ids=[doc_id], metadatas=[md])
                updated += 1
            elif coll_name == COLLECTIONS[0]:
                col.upsert(ids=[doc_id], documents=[body], metadatas=[md])
                added += 1
        print("  %s: updated %d, added %d, total %d"
              % (coll_name, updated, added, col.count()))

    try:
        col = client.get_collection(COLLECTIONS[0])
        for level in ("critical", "important"):
            res = col.get(where={"importance": level})
            print("filter importance=%s: %d documents" % (level, len(res.get("ids", []))))
    except Exception as e:
        print("filter failed: %s" % str(e)[:150])

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
