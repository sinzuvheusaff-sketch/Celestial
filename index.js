"use strict";

/*
 * CELESTIAL BANAT — no-key build
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
      if (r && typeof r.then === "function") r
