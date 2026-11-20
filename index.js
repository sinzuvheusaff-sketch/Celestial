"use strict";

/*
 * ECLIPSE BANAT — no-key build
 * ----------------------------
 * Boots once, stays up. No license, no proxy, no auto-retry-exit loops.
 * Dashboard at "/" has no key gate; controls are live immediately.
 *
 * IMPORTANT: no key means anyone with the URL can control the bot.
 * Keep the URL private.
 *
 * Commands in Messenger:
 *   !banat on | off | toggle | status | help
 *   GC: !banat lockname [name] | unlockname | nickall <nick> |
 *       nickall! <nick> | nickclear | nick @user <nick> |
 *       nicklock | nickunlock | gc
 */

const fs = require("fs");
const path = require("path");
const { login } = require("ws3-fca");
const { getTriggerReply, getBanatConversationReply } = require("./triggers");
const { sendBanatReplyWithTyping } = require("./banat-human");
const { classifyBanatTarget, setBanatConversationMode, isBanatConversationModeActive } = require("./banat-targeting");
const gc = require("./gc-controls");

const PORT = Number(process.env.PORT || 10000);
const DEFAULT_ON = /^(1|true|yes|on)$/i.test(process.env.BANAT_DEFAULT_ON || "false");
const GLOBAL_SEND_LIMIT = Math.max(1, Number(process.env.BANAT_GLOBAL_SEND_LIMIT || 2));
const THREAD_COOLDOWN_MS = Math.max(0, Number(process.env.BANAT_THREAD_COOLDOWN_MS ?? 2500));
const RETRY_DELAYS = [1500, 4000, 8000];
const SESSION_FILE = path.join(process.cwd(), "appstate.json");

const activeThreads = new Set();
const threadQueues = new Map();
const threadLastSent = new Map();
const threadCooldown = new Map();
const groupSettings = new Map();
const activityEvents = [];

let globalActive = 0;
let botUserID = "";
let messengerApi = null;
let botPaused = false;
let messengerConnected = false;
let loginError = null;
let lastConnectedAt = null;
let lastDisconnectedAt = null;
let lastListenerError = null;
let lastMessageAt = null;
let loginInProgress = false;
let loginGeneration = 0;
let activeListenerGeneration = 0;
let dashboardServer = null;

// Never die.
process.on("uncaughtException", (e) => console.error("[UNCAUGHT]", e));
process.on("unhandledRejection", (e) => console.error("[UNHANDLED]", e));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pushEvent(type, message) {
  activityEvents.unshift({ type, message, at: new Date().toISOString() });
  if (activityEvents.length > 100) activityEvents.length = 100;
}

function getGroupSettings(threadID) {
  const key = String(threadID);
  if (!groupSettings.has(key)) {
    groupSettings.set(key, { banatMode: "inherit", typingEnabled: true, replyDelayMs: null, cooldownMs: null });
  }
  return groupSettings.get(key);
}

function updateGroupSettings(threadID, input) {
  const current = getGroupSettings(threadID);
  const next = { ...current };
  if (input.banatMode === "on" || input.banatMode === "off" || input.banatMode === "inherit") next.banatMode = input.banatMode;
  if (typeof input.typingEnabled === "boolean") next.typingEnabled = input.typingEnabled;
  if (input.replyDelayMs === null || Number.isFinite(Number(input.replyDelayMs))) next.replyDelayMs = input.replyDelayMs === null ? null : Number(input.replyDelayMs);
  if (input.cooldownMs === null || Number.isFinite(Number(input.cooldownMs))) next.cooldownMs = input.cooldownMs === null ? null : Number(input.cooldownMs);
  groupSettings.set(String(threadID), next);
  return next;
}

function readSession() {
  const raw = process.env.FB_COOKIES || process.env.FB_APPSTATE;
  if (raw) {
    const trimmed = String(raw).trim();
    try { return JSON.parse(trimmed); } catch (_) { return trimmed; }
  }
  if (fs.existsSync(SESSION_FILE)) return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
  const cookies = path.join(process.cwd(), "cookies.json");
  if (fs.existsSync(cookies)) return JSON.parse(fs.readFileSync(cookies, "utf8"));
  throw new Error("No Facebook session. Paste a cookie on the dashboard.");
}

function normalizeSession(value) {
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) throw new Error("Empty session");
    return s;
  }
  const entries = Array.isArray(value) ? value
    : Array.isArray(value?.appState) ? value.appState
    : Array.isArray(value?.cookies) ? value.cookies
    : null;
  if (!entries) throw new Error("Session must be cookie string or cookie array");
  const parts = entries.map(c => {
    const key = c?.key ?? c?.name, val = c?.value;
    return key != null && val != null ? `${String(key).trim()}=${String(val)}` : null;
  }).filter(Boolean);
  if (!parts.length) throw new Error("Session contains no cookie entries");
  return parts.join("; ");
}

function enqueue(threadID, job) {
  const key = String(threadID);
  const current = threadQueues.get(key) || Promise.resolve();
  const next = current.catch(() => {}).then(job).finally(() => {
    if (threadQueues.get(key) === next) threadQueues.delete(key);
  });
  threadQueues.set(key, next);
  return next;
}

async function acquireGlobalSlot() {
  while (globalActive >= GLOBAL_SEND_LIMIT) await sleep(150);
  globalActive++;
}
function releaseGlobalSlot() { globalActive = Math.max(0, globalActive - 1); }

function is1545012(error) {
  return /1545012|temporarily unavailable|message could not be sent/i.test(JSON.stringify(error || ""));
}

function trafficSendMessage(api, message, threadID, callback, replyToMessageID = null) {
  const key = String(threadID);
  return enqueue(key, async () => {
    const now = Date.now();
    const cooldownUntil = Number(threadCooldown.get(key) || 0);
    if (cooldownUntil > now) {
      await sleep(cooldownUntil - now);
      if (Number(threadCooldown.get(key) || 0) <= Date.now()) threadCooldown.delete(key);
    }
    const settings = getGroupSettings(key);
    const cooldown = settings.cooldownMs == null ? THREAD_COOLDOWN_MS : Math.max(0, Number(settings.cooldownMs));
    const sinceLast = now - Number(threadLastSent.get(key) || 0);
    if (sinceLast < cooldown) await sleep(cooldown - sinceLast);

    await acquireGlobalSlot();
    try {
      let lastErr = null;
      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        try {
          const result = await new Promise((resolve, reject) => {
            let settled = false;
            const done = (err, info) => { if (settled) return; settled = true; err ? reject(err) : resolve(info); };
            try {
              const r = replyToMessageID
                ? api.sendMessage(message, threadID, done, replyToMessageID)
                : api.sendMessage(message, threadID, done);
              if (r && typeof r.then === "function") r.then(info => done(null, info)).catch(done);
            } catch (e) { reject(e); }
          });
          threadLastSent.set(key, Date.now());
          callback(null, result);
          return;
        } catch (error) {
          lastErr = error;
          if (!is1545012(error) || attempt >= RETRY_DELAYS.length) break;
          threadCooldown.set(key, Date.now() + Math.min(15000, RETRY_DELAYS[attempt]));
          await sleep(RETRY_DELAYS[attempt]);
          threadCooldown.delete(key);
        }
      }
      callback(lastErr);
    } finally { releaseGlobalSlot(); }
  });
}

function isBanatCommand(body) { return /^!banat(?:\s|$)/i.test(String(body || "").trim()); }

function commandSendMessage(api, message, threadID, replyToMessageID = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, info) => { if (settled) return; settled = true; err ? reject(err) : resolve(info); };
    try {
      const r = replyToMessageID
        ? api.sendMessage(message, threadID, done, replyToMessageID)
        : api.sendMessage(message, threadID, done);
      if (r && typeof r.then === "function") r.then(info => done(null, info)).catch(done);
    } catch (e) { done(e); }
  });
}

function sendCommandReply(api, event, message) {
  commandSendMessage(api, message, String(event.threadID), event.messageID || null)
    .then(() => pushEvent("command", message))
    .catch(e => console.error("[CMD] reply failed:", e?.message || e));
}

const GC_SUBS = new Set(["lockname","unlockname","nickall","nickall!","nickclear","nick","nicklock","nickunlock","gc"]);
const ADMIN_IDS = String(process.env.BANAT_ADMIN_IDS || "").split(/[,\s]+/).filter(Boolean);
function isBotAdmin(senderID) {
  if (!ADMIN_IDS.length) return true;
  if (ADMIN_IDS.includes("*") || ADMIN_IDS.includes(String(senderID || ""))) return true;
  return false;
}

async function isGcAdmin(api, event) {
  const id = String(event.senderID || "");
  if (ADMIN_IDS.includes("*") || ADMIN_IDS.includes(id)) return true;
  try { return (await gc.getAdminIDs(api, event.threadID)).includes(id); }
  catch (_) { return false; }
}

async function runGcCommand(api, event, sub, body) {
  if (event.isGroup === false) return sendCommandReply(api, event, "sa GC lang to 😭");
  if (!(await isGcAdmin(api, event))) return sendCommandReply(api, event, "GC admin lang pwede nito 😭");
  const threadID = String(event.threadID);
  const rest = String(body).trim().replace(/^!banat\s+\S+\s*/i, "").trim();

  if (sub === "lockname") {
    const r = await gc.lockName(api, threadID, rest);
    return sendCommandReply(api, event, r.applied ? `GC name locked: ${r.name} 🔒` : `locked "${r.name}" pero di ko mapalitan ngayon: ${String(r.error).slice(0, 80)}`);
  }
  if (sub === "unlockname") { gc.unlockName(threadID); return sendCommandReply(api, event, "GC name unlocked 🔓"); }
  if (sub === "nickall" || sub === "nickall!") {
    if (!rest) return sendCommandReply(api, event, "usage: !banat nickall <nickname>  (or nickall! para naka-lock)");
    sendCommandReply(api, event, "sige, nilalagay ko na. matagal 'to, wait lang 😭");
    const r = await gc.setAllNicknames(api, threadID, rest, { lock: sub === "nickall!" });
    return sendCommandReply(api, event, `done ${r.ok}/${r.total} nickname${r.locked ? " (locked 🔒)" : ""}${r.failed ? `, ${r.failed} failed` : ""}`);
  }
  if (sub === "nickclear") {
    sendCommandReply(api, event, "binubura ko na lahat ng nickname...");
    const r = await gc.setAllNicknames(api, threadID, "", {});
    return sendCommandReply(api, event, `cleared ${r.ok}/${r.total}`);
  }
  if (sub === "nick") {
    const mentions = event.mentions && typeof event.mentions === "object" ? event.mentions : {};
    const mentionIDs = Object.keys(mentions);
    let name = rest;
    for (const label of Object.values(mentions)) name = name.split(String(label)).join("");
    name = name.trim();
    const targetID = mentionIDs[0] || event.messageReply?.senderID || event.senderID;
    if (!name) return sendCommandReply(api, event, "usage: !banat nick @user <nickname>");
    await gc.setOneNickname(api, threadID, targetID, name, { lock: false });
    return sendCommandReply(api, event, "nickname set ✅");
  }
  if (sub === "nicklock") {
    const r = await gc.lockNicknames(api, threadID);
    return sendCommandReply(api, event, `${r.count} nickname locked 🔒`);
  }
  if (sub === "nickunlock") { gc.unlockNicknames(threadID); return sendCommandReply(api, event, "nicknames unlocked 🔓"); }
  if (sub === "gc") {
    const st = gc.getState();
    const name = st.names[threadID];
    const nicks = st.nicks[threadID];
    return sendCommandReply(api, event, `name lock: ${name ? `ON (${name})` : "OFF"} · nickname lock: ${nicks ? `ON (${nicks})` : "OFF"}`);
  }
}

function handleBanatCommand(api, event, body) {
  const threadID = String(event.threadID);
  const parts = String(body).trim().split(/\s+/);
  const sub = (parts[1] || "status").toLowerCase();
  const stateChanging = ["on","enable","start","off","disable","stop","toggle"].includes(sub);
  if (stateChanging && !isBotAdmin(event.senderID)) return sendCommandReply(api, event, "⛔ only bot admins can toggle Banat.") && true;

  if (sub === "on" || sub === "enable" || sub === "start") {
    updateGroupSettings(threadID, { banatMode: "on" });
    setBanatConversationMode(threadID, true, event.senderID);
    activeThreads.add(threadID);
    sendCommandReply(api, event, "banat is on. say whatever u want 😭");
    return true;
  }
  if (sub === "off" || sub === "disable" || sub === "stop") {
    updateGroupSettings(threadID, { banatMode: "off" });
    setBanatConversationMode(threadID, false);
    activeThreads.delete(threadID);
    sendCommandReply(api, event, "banat off. peace 😭");
    return true;
  }
  if (sub === "toggle") {
    const s = getGroupSettings(threadID);
    const currentlyOn = s.banatMode === "on" || (s.banatMode === "inherit" && (activeThreads.has(threadID) || isBanatConversationModeActive(threadID)));
    const next = !currentlyOn;
    updateGroupSettings(threadID, { banatMode: next ? "on" : "off" });
    setBanatConversationMode(threadID, next, event.senderID);
    if (next) activeThreads.add(threadID); else activeThreads.delete(threadID);
    sendCommandReply(api, event, next ? "banat is on 😭" : "banat is off");
    return true;
  }
  if (sub === "status") {
    const on = activeThreads.has(threadID) || isBanatConversationModeActive(threadID);
    sendCommandReply(api, event, on ? "banat: ON 🟢" : "banat: OFF 🔴");
    return true;
  }
  if (sub === "help") {
    sendCommandReply(api, event, "!banat on/off/toggle/status · GC: lockname [name] · unlockname · nickall <nick> · nickall! <nick> · nickclear · nick @user <nick> · nicklock · nickunlock · gc");
    return true;
  }
  if (GC_SUBS.has(sub)) {
    runGcCommand(api, event, sub, body).catch(e => sendCommandReply(api, event, `di gumana: ${String(e?.message || e).slice(0, 150)}`));
    return true;
  }
  sendCommandReply(api, event, "unknown banat command. use !banat help");
  return true;
}

function sendBanat(api, event, text) {
  const group = getGroupSettings(String(event.threadID));
  return sendBanatReplyWithTyping(api, text, String(event.threadID), event.messageID || null, {
    trafficSendMessage,
    incomingText: event.body || "",
    typingEnabled: group.typingEnabled,
    replyDelayMs: group.replyDelayMs === null ? undefined : group.replyDelayMs
  });
}

function onMessage(api, event) {
  if (!event) return;
  if (event.type === "event") { try { gc.handleEvent(api, event, botUserID); } catch (e) { console.warn("[GC] event:", e?.message || e); } return; }
  if (event.type && !["message","message_reply"].includes(event.type)) return;
  if (botPaused) return;
  if (event.senderID && botUserID && String(event.senderID) === String(botUserID)) return;

  const body = String(event.body || "").trim();
  if (!body) return;
  lastMessageAt = new Date().toISOString();
  if (isBanatCommand(body)) return handleBanatCommand(api, event, body) && undefined;

  const threadID = String(event.threadID);
  const s = getGroupSettings(threadID);
  const active = s.banatMode === "on" || (s.banatMode === "inherit" && (activeThreads.has(threadID) || isBanatConversationModeActive(threadID)));
  const target = classifyBanatTarget({ event, body, eclipseUserID: botUserID });

  let reply = null;
  try {
    if (active) reply = getBanatConversationReply(body, threadID);
    else if (target.shouldRespond) reply = getTriggerReply(body, threadID) || getBanatConversationReply(body, threadID);
  } catch (e) {
    console.warn("[BANAT] trigger lookup:", e?.message || e);
    reply = getBanatConversationReply(body, threadID);
  }
  if (!reply) return;
  sendBanat(api, event, reply).catch(e => console.error("[BANAT] reply:", e?.message || e));
}

function start(api, generation) {
  const previousApi = messengerApi;
  if (previousApi && previousApi !== api) {
    activeListenerGeneration = 0;
    try { previousApi.stopListenMqtt?.(); } catch (_) {}
  }
  messengerApi = api;
  activeListenerGeneration = generation;
  messengerConnected = true;
  loginError = null;
  lastConnectedAt = new Date().toISOString();
  lastListenerError = null;
  try { botUserID = String(api.getCurrentUserID?.() || ""); } catch (_) {}
  try { if (typeof api.setOptions === "function") api.setOptions({ listenEvents: true }); } catch (_) {}
  pushEvent("connection", `Messenger connected${botUserID ? ` as ${botUserID}` : ""}`);

  api.listenMqtt((error, event) => {
    if (generation !== activeListenerGeneration) return;
    if (error) {
      messengerConnected = false;
      lastDisconnectedAt = new Date().toISOString();
      lastListenerError = String(error?.message || error).slice(0, 300);
      messengerApi = null;
      activeListenerGeneration = 0;
      try { api.stopListenMqtt?.(); } catch (_) {}
      console.error("[LISTENER]", lastListenerError);
      pushEvent("connection", `Disconnected: ${lastListenerError}`);
      return;
    }
    if (event) { messengerConnected = true; lastMessageAt = new Date().toISOString(); }
    try { onMessage(api, event); } catch (e) { console.error("[BANAT] handler:", e); }
  });
  console.log(`[BANAT] online${botUserID ? ` as ${botUserID}` : ""}`);
}

function loginBot(sessionOverride = null) {
  if (loginInProgress) return false;
  let cookie;
  try {
    const supplied = sessionOverride || readSession();
    cookie = normalizeSession(supplied);
  } catch (e) { loginError = String(e?.message || e); console.error("[AUTH]", loginError); return false; }

  loginInProgress = true;
  const generation = ++loginGeneration;
  let settled = false;

  const fail = (err) => {
    if (settled || generation !== loginGeneration) return;
    settled = true;
    loginInProgress = false;
    loginError = String(err?.message || err || "Login failed").slice(0, 300);
    console.error("[AUTH]", loginError);
    pushEvent("error", `Login failed: ${loginError}`);
    // DO NOT retry automatically. Stay up, let the dashboard handle it.
  };

  try {
    const result = login(cookie, {}, (error, api) => {
      if (generation !== loginGeneration || settled) return;
      if (error || !api) return fail(error || new Error("Login returned no API"));
      settled = true;
      loginInProgress = false;
      start(api, generation);
    });
    if (result && typeof result.then === "function") {
      result.then(api => {
        if (generation !== loginGeneration || settled || !api) return;
        settled = true;
        loginInProgress = false;
        start(api, generation);
      }).catch(fail);
    }
  } catch (e) { fail(e); }
  return true;
}

// ─────────────────────────────────────────────────────────────────
// Dashboard wiring
// ─────────────────────────────────────────────────────────────────
try {
  dashboardServer = require("./dashboard-api")(PORT, () => ({
    ok: true,
    facebook_connected: messengerConnected,
    session_active: messengerConnected,
    bot_running: messengerConnected && !botPaused,
    login_in_progress: loginInProgress,
    login_error: loginError,
    last_connected_at: lastConnectedAt,
    last_disconnected_at: lastDisconnectedAt,
    last_listener_error: lastListenerError,
    last_message_at: lastMessageAt,
    uptime_seconds: Math.floor(process.uptime()),
    node_version: process.version,
    memory: process.memoryUsage(),
    updated_at: new Date().toISOString()
  }), {
    setPaused: (p) => { botPaused = p; pushEvent("bot", p ? "paused" : "resumed"); },
    getPaused: () => botPaused,
    connectSession: async (raw) => {
      try { fs.writeFileSync(SESSION_FILE, raw, { mode: 0o600 }); } catch (_) {}
      const normalized = normalizeSession(JSON.parse(raw.startsWith("[") || raw.startsWith("{") ? raw : JSON.stringify(raw)));
      loginBot(normalized);
      return { saved: true };
    },
    reconnect: async () => {
      try { messengerApi?.stopListenMqtt?.(); } catch (_) {}
      messengerConnected = false;
      activeListenerGeneration = 0;
      loginBot();
      pushEvent("session", "Reconnect requested");
    },
    disconnect: async () => {
      try { messengerApi?.stopListenMqtt?.(); } catch (_) {}
      messengerApi = null;
      messengerConnected = false;
      activeListenerGeneration = 0;
      try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
      pushEvent("session", "Disconnected");
    },
    getSessionStatus: () => {
      let configured = false;
      try { configured = fs.existsSync(SESSION_FILE) || Boolean(process.env.FB_COOKIES || process.env.FB_APPSTATE); } catch (_) {}
      return { configured, connected: messengerConnected };
    },
    getEvents: () => activityEvents,
    getGroups: () => new Promise((resolve, reject) => {
      if (!messengerApi || typeof messengerApi.getThreadList !== "function") return reject(new Error("Messenger not connected"));
      messengerApi.getThreadList(50, null, ["INBOX"], (err, list) => {
        if (err) return reject(err);
        resolve((list || []).filter(t => t && (t.isGroup !== false)).map(t => ({ threadID: String(t.threadID), name: t.name || "Group", participantCount: (t.participantIDs || []).length })));
      });
    }),
    getSettings: async () => {
      const groups = {};
      for (const [k, v] of groupSettings) groups[k] = v;
      return { groups };
    },
    updateGroup: async (threadID, input) => updateGroupSettings(threadID, input || {}),
    gcState: () => gc.getState(),
    gcAction: async (action, body) => {
      const r = await gc.run(messengerApi, action, body || {});
      if (r && r.background && typeof r.job === "function") {
        Promise.resolve().then(r.job).catch(e => console.error("[GC]", e));
      }
      return r;
    }
  });
} catch (e) {
  console.error("[DASHBOARD] failed to start:", e);
}

// ─────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────
console.log("[BANAT] booting, no-key build");
try {
  loginBot();
} catch (e) {
  console.error("[BOOT] loginBot threw (process stays up):", e?.message || e);
}
