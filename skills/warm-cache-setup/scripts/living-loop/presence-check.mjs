#!/usr/bin/env node
/**
 * presence-check.mjs — тихая проверка «пора ли проявить инициативу».
 *
 * Запускается из condition-триггера автоматизации (без вызова модели).
 * Возвращает одну строку JSON: { fire, message?, state }.
 *
 * Правила (заданы владельцем 07.11.2026):
 *  - Пинг, если владелец молчит > 3 часов.
 *  - Ночные часы (MSK): будни 22:00–07:00, выходные и праздники РФ 22:00–10:00.
 *  - Не чаще одного пинга в 3 часа.
 *  - Каждый утренний пинг начинается с плана на текущий день.
 *
 * Состояние передаётся снаружи (trigger.state) в base64 через --state-b64,
 * чтобы дедупликация не зависела от памяти процесса.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const WS =
  process.env.OPENCLAW_WORKSPACE ||
  path.join(os.homedir(), ".openclaw", "workspace");

const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");

// Значения по умолчанию; реальные берутся из настроек плагина
// warm-cache-continuity (Settings → Plugins). Гейт включён, пока не сказано иначе.
let TZ = "Europe/Moscow";
let SILENCE_MS = 3 * 60 * 60 * 1000;
let MIN_GAP_MS = 3 * 60 * 60 * 1000;
let WEEKDAY_START_HOUR = 7;
let WEEKEND_START_HOUR = 10;
let NIGHT_START_HOUR = 22;

function hours(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

/**
 * Читает настройки гейта. Источник истины — openclaw.json: плагин может быть
 * перезагружен не сразу (замена ждёт текущий ход), и его проекция
 * effective.json в это окно отстаёт. Проекция используется только как запасной
 * путь, если конфиг недоступен или в нём нет записи о плагине.
 */
async function loadSettings() {
  let raw = null;
  try {
    const cfgFile =
      process.env.OPENCLAW_CONFIG_PATH || path.join(STATE_DIR, "openclaw.json");
    const cfg = JSON.parse(await fs.readFile(cfgFile, "utf8"));
    const entry = cfg?.plugins?.entries?.["warm-cache-continuity"];
    if (entry && typeof entry === "object") {
      raw = entry.config && typeof entry.config === "object" ? { ...entry.config } : {};
      if (entry.enabled === false) raw.enabled = false;
    }
  } catch {
    /* config unreadable — fall back to the plugin projection */
  }
  if (!raw || typeof raw !== "object") {
    try {
      raw = JSON.parse(
        await fs.readFile(path.join(STATE_DIR, "warm-cache", "effective.json"), "utf8"),
      );
    } catch {
      raw = {};
    }
  }
  const p = raw.presence && typeof raw.presence === "object" ? raw.presence : {};
  const enabled =
    raw.enabled !== false && p.enabled !== false && process.env.WARM_CACHE_ENABLED !== "0";
  return {
    enabled,
    reason: raw.enabled === false ? "master switch off" : "presence switch off",
    tz: typeof p.timezone === "string" && p.timezone ? p.timezone : "Europe/Moscow",
    silenceMs: hours(p.silenceHours, 3) * 60 * 60 * 1000,
    minGapMs: hours(p.minGapHours, 3) * 60 * 60 * 1000,
    weekdayStartHour: hours(p.weekdayStartHour, 7),
    weekendStartHour: hours(p.weekendStartHour, 10),
    nightStartHour: hours(p.nightStartHour, 22),
  };
}

function arg(name, fallback = null) {
  const inline = process.argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1) || fallback;
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function mskParts(date = new Date()) {
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

async function holidaySet(year, month, parts) {
  const cacheFile = path.join(
    WS,
    "memory",
    "live",
    `dayoff-${year}-${String(month).padStart(2, "0")}.json`,
  );
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    if (typeof cached.data === "string" && cached.data.length >= 28) return cached.data;
  } catch {
    /* no cache yet */
  }
  const url = `https://isdayoff.ru/api/getdata?year=${year}&month=${String(month).padStart(2, "0")}&cc=ru`;
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
    /* offline / API down */
  }
  return null;
}

function fmtDur(ms) {
  const total = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

const BOT_NAME_RE = /атлант|филя|filya|atlant|\bbot\b/;
const UTILITY_RE = /generate a concise title|### task:/i;

/** Приводим латинские омоглифы к кириллице: «Aнна» и «Анна» должны совпасть. */
function normalizeHomoglyphs(value) {
  return String(value || "")
    .toLowerCase()
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

/**
 * Личность владельца не зашита в код: берём из окружения или из
 * memory/live/presence-owner.json в рабочем каталоге. Если не задана, гейт
 * продолжает работать по ролям и каналам, пропуская только сравнение имени.
 */
async function loadOwner() {
  const file = await readJson(
    path.join(WS, "memory", "live", "presence-owner.json"),
    null,
  );
  const name = String(process.env.OWNER_NAME || file?.name || "").trim();
  const chatId = String(process.env.OWNER_CHAT_ID || file?.chatId || "").trim();
  const matrixHandle = String(
    process.env.OWNER_MATRIX_HANDLE || file?.matrixHandle || "",
  ).trim();
  return {
    name,
    chatId,
    matrixHandle,
    first: normalizeHomoglyphs(name.split(/\s+/)[0] || ""),
  };
}

function isOwnerSender(name, owner) {
  const raw = String(name || "").toLowerCase();
  if (!raw) return false;
  if (BOT_NAME_RE.test(raw)) return false;
  const norm = normalizeHomoglyphs(raw);
  if (owner.first && norm.includes(owner.first)) return true;
  if (owner.name && norm.includes(normalizeHomoglyphs(owner.name))) return true;
  return false;
}

/** Последняя активность владельца: максимум из live-файла и потока за 2 дня. */
async function lastActivity(now, owner) {
  const live = await readJson(path.join(WS, "memory", "live", "last-activity.json"));
  let ts = live?.ts ? Date.parse(live.ts) : NaN;
  if (!Number.isFinite(ts)) ts = -Infinity;
  {
    for (const back of [0, 1]) {
      const day = mskParts(new Date(now.getTime() - back * 86400000));
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
          // Служебные запросы (генерация заголовка сессии и т.п.) — не активность.
          if (UTILITY_RE.test(String(r.content || ""))) continue;
          const directDm =
            r.event === "message:received" &&
            ((owner.chatId &&
              r.channelId === "telegram" &&
              String(r.conversationId || r.sessionKey || "").includes(owner.chatId)) ||
              (owner.chatId &&
                r.sessionKey === `agent:main:telegram:direct:${owner.chatId}`) ||
              (r.channelId === "matrix" &&
                !!owner.matrixHandle &&
                String(r.from || "")
                  .toLowerCase()
                  .includes(owner.matrixHandle.toLowerCase())));
          const webInbound =
            r.event === "message:received" &&
            (r.channelId === "webchat" || r.channelId === "openai");
          const isUser =
            r.role === "user" ||
            isOwnerSender(r.senderName, owner) ||
            directDm ||
            webInbound;
          if (!isUser) continue;
          const t = Date.parse(r.ts);
          if (Number.isFinite(t) && t > ts) ts = t;
        } catch {
          /* skip malformed */
        }
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

  const settings = await loadSettings();
  TZ = settings.tz;
  SILENCE_MS = settings.silenceMs;
  MIN_GAP_MS = settings.minGapMs;
  WEEKDAY_START_HOUR = settings.weekdayStartHour;
  WEEKEND_START_HOUR = settings.weekendStartHour;
  NIGHT_START_HOUR = settings.nightStartHour;

  // Выключено в настройках — ни чтения файлов, ни сети, ни решения.
  if (!settings.enabled) {
    return { fire: false, reason: "disabled", state };
  }

  const nowOverride = arg("--now");
  const now = nowOverride ? new Date(nowOverride) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`bad --now: ${nowOverride}`);
  const t = mskParts(now);

  const sat = t.weekday === "Sat";
  const sun = t.weekday === "Sun";
  const dayoff = await holidaySet(t.y, t.m, t);
  const idx = t.d - 1;
  const isHoliday = !!(dayoff && dayoff[idx] === "1");
  const restDay = sat || sun || isHoliday;

  const startHour = restDay ? WEEKEND_START_HOUR : WEEKDAY_START_HOUR;
  const minutes = t.hh * 60 + t.mm;
  const inWindow = minutes >= startHour * 60 && minutes < NIGHT_START_HOUR * 60;

  const owner = await loadOwner();
  const last = await lastActivity(now, owner);
  const silenceMs = last ? now.getTime() - last : null;
  const sinceLastPing = state.lastPingAt
    ? now.getTime() - Date.parse(state.lastPingAt)
    : Infinity;

  const dayFile = path.join(WS, "memory", "plans", `${t.dateStr}.md`);
  let planExists = false;
  try {
    const s = await fs.stat(dayFile);
    planExists = s.size > 0;
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
        msk: `${t.dateStr} ${t.hh}:${String(t.mm).padStart(2, "0")}`,
        weekday: t.weekday,
        restDay,
        isHoliday,
        dayoff: dayoff ? dayoff.slice(0, 12) : null,
        startHour,
        inWindow,
        last: last ? new Date(last).toISOString() : null,
        silenceMin: silenceMs === null ? null : Math.round(silenceMs / 60000),
        sinceLastPingMin: sinceLastPing === Infinity ? null : Math.round(sinceLastPing / 60000),
        stateKeys: Object.keys(state),
      }),
    );
  }

  if (!inWindow) return { fire: false, state };
  if (silenceMs === null || silenceMs < SILENCE_MS) return { fire: false, state };
  if (sinceLastPing < MIN_GAP_MS) return { fire: false, state };

  const kind = t.hh < 12 ? "утренний" : "дневной";
  const msg = [
    `Факты проверки: сейчас ${t.dateStr} ${String(t.hh).padStart(2, "0")}:${String(t.mm).padStart(2, "0")} MSK,`,
    restDay ? "нерабочий день (выходной/праздник РФ)." : "рабочий день.",
    `${owner.name || "the owner"} молчит ${fmtDur(silenceMs)} (с ${new Date(last).toISOString()}).`,
    `Тип пинга: ${kind}.`,
    `Файл плана на сегодня: ${dayFile} — ${planExists ? "существует" : "отсутствует"}.`,
  ].join(" ");

  return {
    fire: true,
    message: msg,
    state: { ...state, lastPingAt: now.toISOString(), lastPingDay: t.dateStr, ...base },
  };
}

const out = await main();
process.stdout.write(JSON.stringify(out) + "\n");
