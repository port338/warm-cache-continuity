/**
 * warm-cache-continuity — one plugin that owns the living-continuity mechanism.
 *
 * Layers:
 *   1. stream     — append-only JSONL journal (no model call)
 *   2. liveState  — memory/live/MEMORY.md injected into the prompt
 *   4. presence   — settings exported for the silence-gated watcher
 *   5. consolidation — settings exported for the scheduled pass
 *
 * The plugin is the single source of truth for on/off. It writes the resolved
 * settings to <state>/warm-cache/effective.json so that out-of-process
 * consumers (the internal stream-logger hook, presence-check.mjs, cron jobs)
 * honour the same switch without importing plugin code.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_ID = "warm-cache-continuity";
const DEFAULT_MAX_CONTENT = 8000;
const DEFAULT_MAX_BYTES = 20000;

const DEFAULTS = {
  enabled: true,
  stream: { enabled: true, maxContent: DEFAULT_MAX_CONTENT },
  liveState: { enabled: true, maxBytes: DEFAULT_MAX_BYTES },
  presence: {
    enabled: true,
    timezone: "Europe/Moscow",
    silenceHours: 3,
    minGapHours: 3,
    weekdayStartHour: 7,
    weekendStartHour: 10,
    nightStartHour: 22,
  },
  consolidation: { enabled: false },
};

const lastHashes = new Map();

// Транспорты, которые сами эмитят message-хуки, не дублируем из agent_end.
const DEFAULT_SKIP = [
  ":matrix:",
  ":telegram:",
  ":whatsapp:",
  ":discord:",
  ":slack:",
  ":signal:",
  ":imessage:",
  ":sms:",
  ":subagent:",
  ":cron:",
  ":automation:",
  ":heartbeat:",
];

function workspaceDir() {
  return (
    process.env.OPENCLAW_WORKSPACE ||
    path.join(os.homedir(), ".openclaw", "workspace")
  );
}

function stateDir() {
  return process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
}

function effectivePath() {
  return path.join(stateDir(), "warm-cache", "effective.json");
}

function dayStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (part && typeof part === "object" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
    return parts.join("\n").trim();
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

function clip(value, max) {
  if (typeof value !== "string" || !value) return undefined;
  return value.length > max ? value.slice(0, max) + "…[truncated]" : value;
}

function channelOf(sessionKey) {
  if (!sessionKey) return null;
  const m = /^agent:[^:]+:([^:]+):/.exec(sessionKey);
  return m ? m[1] : null;
}

function resolveConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const out = {
    enabled: cfg.enabled !== false,
    stream: { ...DEFAULTS.stream, ...(cfg.stream || {}) },
    liveState: { ...DEFAULTS.liveState, ...(cfg.liveState || {}) },
    presence: { ...DEFAULTS.presence, ...(cfg.presence || {}) },
    consolidation: { ...DEFAULTS.consolidation, ...(cfg.consolidation || {}) },
  };
  out.stream.enabled = out.stream.enabled !== false;
  out.liveState.enabled = out.liveState.enabled !== false;
  out.presence.enabled = out.presence.enabled !== false;
  out.consolidation.enabled = out.consolidation.enabled === true;
  if (process.env.WARM_CACHE_ENABLED === "0") out.enabled = false;
  return out;
}

async function writeEffective(cfg) {
  const file = effectivePath();
  const payload = {
    version: 1,
    plugin: PLUGIN_ID,
    updatedAt: new Date().toISOString(),
    ...cfg,
  };
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn("[warm-cache-continuity] could not write effective settings:", String(err));
  }
}

async function appendStream(record) {
  const dir = path.join(workspaceDir(), "memory", "stream");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${dayStamp()}.jsonl`);
  await fs.appendFile(file, JSON.stringify(record) + "\n", "utf8");
}

async function touchActivity(text, sessionKey) {
  try {
    const dir = path.join(workspaceDir(), "memory", "live");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "last-activity.json"),
      JSON.stringify(
        {
          ts: new Date().toISOString(),
          role: "user",
          sessionKey: sessionKey || null,
          source: "agent_end",
          preview: clip(text, 200) || null,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  } catch {
    /* activity tracking is best-effort */
  }
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Warm Cache & Living Loop",
  description:
    "Conversation stream, warm working state, and silence-gated initiative behind one switch.",
  register(api) {
    const cfg = resolveConfig(api.pluginConfig);
    let injectedOnce = false;

    void writeEffective(cfg).then(() => {
      console.log(
        `[warm-cache-continuity] effective settings written (enabled=${cfg.enabled}, ` +
          `stream=${cfg.stream.enabled}, liveState=${cfg.liveState.enabled}, presence=${cfg.presence.enabled})`,
      );
    });

    // Layer 1 — append what was actually said. Covers transports whose turns do
    // not emit message hooks (webchat / OpenAI-compatible).
    api.on(
      "agent_end",
      async (event, ctx) => {
        try {
          if (!cfg.enabled || !cfg.stream.enabled) return;

          const sessionKey = ctx?.sessionKey || null;
          if (sessionKey && DEFAULT_SKIP.some((marker) => sessionKey.includes(marker))) {
            return;
          }
          const messages = Array.isArray(event?.messages) ? event.messages : [];
          if (!messages.length) return;

          let lastUser = -1;
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            const m = messages[i];
            if (m && typeof m === "object" && m.role === "user") {
              lastUser = i;
              break;
            }
          }
          if (lastUser < 0) return;

          const userText = textOf(messages[lastUser]?.content);
          if (!userText || userText.trim().startsWith("### Task:")) return;

          const assistantParts = [];
          for (let i = lastUser + 1; i < messages.length; i += 1) {
            const m = messages[i];
            if (m && typeof m === "object" && m.role === "assistant") {
              const t = textOf(m.content);
              if (t) assistantParts.push(t);
            }
          }
          const assistantText = assistantParts.join("\n\n").trim();

          const base = {
            ts: new Date().toISOString(),
            event: "agent:end",
            source: "agent_end",
            sessionKey,
            agentId: ctx?.agentId || null,
            channel: channelOf(sessionKey),
            runId: event?.runId ?? ctx?.runId ?? null,
            success: event?.success ?? null,
            durationMs: event?.durationMs ?? null,
          };

          const hash = crypto
            .createHash("sha1")
            .update(`${sessionKey}|user|${userText}`)
            .digest("hex");
          if (lastHashes.get(`${sessionKey}|user`) !== hash) {
            lastHashes.set(`${sessionKey}|user`, hash);
            await appendStream({
              ...base,
              role: "user",
              content: clip(userText, cfg.stream.maxContent),
            });
            await touchActivity(userText, sessionKey);
          }

          if (assistantText) {
            const ahash = crypto
              .createHash("sha1")
              .update(`${sessionKey}|assistant|${assistantText}`)
              .digest("hex");
            if (lastHashes.get(`${sessionKey}|assistant`) !== ahash) {
              lastHashes.set(`${sessionKey}|assistant`, ahash);
              await appendStream({
                ...base,
                role: "assistant",
                content: clip(assistantText, cfg.stream.maxContent),
              });
            }
          }

          if (lastHashes.size > 500) {
            const keep = [...lastHashes.entries()].slice(-200);
            lastHashes.clear();
            for (const [k, v] of keep) lastHashes.set(k, v);
          }
        } catch (err) {
          console.warn("[warm-cache-continuity] stream write failed:", String(err));
        }
      },
      { timeoutMs: 10000 },
    );

    // Layer 2 — warm working state. The file is a hint, not a source of truth.
    api.on(
      "before_prompt_build",
      async () => {
        try {
          if (!cfg.enabled || !cfg.liveState.enabled) return;
          const file = path.join(workspaceDir(), "memory", "live", "MEMORY.md");
          const raw = await fs.readFile(file, "utf8");
          const text = String(raw).trim();
          if (!text) return;
          const max = cfg.liveState.maxBytes;
          const body =
            Buffer.byteLength(text, "utf8") > max
              ? text.slice(-Math.floor(max / 2))
              : text;
          if (!injectedOnce) {
            injectedOnce = true;
            console.log(
              `[warm-cache-continuity] live state injected (${Buffer.byteLength(body, "utf8")} bytes)`,
            );
          }
          return {
            prependContext: `<living_state>\n${body}\n</living_state>`,
          };
        } catch {
          return;
        }
      },
      { timeoutMs: 5000 },
    );

    console.log(
      `[warm-cache-continuity] registered agent_end + before_prompt_build ` +
        `(enabled=${cfg.enabled}, max=${cfg.stream.maxContent})`,
    );
  },
});
