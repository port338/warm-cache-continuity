# Changelog

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

## 1.1.0 — 2026-11-07

- Clean-install report (`CLEANRUN-2026-11-07.md`): three defects fixed — Step 4 assumed an
  existing `AGENTS.md`, the Phase 4 scripts disagreed on workspace resolution, the third
  Phase 4 script's `chromadb` requirement was undocumented.
- `SKILL.md` gained the explicit precondition and the dependency note.

## 1.0.0 — 2026-11-07

- Initial publication: warm cache (Phases 1–4), living loop procedure (Phase 5), seven
  Python scripts, MIT license.
