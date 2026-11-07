#!/usr/bin/env python3
"""Index warm-cache files (memory/session-cache/*.md) into ChromaDB.

Idempotent: the file stem is the document id, so re-running updates instead of duplicating.
Run it after every cache file is written or edited; indexing is not automatic.

Usage:
    python3 index_session_cache.py                       # main host, collection 'sessions'
    python3 index_session_cache.py --dry-run             # list what would be indexed
    python3 index_session_cache.py --collection remote-sessions --agent remote \
        --dir /path/to/remote/memory/session-cache          # another agent's files
"""
import argparse
import os
from pathlib import Path

import chromadb


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(Path(os.environ.get("OPENCLAW_WORKSPACE", Path.home() / ".openclaw" / "workspace")) / "memory" / "session-cache"))
    ap.add_argument("--collection", default="sessions")
    ap.add_argument("--agent", default="main")
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    cache_dir = Path(args.dir)
    files = sorted(cache_dir.glob("*.md"))
    if not files:
        print(f"no session-cache files in {cache_dir}")
        return 1

    client = chromadb.HttpClient(host=args.host, port=args.port)
    col = client.get_or_create_collection(args.collection)
    existing = set(col.get(include=[])['ids'])

    added = updated = 0
    for path in files:
        doc_id = path.stem
        if args.dry_run:
            print(("exists" if doc_id in existing else "new").ljust(6), doc_id)
            continue
        col.upsert(
            ids=[doc_id],
            documents=[path.read_text(encoding="utf-8")],
            metadatas=[{"agent": args.agent, "source": str(path)}],
        )
        if doc_id in existing:
            updated += 1
        else:
            added += 1
        print("indexed", doc_id)

    if args.dry_run:
        return 0
    print(f"\ntotal in '{args.collection}': {col.count()} (added {added}, updated {updated})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
