# Consolidation — instruction file

Run by the `living-loop-consolidate` automation every few days: isolated session, cheap
model, `delivery.mode: none`. The job is to turn the raw stream into updated memory.
It is file work, not a report — nothing is sent to chat.

## Window

1. Read `memory/live/last-consolidation.txt` for the previous run date. If it is
   missing, use the last 3 days.
2. Process only `memory/stream/*.jsonl` inside that window. If there are none, finish
   without changes and log "no stream in window".

## What to read

- `memory/stream/<dates>.jsonl` — the whole window; this is evidence, not summary;
- `memory/YYYY-MM-DD.md` for the same days — diary notes;
- `memory/live/MEMORY.md` — current live state;
- `MEMORY.md` — long-term memory (this is the agent's own working session, so it is allowed);
- `memory/people/<owner>.md` — the people model;
- the newest 3 files in `memory/session-cache/`.

Do not read anything older than the window, and do not read files larger than 2 MB.

## What to extract

1. **Decisions** — what was decided, when, and why. Verifiable facts only.
2. **Unfinished work** — checkbox items and exactly where they stopped.
3. **Changes in the owner** — new style, mood, repeated requests. Only with at least two
   observations in the stream. One observation is not a conclusion.
4. **Contradictions** — where the cache or memory disagrees with the stream. This matters
   most: it is how summarization errors get caught.

## What to write

- `MEMORY.md` — append surgically, never rewrite wholesale. New facts go into the right
  section with a date. Do not delete old material without a reason.
- `memory/people/<owner>.md` — only observations with confirmation.
- `memory/live/MEMORY.md` — the state as of this run.
- `memory/live/consolidation-YYYY-MM-DD.md` — a 5–10 line digest: what changed, what is
  still open, what is uncertain.
- `memory/live/last-consolidation.txt` — ISO date and time of the run.
- Mark confirmed finished session-cache items `[x]`. Never delete session-cache files.

## Prohibitions

- Do not invent facts. If the stream does not contain it, write "not confirmed".
- Do not delete or rewrite `memory/stream/*.jsonl`.
- Do not send chat messages (`delivery.mode: none`).
- Do not touch configs, services, ports or secrets.
- Do not exceed 30 tool calls. If you run out, stop and record what remains in
  `memory/live/consolidation-YYYY-MM-DD.md`.

## Success criterion

The next session, reading `memory/live/MEMORY.md` and the latest consolidation, continues
the work without asking again. If it would have to open the stream to know what is going
on, the consolidation is incomplete.
