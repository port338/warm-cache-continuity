# Presence ping — instruction file

The `living-loop-presence-watch` automation appends the gate's facts (local time,
silence duration, working day or rest day, ping kind, plan file path) to its message.
This file tells the model what to do with them. It is deliberately short: the ping is
already a small interruption, and a long report makes it worse.

## What to do

1. Read `memory/plans/<today>.md`. If it is missing, say so in one line and ask what
   today's priority is — one question, not a list.
2. Read `memory/live/MEMORY.md` (usually already injected) and the newest 1–3 files in
   `memory/session-cache/`. That is where unfinished work lives.
3. Answer in this shape:

   **Plan for today**
   - one item per line from the plan file, or "No plan was dictated — what's the priority?"

   **Still open**
   - 1–3 open items with their real state ("chosen, not ordered", "waiting on your decision about X")

   **I can take**
   - one concrete thing the agent can do right now; omit the block if there is nothing

4. Limits: no greeting, no "good morning", at most 12 lines, calm and factual. Do not
   restate the whole plan — only what matters now.
5. A daytime ping (local hour ≥ 12) replaces "Plan for today" with a 2–3 line
   "Where today's plan stands" and goes straight to "Still open".
6. If there is genuinely nothing to say, ask one short question about the day's
   priority. An empty answer is not allowed — the ping already interrupted the person.

## What not to do

- Do not ping more often than the configured gap; the gate already enforces it.
- Do not write during the night window; the gate already enforces it.
- Do not invent plan items that are not in the file.
- Do not turn the ping into a 40-line status report.
- Do not repeat facts the owner just told you in the same session.
