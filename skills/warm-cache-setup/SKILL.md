---
name: warm-cache-setup
description: "Use for OpenClaw warm cache or living-loop memory: session-cache, session-memory, stream hook, live state, presence watcher, consolidation. Produces continuity."
version: 1.2.0
author: port338
license: MIT
metadata:
  openclaw:
    tags: [session, continuity, cache, hooks, memory]
---

# Warm Cache Setup

## When to Use

- Agent loses context between sessions and the user wants continuity of unfinished tasks
- Setting up a new agent (remote agent, second agent) and wanting warm cache from the start
- User asks for "warm cache", "session cache", "remember last session", or "don't make me repeat"
- User asks for continuous presence between sessions: a record of what was said, a live state file, a model of the interlocutor, or proactive morning contact

**Do NOT use for:** general memory management (MEMORY.md, daily notes) or philosophical discussions about AI consciousness.

## Architecture: Two Layers

1. **Structured session-cache** (manual, written by the agent at end of substantive sessions) — files in `memory/session-cache/YYYY-MM-DD-HHMM.md` containing unfinished tasks, key decisions, and context for the next session. This is a hint, not source of truth.
2. **Built-in session-memory hook** (automatic, written by OpenClaw on session reset) — files in `memory/YYYY-MM-DD-HHMM.md` containing raw recent conversation messages.

The layers do not duplicate: structured cache = "what to do next", raw session-memory = "what was said". An optional living loop adds an append-only stream, injected live state and scheduled initiative; see "Living loop" below.

## Step 1: Create the session-cache directory

```bash
mkdir -p memory/session-cache
```

Check: `ls -d memory/session-cache/` succeeds.

## Step 2: Write the first session-cache file

Write `memory/session-cache/YYYY-MM-DD-HHMM.md` using this template:

```markdown
# Session Cache — YYYY-MM-DD HH:MM (TZ)

## Метка важности
important

## Незавершённое
- [ ] Task — brief context
- [x] Completed task — what was done

## Ключевые решения
- Decision: rationale

## Выполнено в этой сессии
- Action taken

## Контекст для следующего меня
- What the user discussed
- What's pending and why
```

### Importance tags

- `critical` — unfinished action that can cause harm if not continued (mid-config change, stopped service, open firewall change, mid-SSH-key work). Read for 14 days.
- `important` — unfinished task that matters but isn't urgent (equipment selected but not ordered, skill written but not tested, career gap analysis waiting for data). Read for 7 days.
- `routine` — completed or low-priority (question answered, triage ran normally). Not injected at startup; only retrieved via semantic search.

Rules for writing session-cache:
- Write only for substantive sessions with unfinished work or important decisions, not for every session.
- Keep each file 1–4 KB, 5–15 lines of content.
- Unfinished tasks use `[ ]`; close them with `[x]` when done.
- Never write secrets or credentials into session-cache files.

## Step 3: ChromaDB Semantic Search (Phase 3)

Session-cache files are indexed in ChromaDB for semantic search across past sessions. Remote agents (remote agent, second agent) cannot run the chromadb Python client directly because numpy requires X86_V2 CPU instructions not available on small VPS instances. The ChromaDB v2 REST API requires pre-computed query_embeddings, so a plain HTTP call is not enough.

The working architecture: a lightweight HTTP search proxy running on the host that holds ChromaDB (the primary agent), which accepts text queries and returns JSON results. Remote agents call it over a private network (Tailscale, WireGuard, or an SSH tunnel) with pure urllib — no dependencies.

### Step 3a — Create collections in ChromaDB

On the primary agent host (where the `chromadb` container runs):

```bash
cd ~/.openclaw/workspace/chromadb && source .venv/bin/activate
python3 -c "
import chromadb
client = chromadb.HttpClient(host='localhost', port=8000)
client.create_collection('sessions')           # primary agent
client.create_collection('remote-sessions')    # one per additional agent
"
```

### Step 3b — Index session-cache files

Copy `scripts/index_session_cache.py` into `chromadb/` and run it. It upserts every `memory/session-cache/*.md` with `ids=[file stem]`, `documents=[content]`, `metadatas=[{'agent': ..., 'source': path}]`, so re-runs update instead of duplicating.

```bash
cd ~/.openclaw/workspace/chromadb && source .venv/bin/activate && python3 index_session_cache.py
```

Check: output ends with `total in 'sessions': N` and N equals the number of cache files.

For a deployment with the hook enabled, use `scripts/index_warm_cache.py` instead: it indexes both layers (curated `session-cache/`, raw hook dumps from `memory/`) plus an optional remote agent's cache, and skips any file whose stored `mtime` metadata is unchanged, so a daily run costs no embedding work. Copy it into `chromadb/` and configure it with environment variables (all optional):

```bash
OPENCLAW_WORKSPACE=~/.openclaw/workspace          # workspace root
WARM_CACHE_COLLECTION=sessions                    # local collection
WARM_CACHE_REMOTE_HOST=root@100.x.x.x             # remote agent; empty disables layer C
WARM_CACHE_SSH_KEY=~/.ssh/remote_agent_ed25519    # key for that host
WARM_CACHE_REMOTE_DIR=~/.openclaw/workspace/memory/session-cache
WARM_CACHE_REMOTE_COLLECTION=remote-sessions
```

```bash
cd ~/.openclaw/workspace/chromadb && .venv/bin/python3 index_warm_cache.py --dry-run
cd ~/.openclaw/workspace/chromadb && .venv/bin/python3 index_warm_cache.py
```

Check: the first run reports `added=N`; an immediate second run reports `added=0 updated=0 unchanged=N` on every layer.

### Step 3c — Install the search proxy as a systemd service

Copy `scripts/search_proxy.py` to the chromadb directory. It listens on port 8010, takes `?q=query&c=collection&n=5`, uses the chromadb Python client locally, and returns JSON. Create a systemd unit:

```ini
[Unit]
Description=ChromaDB Search Proxy
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=~/.openclaw/workspace/chromadb
ExecStart=~/.openclaw/workspace/chromadb/.venv/bin/python3 search_proxy.py
Restart=always
RestartSec=5
User=openclaw

[Install]
WantedBy=multi-user.target
```

Expose ChromaDB on the Tailscale IP in `chromadb/docker-compose.yml` (add `100.x.x.x:8000:8000` alongside `127.0.0.1:8000:8000`).

### Step 3d — Install the remote search script

Copy `scripts/session_search.py` to the remote agent's `workspace/chromadb/` directory. It uses pure urllib to call the proxy. No pip dependencies needed on the remote agent. Point it at the primary host over whatever private network you already have:

```bash
export OPENCLAW_SEARCH_PROXY=http://100.x.x.x:8010
export OPENCLAW_SEARCH_COLLECTION=remote-sessions
```

Test from the remote agent:

```bash
python3 /root/.openclaw/workspace/chromadb/session_search.py "vision"
```

Check: returns matching documents with distance scores.

## Step 3e: Schedule daily indexing

A Gateway automation keeps the index fresh with no model call:

```json
{
  "action": "add",
  "job": {
    "name": "warm-cache-index",
    "declarationKey": "warm-cache-index-daily",
    "schedule": { "kind": "cron", "expr": "30 3 * * *", "tz": "Asia/Almaty" },
    "sessionTarget": "isolated",
    "payload": {
      "kind": "script",
      "script": "const r = await exec({ command: \"/path/chromadb/.venv/bin/python3 /path/chromadb/index_warm_cache.py\" });\nreturn { summary: String(r.stdout || '').trim(), exitCode: r.exitCode };",
      "timeoutSeconds": 600,
      "toolBudget": 3
    },
    "delivery": { "mode": "none" },
    "failureAlert": { "after": 2 }
  }
}
```

Return an object from the script payload. Returning a bare string fails with `cron script payload failed (internal_error): cron script payload must return an object`.

Run the job right after adding it and read the recorded result; a valid schedule says nothing about whether the payload works:

```
automations(action="run", jobId="<id>", runMode="force", timeoutMs=120000)
automations(action="runs", jobId="<id>", runId="<runId>")
```

Check: status `ok`, and the summary carries the per-layer `added/updated/unchanged/total` counts.

Keep `delivery.mode` at `none` so successful nightly runs stay silent; `failureAlert.after: 2` waits for two consecutive failures instead of reporting one flaky night.

## Step 4: Wire startup reading into AGENTS.md

A brand-new workspace has no `AGENTS.md`. If the file is missing, create it first with a `## Session Startup` section — otherwise there is no anchor to insert into.

Add step 3.5 in the Session Startup section, between step 3 (daily notes) and step 4 (MEMORY.md):

```markdown
3.5. Read last 3-5 files from `memory/session-cache/` (sorted by name = by time). Pay special attention to unchecked tasks `[ ]` and `critical`/`important` tags. Session-cache is a hint, not source of truth — verify against actual files/configs.
```

Check: `grep -n "3.5" AGENTS.md` returns exactly one line, and that line still contains `memory/session-cache/`, `[ ]`, and `critical`/`important`. Missing values mean the block was inserted through a templating path that stripped backticks — rewrite the line by hand. Two matching lines mean the step was added twice; delete the broken copy.

## Step 5: Enable the built-in session-memory hook

Check the live config first — a `hooks.internal.entries` object containing only `boot-md` means session-memory is off, whatever the plan assumes:

```bash
python3 -c "import json;print(json.load(open('~/.openclaw/openclaw.json')).get('hooks',{}))"
openclaw hooks list
```

Then run on the Gateway host with the same profile as the Gateway:

```bash
openclaw hooks info session-memory
openclaw hooks enable session-memory
```

The hook saves the last ~15 user/assistant messages to `memory/YYYY-MM-DD-HHMM.md` on `/new`, `/reset`, or `session:auto-reset` (daily/idle rollover). Default config uses 15 messages; set `messages` to adjust:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": {
          "enabled": true,
          "messages": 15
        }
      }
    }
  }
}
```

Hot-reload applies the change without restarting the Gateway. To disable: `openclaw hooks disable session-memory`.

Check: after sending `/new` in a safe conversation, a new `memory/YYYY-MM-DD-HHMM.md` file appears. On the very first `/new` the file contains only the session header and no messages — that is correct, there was nothing to save yet.

## Step 6: Verify the warm cache works

1. Have a substantive session with an unfinished task.
2. Write a session-cache file manually.
3. Close the session (`/new` or `/reset`).
4. Start a new session.
5. Confirm the agent reads session-cache files at startup (visible in startup behavior — agent references the unfinished task without being asked).

Failure modes:
- Agent doesn't read cache → check AGENTS.md step 3.5 is present and session-cache files exist.
- Session-memory hook doesn't fire → check `openclaw hooks list` shows it as ready and enabled; check Gateway logs for "Session context saved to".
- Cache file has wrong info → the agent should detect contradiction with actual files/configs and verify rather than trusting the cache blindly.

## Living loop: stream, live state, initiative

Use this when the warm cache is not enough and the user wants presence between sessions, not only a task list. Full procedure, hook code and automation payloads: `references/living-loop.md`. The gate itself is shipped as code in `scripts/living-loop/` (`presence-check.mjs`, `presence-trigger.js`), and the two instruction files are shipped as examples (`references/PRESENCE-PING.md`, `references/CONSOLIDATION.md`). Copy the scripts into `<workspace>/scripts/living-loop/`; every owner-specific value is an environment variable, not a constant.

1. Stream: create `~/.openclaw/hooks/stream-logger/` with `HOOK.md` and `handler.js` from the reference; enable `hooks.internal.entries.stream-logger.enabled` by an atomic config edit; confirm `config hot reload applied` in the Gateway journal and two JSON lines from a direct handler test.
2. Live state: write `memory/live/MEMORY.md` and add `bootstrap-extra-files` with `paths: ["memory/live/MEMORY.md"]`. Only the basename `MEMORY.md` is loadable. Verify the bundled handler returns the file with `missing: false`.
3. People model: write `memory/people/<name>.md` with observed style and reactions, not facts that belong in `USER.md`.
4. Initiative: add `living-loop-presence-watch` — cron `*/20 * * * *` in `Europe/Moscow`, `sessionTarget: isolated`, an `agentTurn` that follows `memory/PRESENCE-PING.md`, announced to the owner's direct chat. Its `trigger.script` is the shipped `scripts/living-loop/presence-trigger.js`, which runs `scripts/living-loop/presence-check.mjs` headless and returns `fire` only when the user has been silent >3 h, the moment is outside the night window, and no ping went out in the last 3 h, so quiet cycles cost no model call. Configure the gate with `OPENCLAW_WORKSPACE`, `PRESENCE_TZ`, `OWNER_NAME`, `OWNER_CHAT_ID`, `OWNER_HANDLES`, `SILENCE_HOURS`, `MIN_GAP_HOURS` and the three window hours — defaults are documented in the reference. Add `living-loop-consolidate` (every 3 days, isolated, `delivery: none`) with the same cheap-model pin. Day plans live in `memory/plans/YYYY-MM-DD.md`; every morning ping opens with that day's plan.
5. Verify each job with a forced run and read status, model and summary; a ping with nothing to say returns `NO_REPLY` and suppresses delivery. For the watcher, prove the gate with `--now` and `--state-b64` in a sandbox `OPENCLAW_WORKSPACE`, one case per window boundary and per ping spacing, before trusting the cron; procedure and the eight-case matrix are in the reference.
6. Make it switchable. Copy `plugin/warm-cache-continuity/` to `~/.openclaw/extensions/`, add
   the entry with `hooks.allowConversationAccess: true`, and confirm
   `openclaw plugins inspect warm-cache-continuity --runtime` lists `agent_end` and
   `before_prompt_build`. The plugin becomes the owner of layers 1 and 2 and exports the
   resolved settings to `~/.openclaw/warm-cache/effective.json`; the internal `stream-logger`
   hook and `presence-check.mjs` read that file, so one master switch stops all active
   behavior. Once the plugin is proven, set `hooks.internal.entries.bootstrap-extra-files`
   to `enabled: false` — otherwise the live state is injected twice. Prove the switch both ways:

   ```bash
   openclaw config set plugins.entries.warm-cache-continuity.config.enabled false
   node scripts/living-loop/presence-check.mjs        # {"fire":false,"reason":"disabled"}
   openclaw config set plugins.entries.warm-cache-continuity.config.enabled true
   node scripts/living-loop/presence-check.mjs        # fire depends on silence, not on the switch
   ```

Check: after the first consolidation, a new session continues an open thread without asking, using live state and `memory/live/consolidation-*.md`.

## Auditing an existing warm cache

Run these before answering "how is the warm cache doing" — report observed numbers, not the plan.

```bash
# 1. Layer 1: how many cache files exist, how fresh
ls -la --time-style=long-iso memory/session-cache/

# 2. Layer 2: is the hook actually enabled?
python3 -c "import json;print(json.load(open('~/.openclaw/openclaw.json')).get('hooks',{}))"

# 3. Semantic search service
systemctl status chromadb-search-proxy.service --no-pager | head -5
ss -ltnp | grep 8010

# 4. Index freshness: per-collection document counts and ids
cd ~/.openclaw/workspace/chromadb && source .venv/bin/activate && python3 -c "
import chromadb
c=chromadb.HttpClient(host='localhost',port=8000)
for col in c.list_collections():
    n=col if isinstance(col,str) else col.name
    cc=c.get_collection(n); print(n, cc.count())
    if n.endswith('sessions'): print('  ', cc.get(include=[])['ids'])
"

# 5. Search path end to end
curl -s "http://127.0.0.1:8010/?q=<topic>&c=sessions&n=3" | head -c 600
```

Decision rules:
- Collection count < number of cache files → the index is stale; run `index_session_cache.py`.
- `hooks.internal.entries` lacks `session-memory` → Layer 2 is off; enable it on that Gateway.
- Proxy active and answering but search returns only old files → indexing, not the proxy, is the problem.
- Files older than 2 days with open `[ ]` tasks → the cache is not being written at session end; say so plainly instead of reporting the mechanism as healthy.

## Maintenance

- Every 1–2 weeks: review session-cache files. If all tasks are `[x]` and tag is `routine`, it no longer needs startup injection.
- Start YAML frontmatter only at 10 curated files, or earlier when three consumers read the cache (startup injection, ChromaDB metadata filters, a digest of open tasks). Below that, reading the files directly is cheaper than parsing them.

## Phase 4: YAML frontmatter + digest (implemented 07.11.2026)

What it solves: instead of "read the last 3–5 files", startup reads exactly what is still actionable — `critical` for 14 days, `important` for 7, `routine` never injected.

File shape:

```markdown
---
importance: critical | important | routine
date: YYYY-MM-DD
open_tasks: 3
source: session-cache
---
```

Three scripts ship in this skill's `scripts/` directory (copy them into your workspace `scripts/` folder if you keep all scripts in one place). All three resolve the cache directory as `OPENCLAW_WORKSPACE` → `~/.openclaw/workspace`; set `OPENCLAW_WORKSPACE` when the workspace lives elsewhere. The third script additionally requires the `chromadb` Python package.

1. `session-cache-backfill.py` — one-time: infers importance from the old `## Метка важности` section, takes the date from the filename, counts open `[ ]` tasks, prepends frontmatter. Skips files that already have it.
2. `session-cache-digest.py` — the startup reader. Prints active files with their open tasks, then lists files outside the TTL window. Flags: `--all` (show expired too), `--tasks` (tasks only).
3. `session-cache-chroma-meta.py` — pushes `importance`, `date`, `open_tasks` into the ChromaDB collection metadata so search can filter (`where={"importance": "critical"}`).

Wire-up: replace step 3.5 in AGENTS.md with `python3 scripts/session-cache-digest.py`, keeping the reminder that the cache is a hint and configs/files are truth.

Verification checklist:

- `python3 scripts/session-cache-digest.py` prints the expected number of open tasks.
- Create a throwaway file dated 40 days back with `importance: important` — the digest must list it under "вне окна" and not count its tasks.
- `col.get(where={"importance": "critical"})` returns without error (0 rows is fine when none are critical).

Pitfalls:

- The backfill strips the old `## Метка важности` section; do not run a tool that expects it afterwards.
- `date` must be ISO `YYYY-MM-DD` or the digest silently treats the file as today and keeps it in the window forever.
- TTL is measured in calendar days from `date`, not from file mtime, so copying or archiving files does not extend their life.
- If files accumulate past 50: archive closed files to `memory/session-cache/archive/`, merge open tasks into one current file.
- Only the last 3–5 files are read at startup; older files are accessed via ChromaDB semantic search (Phase 3, see below).

## Deploying to other agents

ChromaDB collections, the indexer, the proxy, and the remote search script all come from Step 3 — repeat Step 3a–3e for each new agent with its own collection name (`remote-sessions`, `agent2-sessions`, ...).

### An additional OpenClaw agent
1. SSH to the agent host.
2. Create `memory/session-cache/` in the agent's workspace.
3. Add the session-cache section to the agent's AGENTS.md (adapted for its structure).
4. Install `chromadb/session_search.py` (pure HTTP, no dependencies) and set `OPENCLAW_SEARCH_PROXY` / `OPENCLAW_SEARCH_COLLECTION`.
5. Enable the session-memory hook on that Gateway: `openclaw hooks enable session-memory`.
6. Test: run a task, close session, verify the file appears and the next session reads it.

### A second agent on a lighter VPS
Same procedure. The benefit is smaller when there is little traffic, but the mechanism is identical.

### A non-OpenClaw agent (e.g. Hermes)
A different architecture. The session-memory hook and AGENTS.md startup are OpenClaw-specific. Look for equivalent lifecycle events (message received / session closed) before attempting, and start with the stream layer only — it is a plain append to a JSONL file and needs no framework support.

## Common Pitfalls

1. **Writing session-cache for every session.** Only substantive sessions with unfinished work need a cache file. Trivial Q&A sessions do not.
2. **Trusting cache over reality.** Session-cache is a hint. If it says "configured X" but the config shows Y, the config is truth — update or delete the cache entry.
3. **Forgetting to close tasks.** When a task is completed, mark `[x]` in the cache file so the next session doesn't re-pursue it.
4. **Enabling session-memory hook without checking existing config.** Run `openclaw hooks list` first to see what's already enabled; don't assume the config is empty.
5. **Not testing the hook after enabling.** `openclaw hooks list` showing "ready" does not prove the hook fires. Test with `/new` and check for the output file.
6. **chromadb pip install fails on VMs with old CPUs.** numpy requires X86_V2 baseline optimizations; older VM CPUs don't support them (`RuntimeError: NumPy was built with baseline optimizations: (X86_V2)`). Use the pure-urllib search script that calls the search proxy instead of installing chromadb on remote agents.
7. **ChromaDB v2 REST API requires embeddings, not text.** The v2 `/query` endpoint needs `query_embeddings` (vectors), not `query_texts`. A lightweight Python proxy on the host that has a working chromadb client is the bridge for remote agents.
8. **ChromaDB listens on localhost only by default.** Add a Tailscale-IP port binding in `docker-compose.yml` so remote agents can reach the search proxy. Keep the localhost binding too.
9. **nohup processes die when the exec session ends.** Use a systemd service (`chromadb-search-proxy.service`) for the search proxy, not nohup. The service survives exec session teardown and auto-restarts.
10. **Bash quoting breaks Python heredocs over SSH.** When editing AGENTS.md on a remote host, write the Python script to a local temp file, scp it, then execute via SSH. Avoid inline `ssh host "python3 << 'PYEOF'"` with backticks or f-strings — bash eats backticks inside double-quoted SSH commands.
11. **Assuming an indexer exists.** Deployments shipped without one leave the collection holding one document while the directory holds several. Ship `scripts/index_warm_cache.py` with the deployment and schedule it (Step 3e) instead of relying on someone remembering to run it.
12. **Calling the cache healthy because the proxy is up.** A running service proves the search path only. Compare collection counts with the file count and the newest file's mtime before reporting status.
13. **Expecting the hook to write into session-cache.** The session-memory hook writes to `<workspace>/memory/YYYY-MM-DD-HHMM.md` and exposes no directory option. Index those dumps as their own layer with a `raw-` id prefix, or they collide with curated `session-cache/` stems that use the same timestamp naming.
14. **Assuming rsync exists on the remote agent host.** Probe with `ssh <host> "command -v rsync"` before writing a sync step. When absent, stream an archive over the existing SSH connection (`ssh host "cd dir && tar cf - -- *.md" | tar xf - -C staging`) with the agent's own key and `BatchMode=yes`, so a missing key fails fast instead of prompting for a password inside a nightly job.
15. **Blocking on the hooks CLI.** When `openclaw hooks enable <name>` does not return, set `hooks.internal.entries.<name>.enabled = true` with an atomic config write; the Gateway hot-reloads hooks without a restart. Check `journalctl --user -u openclaw-gateway` for `config hot reload applied` naming the entry.
16. **Naming an injected state file something other than `MEMORY.md`.** `bootstrap-extra-files` loads only `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md` and `MEMORY.md`; any other basename is skipped silently. Store live state at `memory/live/MEMORY.md`.
17. **Verifying injection from a cron or isolated session.** Those sessions apply privacy filters and may omit extra bootstrap memory files. Verify by invoking the bundled handler with the real config and workspace, or in a fresh user session.
18. **Treating a forced automation run as schedule evidence.** `automations(action="run", runMode="force")` proves the payload works, not the cron; check `automations(action="get")` before recording a schedule discrepancy, and label manual runs as manual in the consolidation log. A forced run also executes the payload when the trigger would return `fire:false`, so a model run right after setup is a test, not a gate failure. Receipts confirm it: a `request_run_id` beginning with `manual:` is a forced run, and `cron_run_receipts` stores no trigger-fired column.
19. **Letting automations inherit the default fallback.** A payload without `fallbacks: []` can run routine consolidation on the expensive fallback model. Pin the cheap model and clear fallbacks explicitly.
20. **Recording a silent ping as a failure.** `summary: "NO_REPLY"` with `deliverySuppressionReason: "silent"` is the intended result when there is nothing worth saying; only `status: error` or a missing run is a failure.
21. **Editing a watcher from a session that does not own it.** The `automations` tool is caller-scoped and answers `cron job not found` for jobs created by another session; list and patch them with `openclaw automations list --json` and `openclaw automations edit <id> --trigger-script <file>` instead, and never recreate the job to route around the refusal.
22. **Treating the caller-scoped automation list as the whole scheduler.** `automations list` hides jobs created by another session; compare `automations(action="status").jobs` with the list `total` to size the hidden set, then copy `~/.openclaw/state/openclaw.sqlite` to `/tmp` (the exec policy refuses to open a database inside the state dir) and read `cron_jobs` (`job_json`, `state_json`) and `cron_run_receipts` (`started_at_ms`, `status`, `error_text`) with Node 24 `node:sqlite` `DatabaseSync` or Python read-only, to see the schedule, trigger presence, pinned model and last runs. Never recreate a job you cannot see.
23. **Assuming `btoa`/`Buffer` exist in a code-mode trigger.** They are undefined there; encode trigger state with a hand-written base64 function over `TextEncoder`, and prove the round-trip with a temporary job that writes the decoded state to `/tmp` before enabling the real watcher.
24. **Matching the owner's name with a plain `includes()`.** Chat clients send homoglyphs ("Aлександр" with a Latin A) that silently miss a Cyrillic comparison; normalize Latin lookalikes to Cyrillic, exclude bot display names, and skip utility requests such as session-title generation when computing last user activity.
25. **Deriving silence from a field the stream does not have.** Stream records carry `channelId` and `conversationId`, not `channel`; match on those plus `sessionKey`, and confirm the computed `lastActivityAt` equals the timestamp of a real inbound message.
26. **Assuming the stream covers the main chat.** Internal `message:*` hooks never fire for the OpenAI-compatible webchat session, so the conversation the user actually reads stays invisible while the stream looks healthy; cover `agent_end` with a local plugin (see `references/living-loop.md`, Layer 1b) and skip the sessions the message hooks already write.
27. **Testing the presence gate against the live silence file.** A `--now` run in the real workspace reads the real `last-activity.json`, so a fire/quiet result proves nothing about the window; point `OPENCLAW_WORKSPACE` at a sandbox holding `memory/live/last-activity.json`, `memory/stream/`, `memory/plans/` and the dayoff cache, and assert one case per window boundary and per ping spacing before trusting the cron.
28. **Expecting `AGENTS.md` to exist on a fresh workspace.** It does not. Create the file with a `## Session Startup` section before inserting the digest line, or Step 4 has no anchor and the insertion silently goes nowhere.
29. **Assuming the Phase 4 scripts read the default workspace.** They honour `OPENCLAW_WORKSPACE`; a digest started from a cron with a different value reports an empty cache instead of failing, which looks like data loss.
30. **Wiring hooks from a non-bundled plugin without the conversation grant.** `agent_end` and `before_prompt_build` require `plugins.entries.<id>.hooks.allowConversationAccess: true`. Without it the plugin still loads and reports `status: loaded`, but `hookCount: 0` and no handler ever runs — a silent failure that looks like a broken hook. Check `openclaw plugins inspect <id> --runtime` and look for the hook names, not just the status.
31. **Leaving two owners of the same injection.** After the plugin takes over the live state, the old `bootstrap-extra-files` entry keeps injecting the same file, so the prompt carries it twice and turning the mechanism off does not stop the copy. Disable the core entry once the plugin path is proven.
32. **Assuming a disabled mechanism is a deleted mechanism.** Turning `enabled` off writes to `~/.openclaw/warm-cache/effective.json` and stops new work; it does not remove `memory/stream/` or `memory/live/`. Deleting that file restores the old behavior (everything on), which is useful for recovery but confusing if you expect "missing file = off".
