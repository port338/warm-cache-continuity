# Warm Cache & Living Loop — continuity for long-lived agents

A skill for OpenClaw that gives an agent **continuity between sessions**: it remembers what was unfinished, what was decided, and when it is appropriate to speak first.

Status: **published draft.** Verified in production on one host (OpenClaw 2026.10.7); not yet reproduced on a clean install.

## The problem

A fresh session starts blind. Two failures follow:

1. **Repetition.** The user re-explains a task that was already half done.
2. **Silence.** Nothing happens between sessions, so the agent is a tool you must remember to pick up.

Bigger context windows do not fix this. A window is not memory: it is a budget you pay on every turn, and it fills with whatever was said last, not with what still matters.

## What it does

Four layers, each cheap and independently switchable:

| Layer | File / service | Written by | Cost |
|---|---|---|---|
| 1. Curated cache | `memory/session-cache/YYYY-MM-DD-HHMM.md` | the agent, at the end of substantive work | one small write |
| 2. Raw dumps | `memory/YYYY-MM-DD-HHMM.md` | the `session-memory` hook on reset | no model call |
| 3. Retrieval | ChromaDB + a small HTTP proxy | nightly indexer | embeddings only for changed files |
| 4. Presence | `memory/stream/*.jsonl`, `memory/live/MEMORY.md`, a cron watcher | hooks + a condition script | **zero** model calls while quiet |

Layer 4 is the "living loop": an append-only stream of what was actually said, a short live-state file injected at startup, a model of the interlocutor's style, and an initiative job that fires only when the user has been silent for more than 3 hours, outside night hours, and not more than once per 3 hours. The gate is a plain script; when it returns `fire:false`, no tokens are spent.

## What is genuinely different here

- **Importance TTL instead of "read the last N files".** Every cache file carries `importance: critical | important | routine`. Startup injects `critical` for 14 days and `important` for 7; `routine` is never injected, only searchable. The startup read stops growing with history.
- **Two layers that do not duplicate.** Curated cache answers "what do I do next"; raw dumps answer "what was said". Mixing them is the usual reason memory files rot.
- **Initiative that costs nothing when idle.** The decision to speak is made by a condition script, not by a model that wakes up to decide it has nothing to say.
- **A proxy for hosts that cannot run the client.** ChromaDB's Python client needs numpy built for X86_V2; small VPS instances crash on import. A 60-line HTTP proxy on the host that *can* run it solves this without installing anything on the remote agent.

## What it is NOT

- **Not prompt caching.** "Warm cache" here means a warm *start* for the agent's own memory, not the provider-side KV/prompt cache that makes repeated prefixes cheaper. The name collides; if you have a better one, use it.
- **Not consciousness, not a person.** It is a behavioral record: files read at startup and a scheduler with a condition. Nothing in it thinks between turns.
- **Not a replacement for `MEMORY.md`, `USER.md` or daily notes.** It sits around them: short-lived, task-shaped, expiring.
- **Not free.** Retrieval and startup reads cost tokens; the design goal is to make that cost bounded and mostly proportional to what is still open.

## Quick start

Read `skills/warm-cache-setup/SKILL.md`. It is a procedure, not an essay: every step has a command and a check, and 27 documented pitfalls at the end — the ones that actually bite (hook basenames that are silently skipped, webchat sessions the message hooks never see, `btoa` missing in code-mode triggers, homoglyph names breaking owner matching).

Minimum viable path, if you want to try one piece first:

1. `memory/session-cache/` + step 3.5 in `AGENTS.md`. One evening of work, no infrastructure.
2. `openclaw hooks enable session-memory`. One command.
3. Only then: ChromaDB, the proxy, and the presence watcher.

The presence layer is the riskiest to deploy and the easiest to get wrong socially: default it to silent, and prove the gate with a sandboxed `--now` run before trusting the cron.

## Verified on

- OpenClaw 2026.10.7
- Linux, Node 24
- One production host with four agents; layers 1–2 in daily use, layer 3 running nightly, layer 4 running on a 20-minute watcher.

## License

MIT © 2026 port338.
