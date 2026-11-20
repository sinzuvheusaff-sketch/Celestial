"use strict";

const groups = new Map();
let reaction = {
  enabled: false,
  emoji: "😆",
  target: "bot_replies",       // "bot_replies" | "incoming_messages" | "both"
  targetMode: "all",           // "all" | "admins" | "member"
  targetUserIds: [],
  targetUserNames: [],
  targetUserId: "",
  targetUserName: "",
  targetThreadID: "",
  probability: 100,
  cooldownSeconds: 0
};

function getGroupSettings(threadID) {
  const key = String(threadID);
  if (!groups.has(key)) {
    groups.set(key, {
      banatMode: "inherit",
      typingEnabled: true,
      replyDelayMs: null,
      cooldownMs: null,
      quietStart: "",
      quietEnd: ""
    });
  }
  return groups.get(key);
}

function updateGroup(threadID, input = {}) {
  const current = getGroupSettings(threadID);
  const next = { ...current };
  if (["on", "off", "inherit"].includes(input.banatMode)) next.banatMode = input.banatMode;
  if (typeof input.typingEnabled === "boolean") next.typingEnabled = input.typingEnabled;
  if (input.replyDelayMs === null || Number.isFinite(Number(input.replyDelayMs))) {
    next.replyDelayMs = input.replyDelayMs === null ? null : Number(input.replyDelayMs);
  }
  if (input.cooldownMs === null || Number.isFinite(Number(input.cooldownMs))) {
    next.cooldownMs = input.cooldownMs === null ? null : Number(input.cooldownMs);
  }
  if (typeof input.quietStart === "string") next.quietStart = input.quietStart;
  if (typeof input.quietEnd === "string") next.quietEnd = input.quietEnd;
  groups.set(String(threadID), next);
  return next;
}

function getSettings() {
  const map = {};
  for (const [k, v] of groups) map[k] = v;
  return { groups: map, reaction };
}

function getReactionSettings() { return { ...reaction, targetUserIds: [...reaction.targetUserIds], targetUserNames: [...reaction.targetUserNames] }; }

function setRuntimeReaction(next) {
  if (!next || typeof next !== "object") return reaction;
  reaction = { ...reaction, ...next };
  reaction.targetUserIds = Array.isArray(next.targetUserIds) ? next.targetUserIds.map(String) : reaction.targetUserIds;
  reaction.targetUserNames = Array.isArray(next.targetUserNames) ? next.targetUserNames.map(String) : reaction.targetUserNames;
  return reaction;
}

function sanitizeReaction(input = {}) {
  const next = { ...reaction };
  if (typeof input.enabled === "boolean") next.enabled = input.enabled;
  if (typeof input.emoji === "string" && input.emoji.trim()) next.emoji = input.emoji.trim().slice(0, 16);
  if (["bot_replies", "incoming_messages", "both"].includes(input.target)) next.target = input.target;
  if (["all", "admins", "member"].includes(input.targetMode)) next.targetMode = input.targetMode;
  if (Array.isArray(input.targetUserIds)) next.targetUserIds = input.targetUserIds.map(String).slice(0, 10);
  if (Array.isArray(input.targetUserNames)) next.targetUserNames = input.targetUserNames.map(String).slice(0, 10);
  if (typeof input.targetUserId === "string") next.targetUserId = input.targetUserId;
  if (typeof input.targetUserName === "string") next.targetUserName = input.targetUserName;
  if (typeof input.targetThreadID === "string") next.targetThreadID = input.targetThreadID;
  if (Number.isFinite(Number(input.probability))) next.probability = Math.max(0, Math.min(100, Number(input.probability)));
  if (Number.isFinite(Number(input.cooldownSeconds))) next.cooldownSeconds = Math.max(0, Number(input.cooldownSeconds));
  return next;
}

function isQuietNow(groupSettings = {}) {
  const start = String(groupSettings.quietStart || "").trim();
  const end = String(groupSettings.quietEnd || "").trim();
  if (!start || !end) return false;
  const now = new Date();
  const ph = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Manila" }));
  const minutes = ph.getHours() * 60 + ph.getMinutes();
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  if (![sh, sm, eh, em].every(Number.isFinite)) return false;
  const startMin = sh * 60 + sm, endMin = eh * 60 + em;
  return startMin <= endMin
    ? minutes >= startMin && minutes < endMin
    : minutes >= startMin || minutes < endMin;
}

const reactionHistory = new Map();
function shouldReact(threadID, target) {
  if (!reaction.enabled) return false;
  if (reaction.target !== target && reaction.target !== "both") return false;
  if (Math.random() * 100 >= reaction.probability) return false;
  const key = String(threadID);
  const last = reactionHistory.get(key) || 0;
  if (Date.now() - last < reaction.cooldownSeconds * 1000) return false;
  reactionHistory.set(key, Date.now());
  return true;
}

module.exports = {
  getGroupSettings, updateGroup, getSettings,
  getReactionSettings, setRuntimeReaction, sanitizeReaction,
  isQuietNow, shouldReact
};
