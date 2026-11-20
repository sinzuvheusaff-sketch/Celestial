"use strict";

/*
 * ECLIPSE BANAT — no-key build, extended
 * --------------------------------------
 * Optional modules (auto-disabled if env/deps missing):
 *   - Raid Mode        (needs ECLIPSE_RAID_DATABASE_URL or DATABASE_URL + `pg`)
 *   - Group title lock (needs Neon store env + `pg`)
 *   - Reaction emoji   (always on; configurable via dashboard)
 *   - Spam Mode        (always available while connected)
 *   - Slash banats     (used by on/off commands — pure strings, no deps)
 */

const fs = require("fs");
const path = require("path");
const { login } = require("ws3-fca");
const { getTriggerReply, getBanatConversationReply } = require("./triggers");
const { sendBanatReplyWithTyping } = require("./banat-human");
const { classifyBanatTarget, setBanatConversationMode, isBanatConversationModeActive } = require("./banat-targeting");
const gc = require("./gc-controls");

const botSettings = require("./bot-settings");
const { createRaidMode } = require("./raid-mode");
const { createGroupTitleGuard } = require("./group-title-guard");
const { createReactionAudience, validateReactionTarget } = require("./reaction-audience");
const { createSpamMode } = require("./spam-mode");
const slashBanats = require("./slash-banats");

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

let raidMode = null;
let titleGuard = null;
let reactionAudience = null;
let spamMode = null;

process.on("uncaughtException", (e) => console.error("[UNCAUGHT]", e));
process.on("unhandledRejection", (e) => console.error("[UNHANDLED]", e));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pushEvent(type, message) {
  activityEvents.unshift({ type, message, at: new Date().toISOString() });
  if (activityEvents.length > 100) activityEvents.length = 100;
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

async function acquireGlobalSlot() { while (globalActive >= GLOBAL_SEND_LIMIT) await sleep(150); globalActive++; }
function releaseGlobalSlot() { globalActive = Math.max(0, globalActive - 1); }

function is1545012(err) { return /1545012|temporarily unavailable|message could not be sent/i.test(JSON.stringify(err || "")); }

function trafficSendMessage(api, message, threadID, callback, replyToMessageID = null) {
  const key = String(threadID);
  return enqueue(key, async () => {
    const now = Date.now();
    const cool = Number(threadCooldown.get(key) || 0);
    if (cool > now) { await sleep(cool - now); if (Number(threadCooldown.get(key) || 0) <= Date.now()) threadCooldown.delete(key); }
    const s = botSettings.getGroupSettings(key);
    const cd = s.cooldownMs == null ? THREAD_COOLDOWN_MS : Math.max(0, Number(s.cooldownMs));
    const sinceLast = now - Number(threadLastSent.get(key) || 0);
    if (sinceLast < cd) await sleep(cd - sinceLast);

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
              if (r && typeof r.then === "function") r.then(v => done(null, v)).catch(done);
            } catch (e) { reject(e); }
          });
          threadLastSent.set(key, Date.now());
          callback(null, result);
          return;
        } catch (e) {
          lastErr = e;
          if (!is1545012(e) || attempt >= RETRY_DELAYS.length) break;
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
    const done = (e, i) => { if (settled) return; settled = true; e ? reject(e) : resolve(i); };
    try {
      const r = replyToMessageID
        ? api.sendMessage(message, threadID, done, replyToMessageID)
        : api.sendMessage(message, threadID, done);
      if (r && typeof r.then === "function") r.then(v => done(null, v)).catch(done);
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
  return ADMIN_IDS.includes("*") || ADMIN_IDS.includes(String(senderID || ""));
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
  if (sub === "lockname") { const r = await gc.lockName(api, threadID, rest); return sendCommandReply(api, event, r.applied ? `GC name locked: ${r.name} 🔒` : `locked "${r.name}" pero di ko mapalitan ngayon: ${String(r.error).slice(0,80)}`); }
  if (sub === "unlockname") { gc.unlockName(threadID); return sendCommandReply(api, event, "GC name unlocked 🔓"); }
  if (sub === "nickall" || sub === "nickall!") {
    if (!rest) return sendCommandReply(api, event, "usage: !banat nickall <nickname>");
    sendCommandReply(api, event, "sige, nilalagay ko na. wait lang 😭");
    const r = await gc.setAllNicknames(api, threadID, rest, { lock: sub === "nickall!" });
    return sendCommandReply(api, event, `done ${r.ok}/${r.total}${r.locked ? " (locked 🔒)" : ""}${r.failed ? `, ${r.failed} failed` : ""}`);
  }
  if (sub === "nickclear") { sendCommandReply(api, event, "binubura ko na..."); const r = await gc.setAllNicknames(api, threadID, "", {}); return sendCommandReply(api, event, `cleared ${r.ok}/${r.total}`); }
  if (sub === "nick") {
    const mentions = event.mentions && typeof event.mentions === "object" ? event.mentions : {};
    const ids = Object.keys(mentions);
    let name = rest;
    for (const label of Object.values(mentions)) name = name.split(String(label)).join("");
    name = name.trim();
    const target = ids[0] || event.messageReply?.senderID || event.senderID;
    if (!name) return sendCommandReply(api, event, "usage: !banat nick @user <nickname>");
    await gc.setOneNickname(api, threadID, target, name, { lock: false });
    return sendCommandReply(api, event, "nickname set ✅");
  }
  if (sub === "nicklock") { const r = await gc.lockNicknames(api, threadID); return sendCommandReply(api, event, `${r.count} nickname locked 🔒`); }
  if (sub === "nickunlock") { gc.unlockNicknames(threadID); return sendCommandReply(api, event, "nicknames unlocked 🔓"); }
  if (sub === "gc") {
    const st = gc.getState();
    return sendCommandReply(api, event, `name lock: ${st.names[threadID] ? `ON (${st.names[threadID]})` : "OFF"} · nickname lock: ${st.nicks[threadID] ? `ON (${st.nicks[threadID]})` : "OFF"}`);
  }
}

function handleBanatCommand(api, event, body) {
  const threadID = String(event.threadID);
  const parts = String(body).trim().split(/\s+/);
  const sub = (parts[1] || "status").toLowerCase();
  const stateChanging = ["on","enable","start","off","disable","stop","toggle"].includes(sub);
  if (stateChanging && !isBotAdmin(event.senderID)) {
    return sendCommandReply(api, event, slashBanats.pickUnauthorizedSlashBanat(threadID, event.senderID)) && true;
  }
  if (sub === "on" || sub === "enable" || sub === "start") {
    botSettings.updateGroup(threadID, { banatMode: "on" });
    setBanatConversationMode(threadID, true, event.senderID);
    activeThreads.add(threadID);
    sendCommandReply(api, event, slashBanats("on"));
    return true;
  }
  if (sub === "off" || sub === "disable" || sub === "stop") {
    botSettings.updateGroup(threadID, { banatMode: "off" });
    setBanatConversationMode(threadID, false);
    activeThreads.delete(threadID);
    sendCommandReply(api, event, slashBanats("off"));
    return true;
  }
  if (sub === "toggle") {
    const s = botSettings.getGroupSettings(threadID);
    const currentlyOn = s.banatMode === "on" || (s.banatMode === "inherit" && (activeThreads.has(threadID) || isBanatConversationModeActive(threadID)));
    const next = !currentlyOn;
    botSettings.updateGroup(threadID, { banatMode: next ? "on" : "off" });
    setBanatConversationMode(threadID, next, event.senderID);
    if (next) activeThreads.add(threadID); else activeThreads.delete(threadID);
    sendCommandReply(api, event, slashBanats(next ? "on" : "off"));
    return true;
  }
  if (sub === "status") { const on = activeThreads.has(threadID) || isBanatConversationModeActive(threadID); sendCommandReply(api, event, on ? "banat: ON 🟢" : "banat: OFF 🔴"); return true; }
  if (sub === "help") { sendCommandReply(api, event, "!banat on/off/toggle/status · GC: lockname · unlockname · nickall <nick> · nickall! <nick> · nickclear · nick @user <nick> · nicklock · nickunlock · gc"); return true; }
  if (GC_SUBS.has(sub)) { runGcCommand(api, event, sub, body).catch(e => sendCommandReply(api, event, `di gumana: ${String(e?.message || e).slice(0,150)}`)); return true; }
  sendCommandReply(api, event, "unknown banat command. use !banat help");
  return true;
}

function sendBanat(api, event, text) {
  const s = botSettings.getGroupSettings(String(event.threadID));
  return sendBanatReplyWithTyping(api, text, String(event.threadID), event.messageID || null, {
    trafficSendMessage,
    incomingText: event.body || "",
    typingEnabled: s.typingEnabled,
    replyDelayMs: s.replyDelayMs === null ? undefined : s.replyDelayMs
  });
}

function onMessage(api, event) {
  if (!event) return;

  if (event.type === "event") {
    try { gc.handleEvent(api, event, botUserID); } catch (e) { console.warn("[GC]", e?.message || e); }
    if (raidMode?.isInitialized?.()) raidMode.handleEvent(event).catch(e => console.warn("[RAID]", e?.message || e));
    if (titleGuard) titleGuard.handleEvent(event).catch(e => console.warn("[TITLE]", e?.message || e));
    return;
  }

  if (event.type && !["message","message_reply"].includes(event.type)) return;
  if (botPaused) return;
  if (event.senderID && botUserID && String(event.senderID) === String(botUserID)) return;

  const body = String(event.body || "").trim();
  if (!body) return;
  lastMessageAt = new Date().toISOString();

  const r = botSettings.getReactionSettings();
  if (r.enabled && ["incoming_messages","both"].includes(r.target) && reactionAudience) {
    reactionAudience.isAllowed(r, event, api).then(allowed => {
      if (allowed && botSettings.shouldReact(String(event.threadID), "incoming_messages") && event.messageID) {
        try {
          if (typeof api.setMessageReactionMqtt === "function") api.setMessageReactionMqtt(r.emoji, String(event.messageID), String(event.threadID), () => {});
          else if (typeof api.setMessageReaction === "function") api.setMessageReaction(r.emoji, String(event.messageID), () => {}, true);
        } catch (_) {}
      }
    }).catch(() => {});
  }

  if (isBanatCommand(body)) return handleBanatCommand(api, event, body) && undefined;
  if (botSettings.isQuietNow(botSettings.getGroupSettings(String(event.threadID)))) return;

  const threadID = String(event.threadID);
  const s = botSettings.getGroupSettings(threadID);
  const active = s.banatMode === "on" || (s.banatMode === "inherit" && (activeThreads.has(threadID) || isBanatConversationModeActive(threadID)));
  const target = classifyBanatTarget({ event, body, eclipseUserID: botUserID });

  let reply = null;
  try {
    if (active) reply = getBanatConversationReply(body, threadID);
    else if (target.shouldRespond) reply = getTriggerReply(body, threadID) || getBanatConversationReply(body, threadID);
  } catch (e) {
    console.warn("[BANAT]", e?.message || e);
    reply = getBanatConversationReply(body, threadID);
  }
  if (!reply) return;
  sendBanat(api, event, reply)
    .then(sent => {
      const rr = botSettings.getReactionSettings();
      if (sent === true && rr.enabled && ["bot_replies","both"].includes(rr.target) && event.messageID && botSettings.shouldReact(threadID, "bot_replies")) {
        try {
          if (typeof api.setMessageReactionMqtt === "function") api.setMessageReactionMqtt(rr.emoji, String(event.messageID), threadID, () => {});
          else if (typeof api.setMessageReaction === "function") api.setMessageReaction(rr.emoji, String(event.messageID), () => {}, true);
        } catch (_) {}
      }
    })
    .catch(e => console.error("[BANAT]", e?.message || e));
}

function start(api, generation) {
  const previousApi = messengerApi;
  if (previousApi && previousApi !== api) { activeListenerGeneration = 0; try { previousApi.stopListenMqtt?.(); } catch (_) {} }
  messengerApi = api;
  activeListenerGeneration = generation;
  messengerConnected = true;
  loginError = null;
  lastConnectedAt = new Date().toISOString();
  lastListenerError = null;
  try { botUserID = String(api.getCurrentUserID?.() || ""); } catch (_) {}
  try { if (typeof api.setOptions === "function") api.setOptions({ listenEvents: true }); } catch (_) {}
  pushEvent("connection", `Messenger connected${botUserID ? ` as ${botUserID}` : ""}`);
  if (raidMode?.isInitialized?.()) raidMode.start();
  if (titleGuard) titleGuard.start();

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

function normalizeSession(value) {
  if (typeof value === "string") { const s = value.trim(); if (!s) throw new Error("Empty session"); return s; }
  const entries = Array.isArray(value) ? value : Array.isArray(value?.appState) ? value.appState : Array.isArray(value?.cookies) ? value.cookies : null;
  if (!entries) throw new Error("Session must be cookie string or cookie array");
  const parts = entries.map(c => { const k = c?.key ?? c?.name, v = c?.value; return k != null && v != null ? `${String(k).trim()}=${String(v)}` : null; }).filter(Boolean);
  if (!parts.length) throw new Error("Session contains no cookie entries");
  return parts.join("; ");
}

function readSession() {
  const raw = process.env.FB_COOKIES || process.env.FB_APPSTATE;
  if (raw) { const s = String(raw).trim(); try { return JSON.parse(s); } catch (_) { return s; } }
  if (fs.existsSync(SESSION_FILE)) return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
  const cookies = path.join(process.cwd(), "cookies.json");
  if (fs.existsSync(cookies)) return JSON.parse(fs.readFileSync(cookies, "utf8"));
  throw new Error("No Facebook session. Paste a cookie on the dashboard.");
}

function loginBot(sessionOverride = null) {
  if (loginInProgress) return false;
  let cookie;
  try { cookie = normalizeSession(sessionOverride || readSession()); }
  catch (e) { loginError = String(e?.message || e); console.error("[AUTH]", loginError); return false; }

  loginInProgress = true;
  const generation = ++loginGeneration;
  let settled = false;
  const fail = (err) => {
    if (settled || generation !== loginGeneration) return;
    settled = true; loginInProgress = false;
    loginError = String(err?.message || err || "Login failed").slice(0, 300);
    console.error("[AUTH]", loginError);
    pushEvent("error", `Login failed: ${loginError}`);
  };
  try {
    const result = login(cookie, {}, (error, api) => {
      if (generation !== loginGeneration || settled) return;
      if (error || !api) return fail(error || new Error("Login returned no API"));
      settled = true; loginInProgress = false; start(api, generation);
    });
    if (result && typeof result.then === "function") {
      result.then(api => {
        if (generation !== loginGeneration || settled || !api) return;
        settled = true; loginInProgress = false; start(api, generation);
      }).catch(fail);
    }
  } catch (e) { fail(e); }
  return true;
}

raidMode = createRaidMode({ getApi: () => messengerApi, namespace: "eclipse-banat" });
raidMode.initialize().then(ok => {
  if (ok) { console.log("[RAID] initialized"); if (messengerConnected) raidMode.start(); }
  else console.warn("[RAID] disabled:", raidMode.getStatus().then?.(s => s.error).catch?.(() => "") || "not available");
}).catch(e => console.warn("[RAID] init failed:", e?.message || e));

titleGuard = createGroupTitleGuard({ store: null, getApi: () => messengerApi });
try { titleGuard.start(); } catch (e) { console.warn("[TITLE]", e?.message || e); }

reactionAudience = createReactionAudience({
  ttlMs: 120000,
  getAdmins: async (api, threadID) => {
    if (!api?.getThreadInfo) return [];
    return new Promise(resolve => {
      try {
        api.getThreadInfo(String(threadID), (err, info) => {
          if (err || !info) return resolve([]);
          const ids = Array.isArray(info.adminIDs) ? info.adminIDs.map(String) : [];
          resolve(ids);
        });
      } catch (_) { resolve([]); }
    });
  }
});

spamMode = createSpamMode({
  getApi: () => messengerApi,
  isAuthorized: () => messengerConnected && !botPaused,
  sendMessage: (api, message, threadID) => new Promise((resolve, reject) => {
    trafficSendMessage(api, message, threadID, (err, info) => err ? reject(err) : resolve(info));
  })
});

try {
  require("./dashboard-api")(PORT, () => ({
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
    raid: { available: false }, 
    updated_at: new Date().toISOString()
  }), {
    setPaused: (p) => { botPaused = p; if (p) spamMode.stopAll("paused"); pushEvent("bot", p ? "paused" : "resumed"); },
    getPaused: () => botPaused,
    connectSession: async (raw) => {
      try { fs.writeFileSync(SESSION_FILE, raw, { mode: 0o600 }); } catch (_) {}
      let payload;
      try { payload = JSON.parse(raw); } catch (_) { payload = raw; }
      loginBot(normalizeSession(payload));
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
      if (!messengerApi?.getThreadList) return reject(new Error("Messenger not connected"));
      messengerApi.getThreadList(50, null, ["INBOX"], (err, list) => {
        if (err) return reject(err);
        resolve((list || []).filter(t => t && (t.isGroup !== false)).map(t => ({
          threadID: String(t.threadID),
          name: t.name || "Group",
          participantCount: (t.participantIDs || []).length
        })));
      });
    }),
    getGroupMembers: (threadID) => new Promise((resolve, reject) => {
      if (!messengerApi?.getThreadInfo) return reject(new Error("Messenger not connected"));
      messengerApi.getThreadInfo(String(threadID), (err, info) => {
        if (err) return reject(err);
        const ids = Array.isArray(info?.participantIDs) ? info.participantIDs.map(String) : [];
        const admins = new Set(Array.isArray(info?.adminIDs) ? info.adminIDs.map(String) : []);
        const names = info?.userInfo || {};
        resolve(ids.map(id => ({
          userID: id,
          name: names[id]?.name || `Member ${id.slice(-4)}`,
          isAdmin: admins.has(id)
        })));
      });
    }),
    getSettings: async () => botSettings.getSettings(),
    updateGroup: async (threadID, input) => botSettings.updateGroup(threadID, input || {}),
    gcState: () => gc.getState(),
    gcAction: async (action, body) => {
      const r = await gc.run(messengerApi, action, body || {});
      if (r && r.background && typeof r.job === "function") Promise.resolve().then(r.job).catch(e => console.error("[GC]", e));
      return r;
    },
    getReaction: async () => botSettings.getReactionSettings(),
    updateReaction: async (input) => {
      const current = botSettings.getReactionSettings();
      const merged = validateReactionTarget({ ...current, ...(input || {}) });
      const next = botSettings.setRuntimeReaction(merged);
      pushEvent("settings", `reaction emoji ${next.emoji} · audience ${next.targetMode}`);
      return next;
    },
    spamMode: {
      start: async (input) => {
        const groups = await new Promise((resolve, reject) => {
          if (!messengerApi?.getThreadList) return reject(new Error("Messenger not connected"));
          messengerApi.getThreadList(50, null, ["INBOX"], (e, l) => e ? reject(e) : resolve(l || []));
        });
        const threadID = String(input?.threadID || "").trim();
        if (!groups.some(g => String(g.threadID) === threadID)) throw new Error("Choose a group from the loaded list.");
        return spamMode.start({ threadID, message: String(input.message || "").trim(), intervalSeconds: input.intervalSeconds, loops: input.loops ?? 1 });
      },
      stop: (threadID) => spamMode.stop(threadID),
      stopAll: (reason) => spamMode.stopAll(reason),
      getStatus: () => spamMode.getStatus()
    },
    raidMode: {
      isInitialized: () => Boolean(raidMode?.isInitialized?.()),
      getStatus: () => raidMode.getStatus(),
      getGroups: () => raidMode.getGroups(),
      saveTheme: (input) => raidMode.saveTheme(input),
      uploadImage: (buffer, type, name) => raidMode.uploadImage(buffer, type, name),
      getImage: () => raidMode.getImage(),
      activate: (input) => raidMode.activate(input),
      repair: (threadID) => raidMode.repairGroup(String(threadID), "manual-repair"),
      emergencyStop: () => raidMode.emergencyStop()
    }
  });
} catch (e) { console.error("[DASHBOARD] start failed:", e); }

console.log("[BANAT] booting");
try { loginBot(); } catch (e) { console.error("[BOOT]", e?.message || e); }
