# Plugin switch — live verification, 2026-11-07

What this file proves: the living-loop mechanism is a switchable feature. Turning it off in
OpenClaw settings stops every active behavior, turning it back on resumes without a restart,
and no data is lost in between.

Host: Linux, OpenClaw 2026.10.7, Gateway running as a user service. All numbers below are
observed output, not expectations.

## 1. The plugin loads and registers its hooks

```text
$ openclaw plugins inspect warm-cache-continuity --runtime
[warm-cache-continuity] registered agent_end + before_prompt_build (enabled=true, max=8000)
[warm-cache-continuity] effective settings written (enabled=true, stream=true, liveState=true, presence=true)
Warm Cache & Living Loop
id: warm-cache-continuity
Status: loaded
Version: 1.3.0
Shape: hook-only

Typed hooks:
agent_end
before_prompt_build

Policy:
allowConversationAccess: true
```

Without `hooks.allowConversationAccess: true` the panel reads `status: loaded` but no hooks —
pitfall 30 in `SKILL.md`.

## 2. Settings are the single source of truth

The plugin writes the resolved config on every (re)start and on every config change:

```json
{
  "version": 1,
  "plugin": "warm-cache-continuity",
  "enabled": true,
  "stream": { "enabled": true, "maxContent": 8000 },
  "liveState": { "enabled": true, "maxBytes": 20000 },
  "presence": {
    "enabled": true,
    "timezone": "Europe/Moscow",
    "silenceHours": 3,
    "minGapHours": 3,
    "weekdayStartHour": 7,
    "weekendStartHour": 10,
    "nightStartHour": 22
  },
  "consolidation": { "enabled": false }
}
```

File: `~/.openclaw/warm-cache/effective.json`. Out-of-process consumers read it:
the internal `stream-logger` hook and `presence-check.mjs`.

## 3. Master switch: gate behavior

Same clock (`--now`), same real silence file, only the switch differs.

```text
# enabled
$ node scripts/living-loop/presence-check.mjs --now 2026-11-07T20:30:00+05:00
{"fire":true,"message":"… silence 4 h 43 min …","state":{…}}

# disabled by config (not by an env override)
$ openclaw config set plugins.entries.warm-cache-continuity.config.enabled false
$ node scripts/living-loop/presence-check.mjs --now 2026-11-07T20:30:00+05:00
{"fire":false,"reason":"disabled","state":{}}
```

`reason: disabled` is returned before the script reads the activity file, the stream or the
holiday API. There is no decision to make and no model call to skip — the watcher exits at the
door.

## 4. Master switch: stream behavior

Hook invoked directly with a synthetic message event, into a throw-away workspace.

| Switch | Result |
|---|---|
| on | `stream dir exists: true`, one JSONL line with `event:"message:received"` |
| off | `stream dir exists: false` — not even the directory was created |

## 5. Live injection on a real turn

After `hooks.internal.entries.bootstrap-extra-files.enabled = false` (the plugin is now the only
owner of layer 2), a real subagent turn produced:

```text
[warm-cache-continuity] live state injected (5770 bytes)
```

The unit harness confirms both directions:

```text
registered: agent_end,before_prompt_build
liveState injected: true          # switch on, file present
stream lines: 2 roles: user,assistant
off prompt: undefined             # switch off
lines after disabled turn: 2 (unchanged: true)
```

## 6. Switching back on

```text
$ openclaw config set plugins.entries.warm-cache-continuity.config.enabled true
Change will apply without restarting the gateway.
$ cat ~/.openclaw/warm-cache/effective.json | jq .enabled
true
$ node scripts/living-loop/presence-check.mjs --now 2026-11-07T20:30:00+05:00
{"fire":true,…}
```

The Gateway log records the replacement, not a restart:

```text
[gateway] Plugin replacement applied: warm-cache-continuity
[warm-cache-continuity] effective settings written (enabled=false, …)
[reload] config hot reload applied (plugins.entries.warm-cache-continuity.config.enabled)
```

## 7. What is not proved here

- The visual Settings form was not opened; only schema validation and `configGroups` metadata
  were checked. The same values were driven through `openclaw config set`.
- Layer 5 has a switch and defaults to off, but no scheduled consolidation job was deployed, so
  its on/off behavior is config-only evidence.
- Matrix delivery of a ping is out of scope: one automation delivers to one channel.

## Reproduce

```bash
# 1. install the plugin and enable conversation hooks
mkdir -p ~/.openclaw/extensions/warm-cache-continuity
cp plugin/warm-cache-continuity/* ~/.openclaw/extensions/warm-cache-continuity/
openclaw config set plugins.entries.warm-cache-continuity.enabled true
openclaw config set plugins.entries.warm-cache-continuity.hooks.allowConversationAccess true
openclaw plugins inspect warm-cache-continuity --runtime | head

# 2. prove the gate both ways
node scripts/living-loop/presence-check.mjs --now 2026-11-07T20:30:00+05:00
openclaw config set plugins.entries.warm-cache-continuity.config.enabled false
node scripts/living-loop/presence-check.mjs --now 2026-11-07T20:30:00+05:00

# 3. restore
openclaw config set plugins.entries.warm-cache-continuity.config.enabled true
```
