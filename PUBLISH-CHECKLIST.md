# Publication checklist

Package: `publish/warm-cache-continuity/`
Skill source of truth: `~/.openclaw/agents/main/agent/workshop-skills/warm-cache-setup/`

## Done

- [x] Sanitized copy: no owner name, chat id, Tailscale IPs, host names, agent names, absolute user paths
- [x] Scripts: hardcoded SSH key / remote host / proxy URL replaced with env vars; `python3 -m py_compile` passes
- [x] README with "what it is / what it is NOT" — separates this from prompt caching and from claims of consciousness
- [x] Verified-on line: OpenClaw 2026.10.7
- [x] Phase 4 scripts added (`session-cache-backfill.py`, `session-cache-digest.py`, `session-cache-chroma-meta.py`)
- [x] Use case draft for `awesome-openclaw-usecases`: `../usecases/warm-cache-continuous-presence.md`
- [x] Community channels checked (07.11.2026): `openclaw/openclaw` has Discussions disabled (issues only); `VoltAgent/awesome-openclaw-skills` 53.6k stars; `hesamsheikh/awesome-openclaw-usecases` 31.6k stars, explicit CONTRIBUTING and table format

## Blocking decisions

- [ ] **Author name** — real name, nickname, or "anonymous". Affects SKILL.md frontmatter, LICENSE, commit author.
- [ ] **License holder** — MIT needs a name. Placeholder currently in README.
- [ ] **First channel** — ClawHub skill, standalone GitHub repo, or Tech Leads Club PR.
- [ ] **Repo name** — proposed `warm-cache-continuity` (avoids the prompt-cache collision in the title).

## Before publishing

- [ ] Reproduce on a clean install: fresh OpenClaw, no hooks, follow SKILL.md top to bottom, record every place the doc is wrong. Publishing an unverified procedure is how the pitfalls list stops being trustworthy.
- [ ] Test the presence gate in a sandbox workspace (`--now` + one case per window boundary), not against real silence state.
- [ ] Check the skill lints: frontmatter parses, `name` matches the directory, no dangling `related_skills`.
- [ ] Decide whether scripts ship inside the skill directory or as a separate repo referenced from SKILL.md. ChromaDB dependency makes the skill heavier than a typical skill.
- [ ] Strip `scripts/` binaries/caches if any (`__pycache__`).

## Announcement drafts

### English (community post)

> **Warm cache & living loop: continuity for long-lived agents**
>
> A fresh session starts blind: it re-asks what was already decided, and it says nothing between sessions. Bigger context windows don't fix this — a window is a budget you pay every turn, not memory.
>
> I published a skill with four cheap layers: an expiring task cache with importance TTLs (`critical` 14 days, `important` 7, `routine` never injected), raw session dumps kept separate from curated tasks, ChromaDB retrieval behind a tiny HTTP proxy for VPS hosts that can't run the client, and a presence watcher that speaks first only after 3 hours of silence, outside night hours, at most once per 3 hours — with zero model calls while quiet.
>
> The useful part is not the idea; it's the 27 pitfalls: hook basenames silently skipped, webchat sessions the message hooks never see, `btoa` missing in code-mode triggers, homoglyph names breaking owner matching.
>
> Verified on OpenClaw 2026.10.7. Link in comments.

### Russian (Telegram / Tech Leads)

> **Тёплый кэш и живой контур: непрерывность для долгоживущих агентов**
>
> Новая сессия начинается слепой: переспрашивает то, что уже решено, и молчит между сессиями. Большое контекстное окно это не лечит — окно это бюджет, который платишь каждый ход, а не память.
>
> Собрал скилл из четырёх дешёвых слоёв: кэш задач с TTL по важности (`critical` 14 дней, `important` 7, `routine` не инжектится), сырые дампы сессий отдельно от курируемых задач, ChromaDB за маленьким HTTP-прокси для VPS, где не заводится клиент, и watcher присутствия — пишет первым только после 3 часов тишины, вне ночных часов, не чаще раза в 3 часа, с нулём вызовов модели в тишине.
>
> Ценность не в идее, а в 27 граблях: хук молча пропускает файл с другим basename, message-хуки не видят webchat, в code-mode нет `btoa`, гомоглифы в имени владельца ломают сравнение.
>
> Проверено на OpenClaw 2026.10.7. Ссылка в комментариях.
