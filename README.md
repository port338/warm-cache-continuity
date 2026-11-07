# Warm Cache & Living Loop

Continuity for long-lived OpenClaw agents: a **warm start** for the agent's own memory, and a
**presence gate** that decides — without spending a single token — whether it is appropriate to
speak first.

The agent stops asking "what would you like to work on?" while three tasks are still open, and
it stops being mute for three days. It reads what is still actionable, and it says something
only when the silence is real and the hour is sane.

`MIT` · OpenClaw 2026.10.x · Python 3.10+ · Node 20+ (presence gate only) · no hosted service

**Status:** v1.2.0 — published draft. Verified in production on one host (OpenClaw 2026.10.7, Linux,
Node 24). Layers 1, 2 and 4 reproduced from scratch in an isolated `HOME`; the gate logic is
reproduced from zero (9 cases plus trigger round-trip). A live chat delivery was exercised on the
production host on 2026-11-07, together with the silent path (42 gate evaluations, one fire, no
model call on the rest) — see [`CLEANRUN-2026-11-07.md`](CLEANRUN-2026-11-07.md) and
[`LIVE-2026-11-07.md`](LIVE-2026-11-07.md) for exactly what was and was not proved. ChromaDB
remains untested from zero.

---

## Contents

- [30 seconds: before and after](#30-seconds-before-and-after)
- [The problem](#the-problem)
- [What "warm cache" means here](#what-warm-cache-means-here)
- [Architecture at a glance](#architecture-at-a-glance)
- [Phase 1 — Curated session cache](#phase-1--curated-session-cache)
- [Phase 2 — Raw session dumps](#phase-2--raw-session-dumps)
- [Phase 3 — Semantic index](#phase-3--semantic-index)
- [Phase 4 — Importance TTL and the digest](#phase-4--importance-ttl-and-the-digest)
- [Phase 5 — Living loop](#phase-5--living-loop)
- [Install: three paths](#install-three-paths)
- [Turning it on and off](#turning-it-on-and-off)
- [Using it day to day](#using-it-day-to-day)
- [Worked examples](#worked-examples)
- [Verification checklist](#verification-checklist)
- [Repository layout](#repository-layout)
- [Design decisions and trade-offs](#design-decisions-and-trade-offs)
- [Known limitations](#known-limitations)
- [Maintenance](#maintenance)
- [FAQ](#faq)
- [License](#license)

---

## 30 seconds: before and after

**Without a warm cache.** You spent last night in the middle of a mail-server change. The
service is still stopped. This morning:

> **You:** привет
> **Agent:** Hello! What would you like to work on today?
> **You:** …the nginx thing. From yesterday. The one where you said not to restart yet.

Four messages of re-explaining, and the agent never learns why "not yet" was the right call.

**With a warm cache.** The same morning:

> **Agent:** Yesterday we stopped after editing `nginx.conf` on the staging host — the service is
> still stopped, and the reason was that the certificate renews at 04:00 and we did not want two
> changes in the same window. The certificate renewed at 04:03. Do we start the service now?

The second version is not a bigger context window. It is 900 bytes of curated state, written at
the end of the previous session and read at the start of this one.

---

## The problem

A fresh session starts blind. Three distinct failures follow, and they need different fixes —
which is why this repository has layers rather than one clever prompt.

**1. Amnesia of the unfinished.** Long-term memory files (`MEMORY.md`, `USER.md`, daily notes)
are curated by design: they hold what matters forever. They do not hold "we stopped halfway
through the nginx config and the service is down". Continuity of *work* and memory of *facts*
are different problems.

**2. The flat start.** Every session opens with the same neutral greeting, because the agent has
no idea whether it spoke to you an hour ago or three days ago. It cannot say "you never answered
my question about the backup key", because it does not know a question was asked.

**3. Mute or noisy.** Proactive contact is either absent, or implemented as a cron that wakes a
model every 20 minutes to decide it has nothing to say. The first is a tool you must remember to
pick up; the second burns tokens to produce "Just checking in! 👋" at 03:40.

A larger context window fixes none of these. A window is a budget you pay on every turn, and it
fills with whatever was said last, not with what is still open.

---

## What "warm cache" means here

The name collides with prompt caching, so be precise about the claim:

| Term | What it caches | Who benefits |
|---|---|---|
| **Prompt / KV cache** (provider-side) | Token prefixes of the current request | Cheaper repeated turns in one conversation |
| **RAG over documents** | Chunks of a corpus | "Find the passage that mentions X" |
| **`MEMORY.md` / daily notes** | Durable facts and decisions | Long-term identity and preferences |
| **Warm cache** (this repo) | *Unfinished work and its rationale*, with an expiry date | The first minute of the next session |

"Warm" means the agent does not start cold: it starts with a small, task-shaped file that says
where you stopped, what was decided and why, and what to do first. Everything else is a
consequence of that idea.

What this is **not**:

- **Not consciousness, not a person.** It is a file read at startup plus a scheduler with a
  condition. Nothing in it thinks between turns.
- **Not a replacement for `MEMORY.md`.** It sits around it: short-lived, task-shaped, expiring.
- **Not free.** Startup reads and retrieval cost tokens. The design goal is to make that cost
  bounded and roughly proportional to what is still open — not to make it zero.

---

## Architecture at a glance

Five phases, five layers. Each is independently useful, and each is separately switchable — you
can run Phase 1 alone, forever, and get value.

| Phase | Layer | Written by | Read by | Model cost |
|---|---|---|---|---|
| **1** | Curated cache `memory/session-cache/*.md` | the agent, at the end of substantive work | startup digest | one small write per session |
| **2** | Raw dumps `memory/*.md` | built-in `session-memory` hook on `/new` | semantic index, human | **zero** (no model call) |
| **3** | ChromaDB collection + HTTP proxy | nightly indexer (mtime-idempotent) | search on demand | embeddings for changed files only |
| **4** | YAML frontmatter + digest TTL | backfill once, then the agent | every session start | **zero** (a Python script) |
| **5** | Stream, live state, people model, watcher | hooks + a condition script | bootstrap + cron | **zero while quiet** |

Data flow:

```text
                    ┌──────────────── Phase 1 ───────────────┐
 session ends  ───► │ memory/session-cache/2026-11-07-2210.md │
                    │ importance: critical · open_tasks: 2    │
                    └───────────────┬─────────────────────────┘
                                    │ nightly (Phase 3)
                                    ▼
  /new ──► Phase 2 hook ──►  memory/2026-11-07-2210.md  ──►  ChromaDB  ◄── proxy :8010 ◄── remote agent
                                    │                          ▲
                                    │                          │ on demand: "what did we decide about TTL?"
                                    ▼                          │
              Phase 4 digest  ──►  startup context  ──────────┘
              (critical 14d, important 7d, routine never)

  every message ──► Phase 5 stream .jsonl ──► gate script ──► fire? ──► model ──► ping
                                              (no model call)      └──► silence, 0 tokens
```

Two rules hold the whole thing together, and every layer is a consequence of them:

1. **The cache is a hint, not truth.** If a cache file says "configured X" and the config says
   Y, the config wins. An agent that confidently repeats stale state is worse than one that
   re-checks.
2. **Silence is a valid result.** A watcher with nothing worth saying must return `NO_REPLY` and
   suppress delivery. A content-free "checking in!" teaches the user to ignore all future pings.

---

## Phase 1 — Curated session cache

**Problem it solves:** the agent does not know what is unfinished, or why the last decision was
made.

**Cost:** one write of 1–4 KB at the end of a substantive session. No infrastructure, no
dependencies.

### File shape

`memory/session-cache/YYYY-MM-DD-HHMM.md` — the filename sorts lexicographically, which is
chronologically, which is the only sorting the startup reader needs.

```markdown
---
importance: critical
date: 2026-11-07
open_tasks: 2
source: session-cache
---

# Session Cache — 2026-11-07 22:10 (MSK)

## Open
- [ ] Start `nginx` on staging after the 04:00 certificate renewal — service is stopped on purpose
- [ ] Decide whether the backup key goes to the hardware token or the password manager

## Decisions
- Did not restart nginx before the renewal window: two changes in one window make rollback ambiguous.
- Chose `index_warm_cache.py` over `index_session_cache.py`: it skips unchanged files by mtime.

## Done this session
- Rewrote `nginx.conf` upstream block; `nginx -t` passes.
- Enabled `session-memory` hook on the staging gateway.

## Context for next me
- The user cares about rollback clarity more than speed. Say what is reversible before acting.
- Do not touch port 443 on the production host.
```

### Importance tags

The tag is the whole point: it decides how long the file keeps being injected at startup.

| Tag | Use for | Injected for |
|---|---|---|
| `critical` | An action in flight that causes harm if not continued: mid-config change, stopped service, open firewall change, half-finished key rotation | 14 days from `date` |
| `important` | Unfinished work that matters but is not urgent: equipment selected but not ordered, skill written but not tested | 7 days |
| `routine` | Completed, or low-value: a question answered, a normal triage run | never injected; searchable only |

Without TTL, startup slowly fills with resolved notes and burns context on nothing. That is the
single most common reason personal memory files rot.

Before Phase 4, the tag lives in a `## Метка важности` (importance) section; after backfill it
lives in the YAML frontmatter. Both readers accept either, but do not keep two sources — run the
backfill once and let the frontmatter be authoritative.

### Writing rules that matter

- **Only substantive sessions.** A session that answered one question does not need a file.
  Ten files a week of noise is worse than none.
- **Close tasks with `[x]`.** An open `[ ]` is a promise to the next session; a completed task
  left open is a lie that survives two weeks.
- **Record the *why*, not the *what*.** "Chose A over B because rollback would be ambiguous"
  is worth more than "changed config".
- **Never write secrets.** No tokens, no passwords, no private keys — cache files are indexed,
  copied to other agents, and sometimes published by accident.
- **Keep it 1–4 KB.** If it is longer, you are writing a diary, not a cache.

---

## Phase 2 — Raw session dumps

**Problem it solves:** the curated cache says what to do next; it cannot say what was actually
said. When the agent needs the exact wording of a decision, it needs the transcript.

This layer is one command, because it is already built into OpenClaw:

```bash
openclaw hooks info session-memory     # what it does, before changing anything
openclaw hooks enable session-memory
```

Configuration, if you need to change the message count:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": { "enabled": true, "messages": 15 }
      }
    }
  }
}
```

The hook writes the last ~15 user/assistant messages to `memory/YYYY-MM-DD-HHMM.md` on `/new`,
`/reset` or an automatic session rollover. Hot reload applies it; no Gateway restart.

**What it does not do — and this bites:**

- It writes to `<workspace>/memory/`, **not** to `memory/session-cache/`, and it exposes no
  directory option. Do not expect curated files to appear by themselves.
- Because both layers use the same timestamp naming, indexing them into one collection without
  a prefix collides ids. Index raw dumps with a `raw-` id prefix and keep curated files as bare
  stems.
- On the very first `/new` the file contains only a session header, because there was nothing
  to save yet. That is correct, not a partial failure.

Check after enabling: send `/new` in a safe conversation and confirm a new `memory/*.md` file
appeared, and that the Gateway log contains `Session context saved to`.

---

## Phase 3 — Semantic index

**Problem it solves:** "what did we decide about the cache TTL six weeks ago?" — a question that
no startup window can answer, because the answer is in a file that expired long ago.

Optional. Ships as three small Python files and one systemd unit. Everything below is in
`skills/warm-cache-setup/SKILL.md`, Step 3.

### Why a proxy instead of a direct client

Two hard constraints, both discovered the hard way:

1. **The Python client does not run everywhere.** `chromadb` pulls numpy built with `X86_V2`
   baseline optimizations; small VPS instances crash on `import chromadb` with
   `RuntimeError: NumPy was built with baseline optimizations: (X86_V2)`. Remote agents often
   cannot install it at all.
2. **The v2 REST API needs vectors, not text.** `/query` wants `query_embeddings`; posting
   `query_texts` is not enough. A plain `curl` from a remote host therefore does not work either.

The working shape: a ~60-line HTTP proxy on the one host that *can* run the client, and a
pure-`urllib` client on every other host. No dependencies on the remote side, nothing installed.

### Components

| File | Runs on | Purpose |
|---|---|---|
| `scripts/index_warm_cache.py` | the ChromaDB host | indexes curated cache, raw dumps and (optionally) a remote agent's cache; skips files whose `mtime` is unchanged |
| `scripts/index_session_cache.py` | the ChromaDB host | minimal variant: curated cache only |
| `scripts/search_proxy.py` | the ChromaDB host | HTTP `?q=&c=&n=` → JSON; port 8010 by default |
| `scripts/session_search.py` | any remote agent | calls the proxy with `urllib`, prints results with distance scores |
| `scripts/session-cache-chroma-meta.py` | the ChromaDB host | pushes `importance`, `date`, `open_tasks` into collection metadata for filtered search |

Setup order:

```bash
# 1. collections (one per agent)
cd ~/.openclaw/workspace/chromadb && source .venv/bin/activate
python3 -c "
import chromadb
c = chromadb.HttpClient(host='localhost', port=8000)
c.create_collection('sessions')          # main agent
c.create_collection('remote-sessions')   # one per additional agent
"

# 2. index, twice — the second run is the idempotency proof
python3 index_warm_cache.py --dry-run
python3 index_warm_cache.py
python3 index_warm_cache.py
```

Expected: the first real run reports `added=N`; the immediate second run reports
`added=0 updated=0 unchanged=N` on every layer. If the second run adds anything, the `mtime`
bookkeeping is broken and the nightly job is re-embedding the world.

Indexer configuration is entirely environment variables — no paths are baked in:

```bash
OPENCLAW_WORKSPACE=~/.openclaw/workspace
WARM_CACHE_COLLECTION=sessions
WARM_CACHE_REMOTE_HOST=root@100.x.x.x          # empty disables the remote layer
WARM_CACHE_SSH_KEY=~/.ssh/agent_ed25519
WARM_CACHE_REMOTE_DIR=~/.openclaw/workspace/memory/session-cache
WARM_CACHE_REMOTE_COLLECTION=remote-sessions
```

The proxy is a systemd unit, not a `nohup` (a `nohup` process dies when the exec session ends):

```ini
[Unit]
Description=ChromaDB Search Proxy
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=%h/.openclaw/workspace/chromadb
ExecStart=%h/.openclaw/workspace/chromadb/.venv/bin/python3 search_proxy.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Expose ChromaDB on the private network in `docker-compose.yml` — **keep** the localhost binding:

```yaml
ports:
  - "127.0.0.1:8000:8000"
  - "100.x.x.x:8000:8000"   # Tailscale / WireGuard address
```

Nightly refresh, as a Gateway automation with `delivery.mode: none` so a successful run stays
silent. The script payload **must return an object**; returning a bare string fails with
`cron script payload failed (internal_error)`:

```json
{
  "action": "add",
  "job": {
    "name": "warm-cache-index",
    "schedule": { "kind": "cron", "expr": "30 3 * * *", "tz": "Etc/UTC" },
    "sessionTarget": "isolated",
    "payload": {
      "kind": "script",
      "script": "const r = await exec({ command: '/path/chromadb/.venv/bin/python3 /path/chromadb/index_warm_cache.py' });\nreturn { summary: String(r.stdout || '').trim(), exitCode: r.exitCode };",
      "timeoutSeconds": 600,
      "toolBudget": 3
    },
    "delivery": { "mode": "none" },
    "failureAlert": { "after": 2 }
  }
}
```

Run it once on purpose and read the recorded run: a valid cron expression says nothing about
whether the payload works. `failureAlert.after: 2` waits for two consecutive failures instead of
reporting one flaky night.

---

## Phase 4 — Importance TTL and the digest

**Problem it solves:** "read the last 3–5 cache files" degrades. After a month, four of the five
are finished work, and the one thing that matters is on page two.

Phase 4 turns the tag into a filter: startup reads exactly what is still actionable.

```markdown
---
importance: critical | important | routine
date: YYYY-MM-DD
open_tasks: 3
source: session-cache
---
```

Three scripts, all resolving the workspace as `OPENCLAW_WORKSPACE` → `~/.openclaw/workspace`:

| Script | When | What it does |
|---|---|---|
| `session-cache-backfill.py` | once | infers the tag from the old `## Метка важности` section, takes the date from the filename, counts `[ ]`, prepends frontmatter; skips files that already have it |
| `session-cache-digest.py` | every session start | prints active files with their open tasks, then lists files outside the TTL window |
| `session-cache-chroma-meta.py` | after indexing | writes `importance` / `date` / `open_tasks` into collection metadata so search can filter `where={"importance": "critical"}` |

Then replace the naive startup line in `AGENTS.md` with the digest:

```markdown
3.5. Run `python3 scripts/session-cache-digest.py` — it prints open `[ ]` tasks from cache
     files still inside their importance window. Session-cache is a hint, not truth: if it
     contradicts a config or a file, verify and fix the cache.
```

Real output (script messages are in Russian; fields are `file · tag · age · open tasks`):

```text
Session-cache: 7 файлов, актуальных 4, вне окна 3

─ 2026-11-07-2210.md  ·  critical  ·  0 дн. назад  ·  задач: 2
   [ ] Start nginx on staging after the certificate renewal
   [ ] Decide where the backup key goes

─ 2026-11-05-1930.md  ·  important  ·  2 дн. назад  ·  задач: 1
   [ ] Order the AVR unit for the generator (model already chosen)

Итого открытых задач в актуальных файлах: 3

Вне окна (не инжектятся, доступны через ChromaDB):
  · 2026-10-21-1400.md — important, 17 дн.
  · 2026-10-19-0905.md — routine, 19 дн.
```

Flags: `--all` also shows expired files with their content, `--tasks` prints only the task lines
(useful for piping into a cron summary).

TTL is measured in **calendar days from the `date` field**, not from file mtime — copying or
archiving a file does not extend its life, which is what you want. A malformed `date` is worse
than a missing one: the digest treats it as today and the file never expires.

---

## Phase 5 — Living loop

Phases 1–4 make the agent remember. Phase 5 makes it *present*: it knows when you last spoke, it
keeps a short live state, and it can write first — through a gate that costs nothing while quiet.

Full procedure, hook code and automation payloads: `references/living-loop.md` (500+ lines).
The gate itself ships as runnable code — `scripts/living-loop/presence-check.mjs` and
`presence-trigger.js` — so Phase 5 is no longer a specification you have to implement yourself.

### 5.1 Stream — what was actually said

An append-only `memory/stream/YYYY-MM-DD.jsonl`, written by a `stream-logger` hook on every
inbound and outbound message. No model, no summarization, no rewriting — the file is evidence.

```text
~/.openclaw/hooks/stream-logger/
  HOOK.md
  handler.js
```

Two findings worth knowing before you build your own:

- **Message hooks do not cover every transport.** Internal `message:*` hooks never fire for the
  OpenAI-compatible webchat session, so the conversation the user actually reads stays invisible
  while the stream looks healthy. Cover `agent_end` with a small local plugin, and skip the
  sessions the message hooks already write.
- **The stream has no `channel` field.** Records carry `channelId` and `conversationId`; match on
  those plus `sessionKey`, and verify that a computed "last activity" equals the timestamp of a
  real inbound message before trusting it.

### 5.2 Live state — injected at startup

`memory/live/MEMORY.md`, 20–30 lines: where we are right now and what is next. Not a diary —
the daily notes are the diary.

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "bootstrap-extra-files": { "enabled": true, "paths": ["memory/live/MEMORY.md"] }
      }
    }
  }
}
```

`bootstrap-extra-files` loads only `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
`BOOTSTRAP.md` and `MEMORY.md`. **Any other basename is skipped silently** — `live-state.md` or
`STATE.md` will simply never appear, with no error. Keep the basename `MEMORY.md` and put it in a
subdirectory.

Verify in a normal user session, not in a cron or isolated run: those apply privacy filters and
may omit extra bootstrap files, which looks exactly like a broken hook.

### 5.3 People model

`memory/people/<name>.md`: observations about how the person thinks and reacts — "decides fast,
hates hedging, wants the reversible option first". Not facts about them; facts belong in
`USER.md`. Update after a notable conversation, never invent.

### 5.4 Initiative — the gate

A cron job every 20 minutes, `sessionTarget: isolated`, pinned to a cheap model with
`fallbacks: []`. Its `trigger.script` runs headless and returns `{fire, message?, state}`. The
model is only invoked when `fire` is true.

The gate, in order:

```text
inWindow      = weekday 07:00–22:00 MSK, rest day 10:00–22:00 MSK
restDay       = Saturday, Sunday, or a Russian public holiday (isdayoff.ru, cached monthly)
silence       = now − last inbound user message (live file, then stream, last 2 days)
sinceLastPing = now − state.lastPingAt

fire = inWindow AND silence > 3h AND sinceLastPing > 3h
```

Three details that decide whether this works in practice:

- **The gate is a plain script, not a model.** When it returns `fire:false`, no tokens are spent.
  This is the difference between an agent that is present and a cron that bills you to say
  nothing.
- **State is passed in the payload**, not in process memory (`--state-b64`): deduplication must
  survive a restart, and a condition script has no durable state of its own.
- **The owner's name arrives with homoglyphs.** Chat clients send the first letter of a name in
  the wrong alphabet — a Latin `A` inside a Cyrillic word — so a plain `includes("Анна")` misses
  `Aнна` forever. Normalize Latin lookalikes to Cyrillic, exclude bot display names, and skip
  utility requests such as session-title generation when computing last activity.

When the gate fires, the model receives facts, not vibes: current time, silence duration,
working day or holiday, and whether today's plan file exists. Its instruction file
(`memory/PRESENCE-PING.md`) starts the morning ping with that plan.

Run it yourself, no scheduler needed:

```bash
OPENCLAW_WORKSPACE="$PWD" \
  node skills/warm-cache-setup/scripts/living-loop/presence-check.mjs \
  --now 2026-11-06T10:00:00+03:00 \
  --state-b64 "$(printf '{}' | base64)"
# {"fire":true,"message":"Gate facts: now 2026-11-06 10:00 Europe/Moscow, working day. …","state":{…}}
```

Every owner-specific value is an environment variable; nothing is baked in. The ones that
matter: `OPENCLAW_WORKSPACE`, `PRESENCE_TZ`, `OWNER_NAME`, `OWNER_CHAT_ID`, `OWNER_HANDLES`,
`SILENCE_HOURS`, `MIN_GAP_HOURS`, `WEEKDAY_START_HOUR`, `WEEKEND_START_HOUR`,
`NIGHT_START_HOUR`. The full table is in `references/living-loop.md`.

### 5.5 Consolidation

A second job every three days, `delivery.mode: none`: reads the stream window, daily notes, live
state and the people file, updates them, and reports nothing in chat. This is what keeps the
cache from drifting into a pile of stale one-off files.

Both jobs pin a cheap model explicitly. An automation that inherits the default can silently run
routine consolidation on your most expensive fallback.

---

## Install: three paths

Pick the smallest path that solves your problem. Do not deploy Phase 5 on day one.

### Path A — 15 minutes, no infrastructure (Phase 1 + 2)

```bash
mkdir -p ~/.openclaw/workspace/memory/session-cache
openclaw hooks enable session-memory
```

Then add one line to `## Session Startup` in `AGENTS.md`:

```markdown
3.5. Read the last 3–5 files from `memory/session-cache/` (name order = time order). Pay
     attention to unchecked `[ ]` tasks and `critical`/`important` tags. The cache is a hint,
     not truth — verify against real files and configs.
```

A brand-new workspace has no `AGENTS.md` at all. Create it with a `## Session Startup` section
first, or there is no anchor and the line goes nowhere.

Finally, ask the agent once, in a session that has unfinished work:

```text
Before we finish, write memory/session-cache/2026-11-07-2210.md: what is unfinished, what we
decided and why, and what the next session should do first. Mark it critical.
```

### Path B — one evening (add Phase 4)

Copy the three `session-cache-*.py` scripts into `workspace/scripts/`, run the backfill once,
replace step 3.5 with the digest call, and also add this to `AGENTS.md` so future sessions keep
writing frontmatter:

```markdown
At the end of a substantive session, write a cache file with YAML frontmatter:
importance (critical|important|routine), date (YYYY-MM-DD), open_tasks (count), source.
```

### Path C — full loop (Phase 3 + 5)

Follow `skills/warm-cache-setup/SKILL.md` for the index and the proxy, then
`references/living-loop.md` for the stream, live state and the two automations. Deploy the
watcher **last**, with `delivery.mode: announce` pointed at your own direct chat, and prove the
gate in a sandbox before trusting the cron (see Example C).

---

## Turning it on and off

The whole mechanism is an OpenClaw plugin: `plugin/warm-cache-continuity/`. It is a normal
plugin with a JSON-schema config, so it appears in **Settings → Plugins** with a form — no
config-file surgery required. Layers can be switched independently, and the master switch
stops every active behavior at once.

| Setting | Default | What it controls | What "off" means |
|---|---|---|---|
| `enabled` | `true` | Master switch for the whole mechanism | Nothing is written, injected or sent. The presence gate returns `fire:false` before reading any file; the stream hook and the prompt hook return immediately. |
| `stream.enabled` | `true` | Layer 1 — append-only JSONL journal | No new stream lines. Existing history stays readable by the consolidation pass. |
| `stream.maxContent` | `8000` | Truncation of one message | — |
| `liveState.enabled` | `true` | Layer 2 — `memory/live/MEMORY.md` injected before the model runs | No working state in the prompt; the file itself is not modified. |
| `liveState.maxBytes` | `20000` | Size guard for the injection | — |
| `presence.enabled` | `true` | Layer 4 — silence-gated initiative | The scheduled job still wakes every 20 minutes, evaluates the trigger and exits with `fire:false`. Zero model calls, zero messages. |
| `presence.timezone` | `Europe/Moscow` | Quiet hours and morning windows | — |
| `presence.silenceHours` | `3` | Silence required before a ping | — |
| `presence.minGapHours` | `3` | Cooldown between pings | — |
| `presence.weekdayStartHour` | `7` | End of quiet hours on working days | — |
| `presence.weekendStartHour` | `10` | End of quiet hours on weekends/holidays | — |
| `presence.nightStartHour` | `22` | Start of quiet hours, every day | — |
| `consolidation.enabled` | `false` | Layer 5 — scheduled consolidation pass | Manual updates to the working state are still allowed. |

### Install the plugin

```bash
mkdir -p ~/.openclaw/extensions/warm-cache-continuity
cp plugin/warm-cache-continuity/* ~/.openclaw/extensions/warm-cache-continuity/
openclaw plugins inspect warm-cache-continuity --runtime
```

Then make it loadable and grant the conversation hooks it needs:

```json
{
  "plugins": {
    "entries": {
      "warm-cache-continuity": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

`allowConversationAccess` is required for `agent_end` and `before_prompt_build` on a
non-bundled plugin. Without it the plugin loads, reports `hookCount: 0`, and silently does
nothing.

### Flip the switch

Control UI: **Settings → Plugins → Warm Cache & Living Loop**. The same value from a shell:

```bash
# whole mechanism off
openclaw config set plugins.entries.warm-cache-continuity.config.enabled false

# only the initiative off, keep the stream and the injected state
openclaw config set plugins.entries.warm-cache-continuity.config.presence.enabled false

# back on
openclaw config set plugins.entries.warm-cache-continuity.config.enabled true
```

Changes apply without restarting the Gateway: the plugin is replaced, and it rewrites
`~/.openclaw/warm-cache/effective.json`, which every out-of-process consumer reads — the
internal `stream-logger` hook and `presence-check.mjs` included. That file is the contract
between the plugin and the scripts; deleting it keeps the old behavior (everything on).

### What the switch does not do

- It does not delete data. Turning it off stops new writes; `memory/stream/`, `memory/live/`
  and the cache files stay exactly where they are, and turning it back on resumes from them.
- It does not disable the `session-memory` hook or the semantic indexer. Those are separate
  components with their own switches (`openclaw hooks disable session-memory`, stop the indexer
  timer). The plugin owns layers 1, 2, 4 and the settings layer 5 needs.
- It does not touch the automation itself. The job stays scheduled and keeps returning
  `fire:false`; this is deliberate, so that toggling back on needs no repair of the scheduler.

---

## Using it day to day

You do not operate this. It runs in the background. What you actually do:

| Moment | What happens | What you do |
|---|---|---|
| End of substantive work | agent writes a cache file, tags it, closes finished tasks | nothing — or say "mark this critical" |
| `/new` or daily rollover | `session-memory` dumps the last ~15 messages | nothing |
| New session start | digest prints open tasks inside their window | nothing; correct the agent if it repeats a stale item |
| 03:30 | indexer re-embeds only changed files | nothing; check the run if a search looks stale |
| 6 weeks later | you ask about an old decision | ask normally — semantic search finds it |
| 3+ hours of your silence, daytime | gate fires, agent pings once with a reason | answer, or ignore; next ping is at least 3 h away |
| 22:00–07:00 (10:00 on weekends/holidays) | gate returns `fire:false` | nothing, and that is the design |

Prompts that work well with this design:

```text
What is still open from the last three sessions? Check the cache but verify against the files.
Mark this session critical — we are mid-change and the service is stopped.
Close the nginx task in the cache; it is done and verified.
What did we decide about the TTL, and when? Search the older sessions.
Do not ping me before 10:00 tomorrow.
```

Prompts that fight it:

```text
Remember everything.            → a cache that grows without bound is a cache nobody reads
Just read all past sessions.    → 200 files of context, 3 lines relevant
Check in with me regularly.     → the gate needs a condition, not an adjective
```

---

## Worked examples

### Example A — recovering an interrupted task

**Situation.** A config change is half-applied on staging; the service is stopped on purpose. The
session ends with no closing message.

Cache file written at the end of that session (`critical`, two open tasks):

```markdown
---
importance: critical
date: 2026-11-07
open_tasks: 2
---
## Open
- [ ] Start nginx on staging after the 04:00 certificate renewal
- [ ] Decide where the backup key lives

## Decisions
- No restart before the renewal: two changes in one window make rollback ambiguous.
```

**Next morning.** Startup runs `session-cache-digest.py`, which prints the file because
`critical` is inside 14 days and the age is 0. The agent's first message:

> Yesterday we stopped after editing the upstream block on staging. `nginx -t` passed, but the
> service is still stopped: we were waiting for the certificate renewal at 04:00 so a rollback
> would be unambiguous. It renewed at 04:03. Shall I start the service and watch the error log
> for five minutes?

What made this work was not the task text — it was the **reason** in the cache. Without it, the
agent would have restarted nginx immediately, which was the one thing the previous session had
decided not to do.

**The failure mode to watch for:** if the agent says "we discussed the nginx config" but cannot
name the reason, it read a stale or thin cache. Fix the cache, not the prompt.

### Example B — a decision from six weeks ago

**Situation.** You remember choosing a TTL, not the numbers.

```bash
curl -s "http://127.0.0.1:8010/?q=importance%20TTL%20days&c=sessions&n=3" | head -c 600
```

```json
{
  "collection": "sessions",
  "results": [
    { "id": "2026-09-24-2310", "distance": 0.31,
      "document": "## Decisions\n- TTL: critical 14 days, important 7, routine never injected...",
      "metadata": { "importance": "critical", "date": "2026-09-24" } }
  ]
}
```

From a remote agent, same query with no dependencies:

```bash
export OPENCLAW_SEARCH_PROXY=http://100.x.x.x:8010
export OPENCLAW_SEARCH_COLLECTION=remote-sessions
python3 session_search.py "importance TTL days"
```

With Phase 4 metadata you can narrow the search instead of trusting distance alone:

```python
col.get(where={"importance": "critical"}, include=["documents", "metadatas"])
```

**Why this example matters:** the answer was in a file that had already expired from the startup
window. TTL keeps startup cheap; the index keeps old decisions findable. Removing either half
breaks the other.

### Example C — should the agent speak?

Five runs of the same gate script with `--now` and `--state-b64`, pointed at a sandbox workspace
(never the live one — a sandbox `OPENCLAW_WORKSPACE` is the difference between a test and a
coincidence):

| Local time (MSK) | Day | Silence | Last ping | `fire` | Why |
|---|---|---|---|---|---|
| 14:20 | Wed | 4 h 10 m | 5 h ago | **true** | inside window, silence > 3 h, spacing ok |
| 14:50 | Wed | 4 h 40 m | 30 m ago | false | pinged too recently — silence does not reset the spacing |
| 21:55 | Wed | 9 h | never | **true** | last legal minute: the window closes at 22:00 |
| 22:05 | Wed | 9 h 5 m | never | false | night window, even with a 9-hour silence |
| 09:40 | Sat | 14 h | never | false | rest day starts at 10:00, not 07:00 |
| 10:05 | Sat | 14 h 25 m | never | **true** | rest-day window open, silence satisfied |

The fourth row is the one people get wrong: a "silent for 9 hours" agent is most eager to ping
exactly when it should not. The gate checks the clock **before** it checks the silence, and the
cheapest possible outcome — no model call — is the normal case, not the exception.

And row three is the other trap: a boundary case you assert on purpose, not one you discover in
production. `21:55` fires, `22:05` does not, and only an explicit pair of runs proves the edge.

Reproduce one case:

```bash
OPENCLAW_WORKSPACE=/tmp/gate-sandbox \
  node scripts/living-loop/presence-check.mjs --now 2026-11-07T23:10:00+03:00
# {"fire":false,"state":{}}
```

### Example D — when the cache lies

**Situation.** The cache says `session-memory` is enabled. The config says it is not.

```bash
python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.openclaw/openclaw.json'))).get('hooks',{}))"
# {'internal': {'entries': {'boot-md': {'enabled': True}}}}
openclaw hooks list
```

Two possibilities, and they need different fixes:

- **The cache is wrong** → the hook was enabled and later turned off, or enabled on a different
  profile. Fix the cache file, then enable the hook where the Gateway actually runs.
- **The config is wrong** → the hook exists in a different profile or the Gateway did not reload.
  Check `journalctl --user -u openclaw-gateway | grep 'config hot reload'`.

The rule: **files and command output are truth, the cache is a hint.** An agent that reports the
mechanism as healthy because a cache file says so is worse than one that admits it does not know.

---

## Verification checklist

Run these before believing any of the above. Every one of them is a fact you can observe.

| # | Check | Expected |
|---|---|---|
| 1 | `ls -la memory/session-cache/` | files exist, newest is from the last session |
| 2 | `python3 scripts/session-cache-digest.py` | open task count matches what you know is open |
| 3 | `grep -c "3.5" AGENTS.md` | exactly `1` — two means the block was inserted twice |
| 4 | `openclaw hooks list` | `session-memory` present and enabled |
| 5 | Send `/new`, then `ls -t memory/*.md \| head -1` | a new dump exists; log says `Session context saved to` |
| 6 | Index twice | second run: `added=0 updated=0 unchanged=N` |
| 7 | `curl "http://127.0.0.1:8010/?q=test&c=sessions&n=1"` | JSON with a result, not an HTML error page |
| 8 | `systemctl status chromadb-search-proxy` | `active (running)`, survives an exec session ending |
| 9 | Backfill, then digest | a 40-day-old `important` file lands in "outside window" and its tasks are not counted |
| 10 | Gate in a sandbox at 23:10 | `{"fire":false}`; at 14:00 with 4 h silence, `{"fire":true}` |
| 10a | `node scripts/living-loop/presence-check.mjs --now <Fri 10:00> --state-b64 …` | `fire: true` with silence ≥ 3 h; `fire: false` at 06:30 and 22:00 |
| 10b | Same, `state.lastPingAt` 2 h ago | `fire: false` — the 3 h gap holds |
| 11 | Force a run of the index job, then read the run | status `ok`, per-layer counts in the summary |
| 12 | New session, no prompting | agent opens with the unfinished task, not a greeting |

Clean-install status of the same checks is recorded in
[`CLEANRUN-2026-11-07.md`](CLEANRUN-2026-11-07.md): 1–5 and the Phase 4 checks pass from
scratch; the gate logic passes 9 boundary cases plus the trigger round-trip from zero; 6–8
were verified only on the production host.

Live behaviour of the watcher is recorded in [`LIVE-2026-11-07.md`](LIVE-2026-11-07.md): a fired
ping reached the chat (`deliveryStatus: delivered`), 42 gate evaluations produced exactly one model
call, a `NO_REPLY` run suppressed delivery, and the 22:00 night boundary held. Matrix delivery and
the failure-alert path are still untested.

---

## Repository layout

```text
warm-cache-continuity/
├── README.md                                   ← you are here
├── CLEANRUN-2026-11-07.md                      ← clean-install report, what was proved
├── PUBLISH-CHECKLIST.md                        ← what is done, what is still open
├── LICENSE                                     ← MIT
├── plugin/warm-cache-continuity/               ← the switch: schema + hooks, one plugin
│   ├── openclaw.plugin.json                    ← Settings form, master and per-layer switches
│   ├── index.js                                ← stream (agent_end) + live state (before_prompt_build)
│   └── package.json
└── skills/warm-cache-setup/
    ├── SKILL.md                                ← the procedure: every step with a check
    ├── references/living-loop.md               ← stream, live state, automations, consolidation
    ├── references/PRESENCE-PING.md             ← example instruction file for the ping turn
    ├── references/CONSOLIDATION.md             ← example instruction file for consolidation
    └── scripts/
        ├── living-loop/presence-check.mjs      ← the gate: clock + stream + state → {fire, message, state}
        ├── living-loop/presence-trigger.js     ← trigger.script wrapper, code mode, no btoa/Buffer
        ├── index_warm_cache.py                 ← idempotent indexer (all layers)
        ├── index_session_cache.py              ← minimal indexer
        ├── search_proxy.py                     ← HTTP proxy, port 8010
        ├── session_search.py                   ← urllib client for remote agents
        ├── session-cache-backfill.py           ← one-time frontmatter migration
        ├── session-cache-digest.py             ← startup reader with TTL
        └── session-cache-chroma-meta.py        ← metadata for filtered search
```

30 numbered pitfalls live at the end of `SKILL.md`. They are the reason this repository exists
in this shape: each one cost a debugging session, and most of them fail **silently** — a hook
that skips a file, a basename that is ignored, a comparison that misses a homoglyph, a digest
that reads the wrong workspace and reports an empty cache instead of an error.

---

## Design decisions and trade-offs

**Files, not a database.** A cache file is readable with `cat`, editable by the agent with the
tools it already has, and recoverable with `git`. A schema would buy queries you do not need and
cost a migration every time the agent's needs change. The only database in the design is
ChromaDB, and it is a derived index — delete it and nothing is lost.

**TTL by importance, not "last N files".** "Last 5" is a proxy for relevance that breaks exactly
when it matters: after a busy week of trivia, the one critical unfinished task is at position 6.
The tag is a decision the agent makes while it still has context, which is the cheapest moment
to make it.

**The gate is code, not a prompt.** A model asked "should you check in?" will sometimes say yes
for no reason. A script that returns `fire:false` cannot. This also makes idle cost exactly zero,
which is what makes a 20-minute schedule acceptable.

**A proxy instead of installing clients everywhere.** Fewer dependencies on the remote host is
worth one small service on the host that already has the dependency. It also centralizes the
index, so three agents share one search.

**Silence is a feature, and it is testable.** `NO_REPLY` with suppressed delivery is a pass, not
a failure. Any design where the quiet outcome is ambiguous will drift into noise within a month.

---

## Known limitations

- **ChromaDB and a live chat delivery were not reproduced on a clean install.** Layers 1, 2 and
  4 were; the index needs a container and embeddings, and a real ping needs a configured
  channel. The gate logic itself is now reproduced from zero (9 cases, plus the trigger's
  base64 round-trip and the broken-checker path), so treat Phase 5 as "logic proved, delivery
  documented and running in production".
- **Single-user design.** The people model, homoglyph handling and night window are configured
  for one person's chat identity. Multi-user deployments need the gate's sender matching
  rewritten, not just a config change.
- **Time zone is explicit, not inferred.** The gate computes MSK; other zones change one
  constant. Holidays come from `isdayoff.ru` (Russian calendar) with a monthly cache.
- **Russian output in the Phase 4 scripts.** Labels are Russian; the data is plain text. Field
  meanings are documented above, and an English locale is a small patch.
- **Message hooks miss webchat.** Without the `agent_end` plugin from `references/living-loop.md`,
  the stream will look healthy while ignoring the conversation the user actually has open.
- **Not a memory replacement.** If you want durable facts and preferences, use `MEMORY.md` and
  `USER.md`. This is the layer around them that expires.

---

## Maintenance

| Interval | Task | Why |
|---|---|---|
| every session | close finished `[ ]` tasks | an open task that is done poisons the next start |
| weekly | skim `memory/session-cache/`, delete noise, merge duplicates | ten stale files cost more context than they save |
| weekly | check the index job's last run | a silent nightly failure looks exactly like "nothing changed" |
| monthly | verify one search end to end | the proxy can be up while the index is stale |
| quarterly | review the gate windows and ping cadence | your sleep schedule is the real spec |
| at 50 cache files | archive closed files to `memory/session-cache/archive/` | keeps `ls` and the digest readable |
| when the agent repeats a stale item | fix the cache file, then the prompt | the cache is the cheaper bug |

---

## FAQ

**Does it duplicate `MEMORY.md`?** No. `MEMORY.md` holds what is true for years; the cache holds
what is true for days and then expires. Mixing them is the usual reason memory files rot.

**How many tokens does it cost?** One small write per substantive session, one digest read at
startup (a few hundred tokens), embeddings for changed files at night. Idle presence costs
nothing at all. There are no numbers here because they depend on your cache size — measure your
own digest output, it is printed in plain text.

**Will it work with a model other than the one you use?** Yes. Nothing in Phases 1–4 calls a
model. Phase 5 calls one only when the gate fires, and pins it explicitly.

**Can several agents share one cache?** They share the *index*: one ChromaDB, one collection per
agent, one proxy. The cache files stay per-workspace. See "Deploying to other agents" in
`SKILL.md`.

**Does it work without ChromaDB?** Yes — Phases 1, 2, 4 and 5 do not touch it. Phase 3 is the
only layer that needs a database, and it is optional.

**Why not just a big `AGENTS.md`?** Because it grows monotonically and is read on every turn.
The cache is the part that forgets, and forgetting is the feature.

**Is this an agent that "lives" between sessions?** No. Between turns there is a JSONL file and a
cron expression. The useful claim is narrower: the next session starts warm, and silence is
respected.

---

## License

MIT © 2026 port338. Use it, fork it, rename it — the name collides with prompt caching, and a
better one is welcome.
