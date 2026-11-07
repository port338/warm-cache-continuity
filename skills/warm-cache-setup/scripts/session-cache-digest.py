#!/usr/bin/env python3
"""Дайджест session-cache: отбор файлов по метке важности и возрасту + открытые задачи.

Использование:
    python3 session-cache-digest.py            # только актуальные (critical 14д, important 7д)
    python3 session-cache-digest.py --all      # показать также просроченные и routine
    python3 session-cache-digest.py --tasks    # только открытые задачи, без заголовков

Формат frontmatter в файлах кэша:
    ---
    importance: critical | important | routine
    date: YYYY-MM-DD
    open_tasks: 3
    ---
"""
from __future__ import annotations

import datetime
import os
import sys

CACHE_DIR = os.path.expanduser("~/.openclaw/workspace/memory/session-cache")

# срок жизни метки в днях
TTL_DAYS = {"critical": 14, "important": 7, "routine": 0}
DEFAULT_IMPORTANCE = "important"


def parse_file(path: str) -> tuple[dict, str]:
    """Возвращает (метаданные, тело без frontmatter)."""
    text = open(path, encoding="utf-8").read()
    meta: dict[str, str] = {}
    body = text
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            for line in parts[1].strip().splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip()] = v.strip().strip("\"'")
            body = parts[2]
    return meta, body


def open_tasks(body: str) -> list[str]:
    out = []
    for line in body.splitlines():
        s = line.strip()
        if s.startswith("- [ ]"):
            task = s[5:].strip()
            if task:
                out.append(task)
    return out


def file_date(meta: dict, filename: str, today: datetime.date) -> datetime.date:
    raw = meta.get("date") or filename[:10]
    try:
        return datetime.date.fromisoformat(raw)
    except ValueError:
        return today


def main() -> int:
    show_all = "--all" in sys.argv
    tasks_only = "--tasks" in sys.argv

    if not os.path.isdir(CACHE_DIR):
        print("session-cache не найден: " + CACHE_DIR)
        return 1

    today = datetime.date.today()
    names = sorted(f for f in os.listdir(CACHE_DIR) if f.endswith(".md"))

    active, skipped = [], []
    for name in names:
        path = os.path.join(CACHE_DIR, name)
        meta, body = parse_file(path)
        importance = (meta.get("importance") or DEFAULT_IMPORTANCE).lower()
        date = file_date(meta, name, today)
        age = (today - date).days
        ttl = TTL_DAYS.get(importance, 7)
        item = {
            "name": name,
            "importance": importance,
            "date": date,
            "age": age,
            "tasks": open_tasks(body),
        }
        if importance == "routine" or age > ttl:
            skipped.append(item)
        else:
            active.append(item)

    if not tasks_only:
        print("Session-cache: %d файлов, актуальных %d, вне окна %d"
              % (len(names), len(active), len(skipped)))
        print()

    total_tasks = 0
    for it in active:
        total_tasks += len(it["tasks"])
        if tasks_only:
            for t in it["tasks"]:
                print("[%s] %s" % (it["importance"], t))
            continue
        print("─ %s  ·  %s  ·  %d дн. назад  ·  задач: %d"
              % (it["name"], it["importance"], it["age"], len(it["tasks"])))
        for t in it["tasks"]:
            print("   [ ] " + t)
        if not it["tasks"]:
            print("   (открытых задач нет)")
        print()

    if not tasks_only:
        print("Итого открытых задач в актуальных файлах: %d" % total_tasks)
        if skipped:
            print()
            print("Вне окна (не инжектятся, доступны через ChromaDB):")
            for it in skipped:
                print("  · %s — %s, %d дн." % (it["name"], it["importance"], it["age"]))
            if not show_all:
                print("  (полный список: --all)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
