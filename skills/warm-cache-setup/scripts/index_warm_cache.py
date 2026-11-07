#!/usr/bin/env python3
"""Index warm-cache layers into ChromaDB (daily, idempotent).

Layer A - curated cache:   memory/session-cache/*.md      -> "sessions"
Layer B - raw hook dumps:  memory/YYYY-MM-DD-HHMM*.md     -> "sessions" (id prefix raw-)
Layer C - remote agent:    pulled over SSH tar stream     -> "remote-sessions"

Document id comes from the file stem and a stored `mtime` metadata value skips
unchanged files, so a nightly run does no embedding work unless a file changed.

Paths and the remote host below are main host's; adjust them per deployment.

Usage:
    python3 index_warm_cache.py            # full run
    python3 index_warm_cache.py --dry-run  # print actions, write nothing
    python3 index_warm_cache.py --no-remote

Exit codes: 0 ok, 1 fatal, 3 remote pull failed but local layers indexed.
"""
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import chromadb

WORKSPACE = Path(os.environ.get("OPENCLAW_WORKSPACE", str(Path.home() / ".openclaw" / "workspace")))
CACHE_DIR = WORKSPACE / "memory" / "session-cache"
MEMORY_DIR = WORKSPACE / "memory"
STAGING = WORKSPACE / "chromadb" / "remote-cache"

LOCAL_COLLECTION = "sessions"
REMOTE_COLLECTION = "remote-sessions"

REMOTE_SSH_KEY = os.environ.get("REMOTE_SSH_KEY", "")
REMOTE_HOST = os.environ.get("REMOTE_HOST", "")
REMOTE_CACHE = os.environ.get("REMOTE_CACHE", "")

RAW_RE = re.compile(r"^\d{4}-\d{2}-\d{2}-\d{4}[^/]*\.md$")
MIN_RAW_BYTES = 200  # below this the dump is an empty session header


def load_collection(client, name):
    col = client.get_or_create_collection(name)
    got = col.get(include=["metadatas"])
    known = {}
    for doc_id, meta in zip(got["ids"], got["metadatas"]):
        known[doc_id] = (meta or {}).get("mtime")
    return col, known


def sync(col, known, items, dry):
    added = updated = skipped = 0
    for path, doc_id, layer, agent in items:
        mtime = round(path.stat().st_mtime, 3)
        if doc_id in known:
            if abs(float(known[doc_id] or 0) - mtime) < 0.001:
                skipped += 1
                continue
            updated += 1
        else:
            added += 1
        if dry:
            continue
        col.upsert(
            ids=[doc_id],
            documents=[path.read_text(encoding="utf-8", errors="replace")],
            metadatas=[{
                "agent": agent,
                "layer": layer,
                "source": str(path),
                "mtime": mtime,
            }],
        )
    return added, updated, skipped


def local_items():
    items = []
    if CACHE_DIR.is_dir():
        for p in sorted(CACHE_DIR.glob("*.md")):
            items.append((p, p.stem, "curated", "local"))
    raw_skipped = 0
    for p in sorted(MEMORY_DIR.iterdir()):
        if not p.is_file() or not RAW_RE.match(p.name):
            continue
        if p.stat().st_size < MIN_RAW_BYTES:
            raw_skipped += 1
            continue
        items.append((p, f"raw-{p.stem}", "raw", "local"))
    return items, raw_skipped


def pull_remote():
    """Copy the remote agent's cache over SSH as a tar stream (rsync may be absent)."""
    if STAGING.exists():
        shutil.rmtree(STAGING)
    STAGING.mkdir(parents=True, exist_ok=True)
    ssh = [
        "ssh", "-i", REMOTE_SSH_KEY,
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=15",
        "-o", "StrictHostKeyChecking=accept-new",
        REMOTE_HOST,
        f"cd {REMOTE_CACHE} 2>/dev/null && tar cf - -- *.md",
    ]
    tar = ["tar", "xf", "-", "-C", str(STAGING)]
    try:
        p1 = subprocess.Popen(ssh, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        p2 = subprocess.Popen(tar, stdin=p1.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        p1.stdout.close()
        _, err2 = p2.communicate(timeout=180)
        err1 = p1.stderr.read().decode(errors="replace") if p1.stderr else ""
        p1.wait(timeout=30)
        if p1.returncode != 0:
            return None, f"ssh exit {p1.returncode}: {err1.strip()[:300]}"
        if p2.returncode != 0:
            return None, f"tar exit {p2.returncode}: {err2.decode(errors='replace').strip()[:300]}"
    except Exception as exc:  # noqa: BLE001
        return None, f"{type(exc).__name__}: {exc}"
    return sorted(STAGING.glob("*.md")), None


def main() -> int:
    dry = "--dry-run" in sys.argv
    skip_remote = "--no-remote" in sys.argv
    rc = 0

    try:
        client = chromadb.HttpClient(host="localhost", port=8000)
        client.heartbeat()
    except Exception as exc:  # noqa: BLE001
        print(f"FATAL chromadb unreachable: {exc}")
        return 1

    items, raw_skipped = local_items()
    if not items:
        print("FATAL no warm-cache files found")
        return 1
    col, known = load_collection(client, LOCAL_COLLECTION)
    a, u, s = sync(col, known, items, dry)
    print(f"local/{LOCAL_COLLECTION}: files={len(items)} added={a} updated={u} unchanged={s} "
          f"(tiny raw dumps skipped={raw_skipped}) total={col.count()}")

    if skip_remote:
        print("remote: skipped (--no-remote)")
        return rc

    files, err = pull_remote()
    if files is None:
        print(f"REMOTE PULL FAILED: {err}")
        return 3
    if not files:
        print("remote: 0 files (nothing to index)")
        return rc

    rcol, rknown = load_collection(client, REMOTE_COLLECTION)
    ritems = [(p, p.stem, "curated", "remote") for p in files]
    a2, u2, s2 = sync(rcol, rknown, ritems, dry)
    print(f"remote/{REMOTE_COLLECTION}: files={len(files)} added={a2} updated={u2} "
          f"unchanged={s2} total={rcol.count()}")

    if dry:
        print("(dry-run: nothing written)")
    return rc


if __name__ == "__main__":
    sys.exit(main())
