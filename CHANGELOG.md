# Changelog

## 1.3.0 — 2026-11-07

The mechanism becomes a switchable feature instead of a set of scripts wired by hand.

**Added**

- `plugin/warm-cache-continuity/` — an OpenClaw plugin with a JSON-schema config that
  renders in **Settings → Plugins**: a master `enabled` switch plus independent
  `stream`, `liveState`, `presence` and `consolidation` sections. Presence parameters
  (timezone, silence, minimum gap, three window hours) are settings, not constants.
- The plugin owns the two hook layers directly: `agent_end` writes the conversation stream,
  `before_prompt_build` injects `memory/live/MEMORY.md`. The core `bootstrap-extra-files`
  entry is no longer required for the live state, so disabling the mechanism stops the
  injection instead of leaving it running.
- `~/.openclaw/warm-cache/effective.json` — the resolved settings file every out-of-process
  consumer reads (internal `stream-logger` hook, `presence-check.mjs`, cron jobs). Cache root
  is `OPENCLAW_STATE_DIR` or `~/.openclaw`; an absent file keeps the previous behavior (on).
- `presence-check.mjs` reads the settings and returns `{"fire":false,"reason":"disabled"}`
  before touching the filesystem or the holiday API when the mechanism is off.
- `WARM_CACHE_ENABLED=0` environment override for tests and one-off runs.

**Changed**

- `SKILL.md` gains "Step 7: install the plugin and wire the switch" and pitfall 30: a
  non-bundled plugin without `hooks.allowConversationAccess: true` loads with
  `hookCount: 0` and silently does nothing.
- README gains "Turning it on and off": every setting, its default and what "off" means,
  plus the three one-line CLI equivalents.

**Verified (2026-11-07, live Gateway)**

| Check | Result |
|---|---|
| Plugin registration | `agent_end`, `before_prompt_build`; `policy: allowConversationAccess: true` |
| Master switch off → gate | `{"fire":false,"reason":"disabled"}` |
| Master switch on → gate | `{"fire":true,...}` for the same clock and silence |
| Hook write, switch on | one JSONL line written to the test workspace |
| Hook write, switch off | no `memory/stream/` directory created |
| Live injection | gateway log `live state injected (5770 bytes)` on a real turn |
| Live off → on | config change applied without restart; `effective.json` rewritten both times |
| Unit harness | `before_prompt_build` returns context on, `undefined` off; `agent_end` writes on, silent off; assistant text deduplicated by hash |

**Not verified**

- Settings form rendering in the Control UI (schema and `configGroups` validate; the visual
  form was not opened).
- Consolidation scheduling: the switch exists and defaults to off, but no scheduled
  consolidation job was deployed.

## 1.2.0 — 2026-11-07

Phase 5 stops being a specification and becomes runnable code.

**Added**

- `skills/warm-cache-setup/scripts/living-loop/presence-check.mjs` — the presence gate:
  local-time window, silence threshold, ping spacing, Russian holiday calendar with a
  monthly cache, owner matching with homoglyph normalization, and the facts message the
  model receives.
- `skills/warm-cache-setup/scripts/living-loop/presence-trigger.js` — the `trigger.script`
  wrapper for automation code mode: hand-written UTF-8 base64 for state (no `btoa`, no
  `Buffer`), JSON-line parsing, and a once-per-24 h failure announcement.
- `skills/warm-cache-setup/references/PRESENCE-PING.md` — example instruction file for the
  ping turn.
- `skills/warm-cache-setup/references/CONSOLIDATION.md` — example instruction file for the
  consolidation turn.
- Nine-case verification matrix plus trigger round-trip in `CLEANRUN-2026-11-07.md`.

**Changed**

- Every owner-specific value is now an environment variable: `OPENCLAW_WORKSPACE`,
  `PRESENCE_TZ`, `OWNER_NAME`, `OWNER_CHAT_ID`, `OWNER_HANDLES`, `OWNER_MATRIX_HANDLE`,
  `BOT_NAME_RE`, `SILENCE_HOURS`, `MIN_GAP_HOURS`, `WEEKDAY_START_HOUR`,
  `WEEKEND_START_HOUR`, `NIGHT_START_HOUR`, `PRESENCE_HOLIDAY_API`, `PRESENCE_PLAN_DIR`.
  No names, chat ids or absolute paths remain in the code.
- `references/living-loop.md` describes the shipped scripts and their configuration table
  instead of asking the reader to write them.
- README Phase 5 shows a one-command run; the verification checklist gained 10a and 10b.

**Verified**

- 9/9 gate cases: weekday morning, weekday pre-window, 22:00 boundary, weekend pre-window,
  weekend with plan file, short silence, 2 h since last ping, 4 h since last ping, no
  activity file.
- Trigger: state survives base64 and returns (`lastPingDay` preserved, `lastPingAt`
  updated); a broken checker fires exactly once and then stays quiet.
- Default path resolution under a clean `HOME=/tmp/warmclean` with
  `OPENCLAW_WORKSPACE` unset.
- Live delivery on the production host (`LIVE-2026-11-07.md`): a fired ping returned
  `deliveryStatus: delivered`; 42 gate evaluations produced one model call; `NO_REPLY`
  suppressed delivery with reason `silent`; the 22:00 boundary and the 3 h spacing held;
  a one-shot announce probe delivered and auto-deleted itself.

## 1.1.0 — 2026-11-07

- Clean-install report (`CLEANRUN-2026-11-07.md`): three defects fixed — Step 4 assumed an
  existing `AGENTS.md`, the Phase 4 scripts disagreed on workspace resolution, the third
  Phase 4 script's `chromadb` requirement was undocumented.
- `SKILL.md` gained the explicit precondition and the dependency note.

## 1.0.0 — 2026-11-07

- Initial publication: warm cache (Phases 1–4), living loop procedure (Phase 5), seven
  Python scripts, MIT license.
