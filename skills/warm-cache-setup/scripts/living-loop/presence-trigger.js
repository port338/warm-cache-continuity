// Condition script for the presence watcher. Runs in the automation's code
// mode, never through a model. The model is only invoked when fire === true.
//
// Install as the job's trigger.script, e.g.
//   openclaw automations edit <id> --trigger-script $OPENCLAW_WORKSPACE/scripts/living-loop/presence-trigger.js

const prev = trigger.state ?? {};

// btoa and Buffer are undefined in code mode — hand-written base64 over UTF-8.
function toB64(str) {
  const abc =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = new TextEncoder().encode(str);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += abc[b0 >> 2];
    out += abc[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : abc[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : abc[b2 & 63];
  }
  return out;
}

let b64 = "";
try {
  b64 = toB64(JSON.stringify(prev));
} catch {
  b64 = "";
}

// Let the shell resolve the workspace so the same script works for any profile.
const res = await exec({
  command:
    'node "${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}/scripts/living-loop/presence-check.mjs"' +
    ` --state-b64=${b64}`,
});

const raw = String(res?.aggregated ?? res?.stdout ?? "").trim();
const lines = raw.split("\n").filter((l) => l.trim().startsWith("{"));

if (!lines.length) {
  // A dead watcher must announce itself once, not stay silently dead.
  const lastError = prev.checkErrorAt ? Date.parse(prev.checkErrorAt) : 0;
  if (!Number.isFinite(lastError) || Date.now() - lastError > 24 * 60 * 60 * 1000) {
    return {
      fire: true,
      message:
        "The presence gate is broken (no JSON returned). Tell the owner in one line that the presence watcher is failing, and include this output fragment: " +
        raw.slice(0, 300),
      state: { ...prev, checkErrorAt: new Date().toISOString() },
    };
  }
  return { fire: false, state: prev };
}

let out;
try {
  out = JSON.parse(lines[lines.length - 1]);
} catch {
  return { fire: false, state: prev };
}

return {
  fire: out.fire === true,
  message: out.message,
  state: out.state ?? prev,
};
