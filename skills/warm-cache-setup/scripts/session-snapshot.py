#!/usr/bin/env python3
"""Ночной снапшот дня в memory/session-cache/.

Запускается по расписанию (23:50). Без модели: собирает факты из потока и плана,
пишет короткий файл, чтобы тёплый кэш не отставал от последних дней.

Использование:
    python3 scripts/session-snapshot.py            # за сегодня
    python3 scripts/session-snapshot.py --date 2026-11-11
    python3 scripts/session-snapshot.py --dry-run
"""
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path

WS = Path(__file__).resolve().parent.parent
STREAM = WS / "memory" / "stream"
CACHE = WS / "memory" / "session-cache"
PLANS = WS / "memory" / "plans"

MAX_TOPICS = 8
MAX_TOPIC_LEN = 110


def arg(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


def norm(text: str) -> str:
    t = re.sub(r"\s+", " ", text or "").strip()
    return t[:MAX_TOPIC_LEN]


def read_stream(day: str):
    f = STREAM / f"{day}.jsonl"
    if not f.exists():
        return None
    inbound, outbound, topics, tools = 0, 0, [], 0
    for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        ev = r.get("event")
        if ev == "message:received":
            inbound += 1
            c = norm(r.get("content") or "")
            if c and not c.startswith("["):  # отбрасываем служебные вставки
                topics.append(c)
        elif ev == "message:sent":
            outbound += 1
        elif ev == "agent:end":
            tools += 1
    return {"inbound": inbound, "outbound": outbound, "agent_runs": tools, "topics": topics}


def read_plan(day: str):
    f = PLANS / f"{day}.md"
    if not f.exists():
        return None, []
    tasks = []
    for line in f.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^\s*- \[( |x)\] \*\*(.+?)\*\*", line)
        if m and m.group(1) == " ":
            tasks.append(norm(m.group(2)))
    return f, tasks


def main() -> int:
    day = arg("--date") or date.today().isoformat()
    dry = "--dry-run" in sys.argv

    st = read_stream(day)
    plan_file, tasks = read_plan(day)

    if st is None and not tasks:
        print(f"{day}: нет ни потока, ни плана — снапшот не нужен")
        return 0

    lines = ["---",
             "importance: important",
             f"date: {day}",
             f"open_tasks: {len(tasks)}",
             "source: session-snapshot",
             "---",
             "",
             f"# Снапшот дня — {day}",
             ""]
    if st:
        lines += [f"Активность: входящих {st['inbound']}, исходящих {st['outbound']}, "
                  f"прогонов агента {st['agent_runs']}.", ""]
        if st["topics"]:
            lines.append("## О чём говорили")
            for t in st["topics"][:MAX_TOPICS]:
                lines.append(f"- {t}")
            lines.append("")
    if tasks:
        lines.append("## Открытые задачи из плана")
        for t in tasks[:12]:
            lines.append(f"- [ ] {t}")
        lines.append("")

    body = "\n".join(lines).rstrip() + "\n"
    out = CACHE / f"{day}-2350-auto.md"

    if dry:
        print(body)
        return 0

    CACHE.mkdir(parents=True, exist_ok=True)
    out.write_text(body, encoding="utf-8")
    print(f"снапшот: {out} ({len(body)} байт, задач {len(tasks)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
