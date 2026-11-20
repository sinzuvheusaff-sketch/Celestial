"use strict";

const groups = new Map();
let reaction = { enabled: false, emoji: "😆", target: "bot_replies", targetMode: "all" };

function getGroupSettings(threadID) {
  const key = String(threadID);
  if (!groups.has(key)) {
    groups.set(key, { banatMode: "inherit", typingEnabled: true, replyDelayMs: null, cooldownMs: null, quietStart: "", quietEnd: "" });
  }
  return groups.get(key);
}

function updateGroup(threadID, input = {}) {
  const current = getGroupSettings(threadID);
  const next = { ...current };
  if (["on", "off", "inherit"].includes(input.banatMode)) next.banatMode = input.banatMode;
  if (typeof input.typingEnabled === "boolean") next.typingEnabled = input.typingEnabled;
  if (input.replyDelayMs === null || Number.isFinite(Number(input.replyDelayMs))) next.replyDelayMs = input.replyDelayMs === null ? null : Number(input.replyDelayMs);
  if (input.cooldownMs === null || Number.isFinite(Number(input.cooldownMs))) next.cooldownMs = input.cooldownMs === null ? null : Number(input.cooldownMs);
  groups.set(String(threadID), next);
  return next;
}

function getSettings() {
  const map = {};
  for (const [k, v] of groups) map[k] = v;
  return { groups: map, reaction };
}

function getReactionSettings() { return { ...reaction }; }
function setRuntimeReaction(next) { if (next) reaction = { ...reaction, ...next }; return reaction; }
function sanitizeReaction(r) { return r; }
function isQuietNow() { return false; }
function shouldReact() { return false; }

module.exports = { getGroupSettings, updateGroup, getSettings, getReactionSettings, setRuntimeReaction, sanitizeReaction, isQuietNow, shouldReact };
