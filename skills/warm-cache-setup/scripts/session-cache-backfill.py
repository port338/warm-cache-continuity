#!/usr/bin/env python3
"""Одноразовая разметка: добавляет YAML frontmatter в файлы session-cache.

Метка важности берётся из секции «## Метка важности», дата — из имени файла,
число открытых задач считается по строкам «- [ ]».
Файлы с уже существующим frontmatter не трогаются.
"""
from __future__ import annotations

import datetime
import os
import re

WORKSPACE = os.path.expanduser(
    os.environ.get("OPENCLAW_WORKSPACE", "~/.openclaw/workspace")
)
CACHE_DIR = os.path.join(WORKSPACE, "memory", "session-cache")
VALID = {"critical", "important", "routine"}


def detect_importance(body: str) -> str:
    m = re.search(r"^##\s+Метка важности\s*\n+\s*([a-zA-Zа-яА-Я]+)", body, re.MULTILINE)
    if m:
        word = m.group(1).strip().lower()
        if word in VALID:
            return word
    return "important"


def count_open(body: str) -> int:
    return sum(1 for line in body.splitlines() if line.strip().startswith("- [ ]"))


def main() -> int:
    changed, skipped, empty = 0, 0, 0
    for name in sorted(os.listdir(CACHE_DIR)):
        if not name.endswith(".md"):
            continue
        path = os.path.join(CACHE_DIR, name)
        text = open(path, encoding="utf-8").read()
        if text.startswith("---"):
            skipped += 1
            continue
        if not text.strip():
            empty += 1
            continue

        date_str = name[:10]
        try:
            datetime.date.fromisoformat(date_str)
        except ValueError:
            date_str = datetime.date.today().isoformat()

        importance = detect_importance(text)
        tasks = count_open(text)

        fm = (
            "---\n"
            "importance: %s\n"
            "date: %s\n"
            "open_tasks: %d\n"
            "source: session-cache\n"
            "---\n\n"
        ) % (importance, date_str, tasks)

        # убираем дублирующий заголовок секции, чтобы не путать читателя
        body = re.sub(r"^##\s+Метка важности\s*\n+\s*[a-zA-Zа-яА-Я]+\s*\n+", "", text, count=1, flags=re.MULTILINE)

        open(path, "w", encoding="utf-8").write(fm + body)
        print("  %-45s → %-10s задач: %d" % (name, importance, tasks))
        changed += 1

    print()
    print("размечено: %d, уже с frontmatter: %d, пустых: %d" % (changed, skipped, empty))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
