"use strict";

const fs = require("fs");
const path = require("path");
const { login } = require("ws3-fca");
const { getTriggerReply, getBanatConversationReply } = require("./triggers");
const { sendBanatReplyWithTyping } = require("./banat-human");
const { classifyBanatTarget, setBanatConversationMode, isBanatConversationModeActive } = require("./banat-targeting");
const gc = require("./gc-controls");

const { createSpamMode } = require("./spam-mode");
const { createRaidMode } = require("./raid-mode");

const PORT = Number(process.env.PORT || 10000);
const SESSION_FILE = path.join(process.cwd(), "appstate.json");

const activeThreads = new Set();
const threadQueues = new Map();
const activityEvents = [];

let botUserID = "";
let messengerApi = null;
let botPaused = false;
let messengerConnected = false;
let loginError = null;
let lastMessageAt = null;
let loginInProgress = false;

let spamMode = null;
let raidMode = null;

process.on("uncaughtException", (e) => console.error("[UNCAUGHT]", e));
process.on("unhandledRejection", (e) => console.error("[UNHANDLED]", e));

function pushEvent(type, message) { activityEvents.unshift({ type, message, at: new Date().toISOString() }); if (activityEvents.length > 100) activityEvents.length = 100; }
function isBanatCommand(body) { return /^!banat(?:\s|$)/i.test(String(body || "").trim()); }

function sendCommandReply(api, event, message) {
  api.sendMessage(message, String(event.threadID), () => {}, event.messageID || null).catch(() => {});
}

function handleBanatCommand(api, event, body) {
  const threadID = String(event.threadID);
  const sub = (String(body).trim().split(/\s+/)[1] || "status").toLowerCase();
  if (sub === "on" || sub === "start") { setBanatConversationMode(threadID, true, event.senderID); activeThreads.add(threadID); sendCommandReply(api, event, "banat is on 😭"); return; }
  if (sub === "off" || sub === "stop") { setBanatConversationMode(threadID, false); activeThreads.delete(threadID); sendCommandReply(api, event, "banat off 😭"); return; }
  if (sub === "status") { sendCommandReply(api, event, activeThreads.has(threadID) ? "banat: ON 🟢" : "banat: OFF 🔴"); return; }
  sendCommandReply(api, event, "!banat on/off/status");
}

function onMessage(api, event) {
  if (!event) return;
  if (event.type === "event") { try { gc.handleEvent(api, event, botUserID); raidMode.handleEvent(event); } catch (_) {} return; }
  if (botPaused) return;
  if (event.senderID && botUserID && String(event.senderID) === String(botUserID)) return;

  const body = String(event.body || "").trim();
  if (!body) return;
  lastMessageAt = new Date().toISOString();

  if (isBanatCommand(body)) return handleBanatCommand(api, event, body);

  const threadID = String(event.threadID);
  const active = activeThreads.has(threadID) || isBanatConversationModeActive(threadID);
  const target = classifyBanatTarget({ event, body, eclipseUserID: botUserID });

  let reply = null;
  if (active || target.shouldRespond) {
    reply = getTriggerReply(body, threadID) || getBanatConversationReply(body, threadID);
  }
  if (!reply) return;

  sendBanatReplyWithTyping(api, reply, threadID, event.messageID || null, {
    trafficSendMessage: (a, m, t, cb, r) => a.sendMessage(m, t, cb, r),
    incomingText: body
  }).catch(() => {});
}

function start(api) {
  messengerApi = api;
  messengerConnected = true;
  loginError = null;
  try { botUserID = String(api.getCurrentUserID?.() || ""); } catch (_) {}
  try { if (typeof api.setOptions === "function") api.setOptions({ listenEvents: true }); } catch (_) {}
  pushEvent("connection", "Messenger connected");

  api.listenMqtt((error, event) => {
    if (error) {
      messengerConnected = false;
      loginError = String(error?.message || error).slice(0, 300);
      messengerApi = null;
      return;
    }
    messengerConnected = true;
    if (event) lastMessageAt = new Date().toISOString();
    try { onMessage(api, event); } catch (e) { console.error("[BANAT]", e); }
  });
  console.log(`[BANAT] online${botUserID ? ` as ${botUserID}` : ""}`);
}

function normalizeSession(value) {
  if (typeof value === "string") return value.trim();
  const entries = Array.isArray(value) ? value : Array.isArray(value?.appState) ? value.appState : Array.isArray(value?.cookies) ? value.cookies : [];
  return entries.map(c => `${c?.key ?? c?.name}=${c?.value}`).filter(Boolean).join("; ");
}

function readSession() {
  const raw = process.env.FB_COOKIES || process.env.FB_APPSTATE;
  if (raw) { try { return JSON.parse(raw); } catch (_) { return raw; } }
  if (fs.existsSync(SESSION_FILE)) return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
  throw new Error("No Facebook session. Paste a cookie on the dashboard.");
}

function loginBot(sessionOverride = null) {
  if (loginInProgress) return false;
  let cookie;
  try { cookie = normalizeSession(sessionOverride || readSession()); } catch (e) { loginError = String(e?.message || e); return false; }

  loginInProgress = true;
  login(cookie, {}, (error, api) => {
    loginInProgress = false;
    if (error || !api) { loginError = String(error?.message || error).slice(0, 300); pushEvent("error", `Login failed: ${loginError}`); return; }
    start(api);
  });
  return true;
}

// Setup Modules
spamMode = createSpamMode({
  getApi: () => messengerApi,
  isAuthorized: () => messengerConnected && !botPaused,
  sendMessage: (api, message, threadID) => new Promise((resolve, reject) => {
    api.sendMessage(message, threadID, (err, info) => err ? reject(err) : resolve(info));
  })
});

raidMode = createRaidMode({ getApi: () => messengerApi });
raidMode.initialize().then(ok => {
  if (ok) console.log("[RAID] initialized");
  else console.warn("[RAID] disabled (no DATABASE_URL)");
});

// Dashboard
try {
  require("./dashboard-api")(PORT, () => ({
    ok: true, facebook_connected: messengerConnected, bot_running: messengerConnected && !botPaused,
    login_in_progress: loginInProgress, login_error: loginError, last_message_at: lastMessageAt,
    uptime_seconds: Math.floor(process.uptime()), node_version: process.version, memory: process.memoryUsage()
  }), {
    setPaused: (p) => { botPaused = p; pushEvent("bot", p ? "paused" : "resumed"); },
    getPaused: () => botPaused,
    connectSession: async (raw) => {
      try { fs.writeFileSync(SESSION_FILE, raw, { mode: 0o600 }); } catch (_) {}
      let payload; try { payload = JSON.parse(raw); } catch (_) { payload = raw; }
      loginBot(normalizeSession(payload)); return { saved: true };
    },
    reconnect: async () => { try { messengerApi?.stopListenMqtt?.(); } catch (_) {} messengerConnected = false; loginBot(); },
    disconnect: async () => { try { messengerApi?.stopListenMqtt?.(); } catch (_) {} messengerApi = null; messengerConnected = false; try { fs.unlinkSync(SESSION_FILE); } catch (_) {} },
    getSessionStatus: () => ({ configured: fs.existsSync(SESSION_FILE), connected: messengerConnected }),
    getEvents: () => activityEvents,
    getGroups: () => new Promise((resolve, reject) => {
      if (!messengerApi?.getThreadList) return reject(new Error("Messenger not connected"));
      messengerApi.getThreadList(50, null, ["INBOX"], (err, list) => {
        if (err) return reject(err);
        resolve((list || []).filter(t => t && (t.isGroup !== false)).map(t => ({ threadID: String(t.threadID), name: t.name || "Group" })));
      });
    }),
    getSettings: async () => ({}),
    updateGroup: async () => ({}),
    gcState: () => gc.getState(),
    gcAction: async (action, body) => gc.run(messengerApi, action, body || {}),
    
    // Spam & Raid Hooks for Dashboard
    spamMode: {
      start: async (input) => spamMode.start(input),
      stop: (id) => spamMode.stop(id),
      stopAll: () => spamMode.stopAll(),
      getStatus: () => spamMode.getStatus()
    },
    raidMode: {
      getStatus: () => raidMode.getStatus(),
      saveTheme: (t) => raidMode.saveTheme(t),
      uploadImage: (buf, type) => raidMode.uploadImage(buf, type),
      getImage: () => raidMode.getImage(),
      activate: (ids) => raidMode.activate(ids),
      emergencyStop: () => raidMode.emergencyStop()
    }
  });
} catch (e) { console.error("[DASHBOARD] error:", e); }

console.log("[BANAT] booting...");
try { loginBot(); } catch (e) { console.error("[BOOT]", e); }
