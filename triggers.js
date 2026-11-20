"use strict";
const { rememberBanatReply, pickBanatReply } = require("./banat-memory");

// ────────────────────────────────────────────────────────────────
// PASTE YOUR EXISTING `groups` ARRAY HERE — UNCHANGED.
// Copy the `const groups = [ … ];` block verbatim from your
// current triggers.js. Do not retype the banat lines.
// ────────────────────────────────────────────────────────────────
const groups = [
  // >>> PASTE YOUR EXISTING ARRAY HERE <<<
];

function normalize(text) { return String(text || "").toLowerCase().replace(/\s+/g, " ").trim(); }

function findGroups(body) {
  const text = normalize(body);
  return groups.filter(group => group.triggers.some(trigger => {
    const t = String(trigger).toLowerCase();
    if (t.length <= 4) {
      const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\b`, "i").test(text);
    }
    return text.includes(t);
  }));
}

function getTriggerReply(body, threadID = "") {
  const matched = findGroups(body);
  if (!matched.length) return null;
  const group = matched[Math.floor(Math.random() * matched.length)];
  const reply = pickBanatReply(threadID, group.replies);
  if (reply) rememberBanatReply(threadID, reply);
  return reply;
}

function getBanatConversationReply(body, threadID = "") {
  const direct = getTriggerReply(body, threadID);
  if (direct) return direct;
  const fallback = groups.flatMap(g => g.replies);
  const reply = pickBanatReply(threadID, fallback) ||
    fallback[Math.floor(Math.random() * fallback.length)] || null;
  if (reply) rememberBanatReply(threadID, reply);
  return reply;
}

module.exports = { groups, getTriggerReply, getBanatConversationReply };
