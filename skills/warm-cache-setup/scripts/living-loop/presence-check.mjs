#!/usr/bin/env node
/**
 * presence-check.mjs — headless "should the agent speak first?" gate.
 *
 * Called by the `trigger.script` of an automation, with no model invocation.
 * Prints exactly one JSON line: { fire, message?, state }.
 *
 * Rules (defaults are one reasonable policy, not a law):
 *   - fire only after the owner has been silent for > SILENCE_HOURS;
 *   - never inside the night window: weekdays NIGHT_START..WEEKDAY_START,
 *     rest days NIGHT_START..WEEKEND_START (rest day = Sat, Sun, or a holiday);
 *   - never more than once per MIN_GAP_HOURS;
 *   - report the facts the model needs, so the ping is grounded, not guessed.
 *
 * State is passed in from the automation (`trigger.state`) as base64 via
 * --state-b64: deduplication must survive restarts, and a condition script has
 * no durable process memory.
 *
 * Environment (all optional):
 *   OPENCLAW_WORKSPACE     workspace root            default ~/.openclaw/workspace
 *   PRESENCE_TZ            time zone                 default Europe/Moscow
 *   OWNER_NAME             how the owner is called   default "the owner"
 *   OWNER_HANDLES          extra sender aliases, comma-separated
 *   OWNER_CHAT_ID          Telegram chat id of the owner's DM
 *   OWNER_MATRIX_HANDLE    Matrix localpart, e.g. "alex"
 *   BOT_NAME_RE            JS regex of sender names to ignore, default "\b(bot|assistant)\b"
 *   SILENCE_HOURS          default 3
 *   MIN_GAP_HOURS          default 3
 *   WEEKDAY_START_HOUR     default 7
 *   WEEKEND_START_HOUR     default 10
 *   NIGHT_START_HOUR       default 22
 *   PRESENCE_HOLIDAY_API   default https://isdayoff.ru/api/getdata ; set "off" to use weekends only
 *   PRESENCE_PLAN_DIR      default <workspace>/memory/plans
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const WS =
  process.env.OPENCLAW_WORKSPACE ||
  path.join(os.homedir(), ".openclaw", "workspace");

const TZ = process.env.PRESENCE_TZ || "Europe/Moscow";
const SILENCE_MS = hoursFromEnv("SILENCE_HOURS", 3);
const MIN_GAP_MS = hoursFromEnv("MIN_GAP_HOURS", 3);
const WEEKDAY_START_HOUR = intFromEnv("WEEKDAY_START_HOUR", 7);
const WEEKEND_START_HOUR = intFromEnv("WEEKEND_START_HOUR", 10);
const NIGHT_START_HOUR = intFromEnv("NIGHT_START_HOUR", 22);

const OWNER_NAME = process.env.OWNER_NAME || "the owner";
const OWNER_CHAT_ID = String(process.env.OWNER_CHAT_ID || "").trim();
const OWNER_MATRIX_HANDLE = String(process.env.OWNER_MATRIX_HANDLE || "")
  .trim()
  .toLowerCase();
const PLAN_DIR = process.env.PRESENCE_PLAN_DIR || path.join(WS, "memory", "plans");
const HOLIDAY_API =
  process.env.PRESENCE_HOLIDAY_API === "off"
    ? ""
    : process.env.PRESENCE_HOLIDAY_API ||
      "https://isdayoff.ru/api/getdata?year={year}&month={month}&cc=ru";

const BOT_NAME_RE = process.env.BOT_NAME_RE
  ? new RegExp(process.env.BOT_NAME_RE, "i")
  : /\b(bot|assistant)\b/i;

function hoursFromEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n * 60 * 60 * 1000 : fallback * 60 * 60 * 1000;
}

function intFromEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
}

function arg(name, fallback = null) {
  const inline = process.argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1) || fallback;
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function tzParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    hh: Number(p.hour) % 24,
    mm: Number(p.minute),
    weekday: p.weekday, // Mon..Sun
    dateStr: `${p.year}-${p.month}-${p.day}`,
  };
}

/**
 * Russian public-holiday calendar, cached per month.
 *
 * `1` in the returned string means "rest day" and covers weekends as well as
 * holidays. Treating only explicit holidays as rest days silently moves the
 * weekend wake-up boundary back to the weekday one.
 */
async function holidaySet(year, month) {
  if (!HOLIDAY_API) return null;
  const mm = String(month).padStart(2, "0");
  const cacheFile = path.join(WS, "memory", "live", `dayoff-${year}-${mm}.json`);
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    if (typeof cached.data === "string" && cached.data.length >= 28) return cached.data;
  } catch {
    /* no cache yet */
  }
  const url = HOLIDAY_API.replace("{year}", String(year)).replace("{month}", mm);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = (await res.text()).trim();
    if (/^[01]+$/.test(data) && data.length >= 28) {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(
        cacheFile,
        JSON.stringify({ year, month, data, fetchedAt: new Date().toISOString() }) + "\n",
        "utf8",
      );
      return data;
    }
  } catch {
    /* offline / API down: fall back to weekends only */
  }
  return null;
}

function fmtDur(ms) {
  const total = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Chat clients mix alphabets: the first letter of a Cyrillic name can arrive
 * as a Latin lookalike ("Aнна" vs "Анна"). Plain string comparison misses it
 * forever. Normalize Latin homoglyphs to Cyrillic before matching.
 */
function normalizeHomoglyphs(s) {
  return s
    .replace(/a/g, "а")
    .replace(/e/g, "е")
    .replace(/o/g, "о")
    .replace(/p/g, "р")
    .replace(/c/g, "с")
    .replace(/x/g, "х")
    .replace(/y/g, "у")
    .replace(/k/g, "к")
    .replace(/m/g, "м")
    .replace(/t/g, "т")
    .replace(/h/g, "н");
}

function ownerAliases() {
  const raw = [OWNER_NAME, ...(process.env.OWNER_HANDLES || "").split(",")]
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 3 && s !== "the owner");
  return raw.flatMap((s) => [s, normalizeHomoglyphs(s)]);
}

const OWNER_ALIASES = ownerAliases();

function isOwnerSender(name) {
  const raw = String(name || "").toLowerCase();
  if (!raw) return false;
  if (BOT_NAME_RE.test(raw)) return false;
  const norm = normalizeHomoglyphs(raw);
  const hay = [raw, norm];
  return OWNER_ALIASES.some((alias) =>
    hay.some((h) => h.includes(alias) || norm.includes(normalizeHomoglyphs(alias))),
  );
}

const UTILITY_RE = /generate a concise title|### task:/i;

/** Last inbound owner message: max over the live file and the stream (2 days). */
async function lastActivity(now) {
  const live = await readJson(path.join(WS, "memory", "live", "last-activity.json"));
  let ts = live?.ts ? Date.parse(live.ts) : NaN;
  if (!Number.isFinite(ts)) ts = -Infinity;

  for (const back of [0, 1]) {
    const day = tzParts(new Date(now.getTime() - back * 86400000));
    const file = path.join(WS, "memory", "stream", `${day.dateStr}.jsonl`);
    let text = "";
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        const inbound = r.event === "message:received" || r.role === "user";
        if (!inbound) continue;
        // Housekeeping requests (session-title generation and friends) are not activity.
        if (UTILITY_RE.test(String(r.content || ""))) continue;

        const conv = String(r.conversationId || r.sessionKey || "");
        const directDm =
          r.event === "message:received" &&
          ((OWNER_CHAT_ID && conv.includes(OWNER_CHAT_ID)) ||
            (OWNER_MATRIX_HANDLE &&
              r.channelId === "matrix" &&
              String(r.from || "").toLowerCase().includes(OWNER_MATRIX_HANDLE)));
        const webInbound =
          r.event === "message:received" &&
          (r.channelId === "webchat" || r.channelId === "openai");

        const isUser =
          r.role === "user" || isOwnerSender(r.senderName) || directDm || webInbound;
        if (!isUser) continue;

        const t = Date.parse(r.ts);
        if (Number.isFinite(t) && t > ts) ts = t;
      } catch {
        /* skip malformed line */
      }
    }
  }
  return Number.isFinite(ts) ? ts : null;
}

async function main() {
  let state = {};
  const b64 = arg("--state-b64");
  if (b64) {
    try {
      state = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) || {};
    } catch {
      state = {};
    }
  }

  const nowOverride = arg("--now");
  const now = nowOverride ? new Date(nowOverride) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`bad --now: ${nowOverride}`);
  const t = tzParts(now);

  const sat = t.weekday === "Sat";
  const sun = t.weekday === "Sun";
  const dayoff = await holidaySet(t.y, t.m);
  const isHoliday = !!(dayoff && dayoff[t.d - 1] === "1");
  const restDay = sat || sun || isHoliday;

  const startHour = restDay ? WEEKEND_START_HOUR : WEEKDAY_START_HOUR;
  const minutes = t.hh * 60 + t.mm;
  const inWindow = minutes >= startHour * 60 && minutes < NIGHT_START_HOUR * 60;

  const last = await lastActivity(now);
  const silenceMs = last ? now.getTime() - last : null;
  const sinceLastPing = state.lastPingAt
    ? now.getTime() - Date.parse(state.lastPingAt)
    : Infinity;

  const dayFile = path.join(PLAN_DIR, `${t.dateStr}.md`);
  let planExists = false;
  try {
    planExists = (await fs.stat(dayFile)).size > 0;
  } catch {
    planExists = false;
  }

  const base = {
    lastActivityAt: last ? new Date(last).toISOString() : null,
    silenceMin: silenceMs === null ? null : Math.round(silenceMs / 60000),
    inWindow,
    restDay,
    isHoliday,
    planFile: dayFile,
    planExists,
  };

  if (process.env.DEBUG_PRESENCE) {
    console.error(
      JSON.stringify({
        tz: TZ,
        local: `${t.dateStr} ${t.hh}:${String(t.mm).padStart(2, "0")}`,
        weekday: t.weekday,
        restDay,
        isHoliday,
        startHour,
        inWindow,
        last: last ? new Date(last).toISOString() : null,
        silenceMin: silenceMs === null ? null : Math.round(silenceMs / 60000),
        sinceLastPingMin: sinceLastPing === Infinity ? null : Math.round(sinceLastPing / 60000),
      }),
    );
  }

  if (!inWindow) return { fire: false, state };
  if (silenceMs === null || silenceMs < SILENCE_MS) return { fire: false, state };
  if (sinceLastPing < MIN_GAP_MS) return { fire: false, state };

  const kind = t.hh < 12 ? "morning" : "daytime";
  const msg = [
    `Gate facts: now ${t.dateStr} ${String(t.hh).padStart(2, "0")}:${String(t.mm).padStart(2, "0")} ${TZ},`,
    restDay ? "rest day (weekend or public holiday)." : "working day.",
    `${OWNER_NAME} has been silent for ${fmtDur(silenceMs)} (last inbound ${new Date(last).toISOString()}).`,
    `Ping kind: ${kind}.`,
    `Plan file for today: ${dayFile} — ${planExists ? "exists" : "absent"}.`,
  ].join(" ");

  return {
    fire: true,
    message: msg,
    state: { ...state, lastPingAt: now.toISOString(), lastPingDay: t.dateStr, ...base },
  };
}

const out = await main();
process.stdout.write(JSON.stringify(out) + "\n");
