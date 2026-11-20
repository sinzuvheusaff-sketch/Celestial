"use strict";

const fs = require("fs");
const path = require("path");
const { login } = require("ws3-fca");
const { getTriggerReply, getBanatConversationReply } = require("./triggers");
const { sendBanatReplyWithTyping } = require("./banat-human");
const { classifyBanatTarget, setBanatConversationMode, isBanatConversationModeActive } = require("./banat-targeting");
const gc = require("./gc-controls");

const groupSettings = new Map();
function getGroupSettings(threadID) {
  const key = String(threadID);
  if (!groupSettings.has(key)) groupSettings.set(key, { banatMode: "inherit", typingEnabled: true, replyDelayMs: null, cooldownMs: null });
  return groupSettings.get(key);
}
function updateGroupSettings(threadID, input) {
  const current = getGroupSettings(threadID);
  const next = { ...current };
  if (["on", "off", "inherit"].includes(input.banatMode)) next.banatMode = input.banatMode;
  if (typeof input.typingEnabled === "boolean") next.typingEnabled = input.typingEnabled;
  if (input.replyDelayMs === null || Number.isFinite(Number(input.replyDelayMs))) next.replyDelayMs = input.replyDelayMs === null ? null : Number(input.replyDelayMs);
  if (input.cooldownMs === null || Number.isFinite(Number(input.cooldownMs))) next.cooldownMs = input.cooldownMs === null ? null : Number(input.cooldownMs);
  groupSettings.set(String(threadID), next);
  return next;
}

const PORT = Number(process.env.PORT || 10000);
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

process.on("uncaughtException", (e) => console.error("[UNCAUGHT]", e));
process.on("unhandledRejection", (e) => console.error("[UNHANDLED]", e));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function pushEvent(type, message) { activityEvents.unshift({ type, message, at: new Date().toISOString() }); if (activityEvents.length > 100) activityEvents.length = 100; }

function enqueue(threadID, job) {
  const key = String(threadID);
  const current = threadQueues.get(key) || Promise.resolve();
  const next = current.catch(() => {}).then(job).finally(() => { if (threadQueues.get(key) === next) threadQueues.delete(key); });
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
    const s = getGroupSettings(key);
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
              const r = replyToMessageID ? api.sendMessage(message, threadID, done, replyToMessageID) : api.sendMessage(message, threadID, done);
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
      const r = replyToMessageID ? api.sendMessage(message, threadID, done, replyToMessageID) : api.sendMessage(message, threadID, done);
      if (r && typeof r.then === "function") r.then(v => done(null, v)).catch(done);
    } catch (e) { done(e); }
  });
}

function sendCommandReply(api, event, message) {
  commandSendMessage(api, message, String(event.threadID), event.messageID || null).then(() => pushEvent("command", message)).catch(e => console.error("[CMD] reply failed:", e?.message || e));
}

const GC_SUBS = new Set(["lockname","unlockname","nickall","nickall!","nickclear","nick","nicklock","nickunlock","gc"]);
const ADMIN_IDS = String(process.env.BANAT_ADMIN_IDS || "").split(/[,\s]+/).filter(Boolean);

function isBotAdmin(senderID) { if (!ADMIN_IDS.length) return true; return ADMIN_IDS.includes("*") || ADMIN_IDS.includes(String(senderID || "")); }

async function isGcAdmin(api, event) {
  const id = String(event.senderID || "");
  if (ADMIN_IDS.includes("*") || ADMIN_IDS.includes(id)) return true;
  try { return (await gc.getAdminIDs(api, event.threadID)).includes(id); } catch (_) { return false; }
}

async function runGcCommand(api, event, sub, body) {
  if (event.isGroup === false) return sendCommandReply(api, event, "sa GC lang to 😭");
  if (!(await isGcAdmin(api, event))) return sendCommandReply(api, event, "GC admin lang pwede nito 😭");
  const threadID = String(event.threadID);
  const rest = String(body).trim().replace(/^!banat\s+\S+\s*/i, "").trim();
  if (sub === "lockname") { const r = await gc.lockName(api, threadID, rest); return sendCommandReply(api, event, r.applied ? `GC name locked: ${r.name} 🔒` : `locked "${r.name}" pero di ko mapalitan: ${String(r.error).slice(0,80)}`); }
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
    for (const label of Object.values(mentions)) name
