"use strict";
const { BANAT_SHORTHANDS } = require("./banat-abbreviations");
const { chooseSocialResponse, socialTimingMultiplier } = require("./banat-social");
const { humanize } = require("./human-mimic");
const { calculateHumanDelay } = require("./human-delay");
const { startTyping, stopTyping } = require("./human-typing");

const REPLY_DELAY_MS = Math.max(0, Number(process.env.BANAT_REPLY_DELAY_MS || 900));
const MAX_DELAY_MS = Math.max(2500, Number(process.env.BANAT_MAX_HUMAN_DELAY_MS || 6500));
const state = new Map();

function createHumanContext(threadID, incomingText = "") {
  const key = String(threadID || "unknown"), now = Date.now(), prev = state.get(key);
  const within = prev && now - prev.at < 45_000;
  const recentMessages = within ? Math.min(8, Number(prev.count || 0) + 1) : 1;
  const incomingWords = String(incomingText).trim().split(/\s+/).filter(Boolean).length;
  const mode = recentMessages >= 5 ? "rushed" : recentMessages >= 3 ? "normal" : "chill";
  const momentum = Math.max(1, recentMessages + (incomingWords >= 18 ? 1 : 0) + (incomingWords >= 35 ? 1 : 0));
  state.set(key, { at: now, count: recentMessages });
  return { threadID: key, incomingText: String(incomingText), incomingWords, incomingChars: String(incomingText).length, recentMessages, momentum, mode, elapsedSincePreviousMs: within ? now - prev.at : null };
}

function resolveReplyDelayMs(configuredDelay, fallbackDelay) {
  const configured = configuredDelay == null ? Number.NaN : Number(configuredDelay);
  if (Number.isFinite(configured)) return Math.max(0, configured);
  return Math.max(120, Number(fallbackDelay) || REPLY_DELAY_MS);
}

function prepareBanatReply(threadID, message, incomingText = "") {
  const context = createHumanContext(threadID, incomingText);
  const text = humanize(message, {
    abbreviations: BANAT_SHORTHANDS,
    abbreviationRate: Number(process.env.BANAT_SHORTHAND_RATE || 0.035),
    typoRate: Number(process.env.BANAT_TYPO_RATE || 0.085),
    caseVariationRate: Number(process.env.BANAT_CASE_VARIATION_RATE || 0.035),
    spaceVariationRate: Number(process.env.BANAT_SPACE_SLIP_RATE || 0.018),
    abbreviate: true, typos: true, punctuation: true
  });
  const social = chooseSocialResponse(incomingText, text, context);
  const timing = calculateHumanDelay(text, { ...context, social }, {
    max: MAX_DELAY_MS, maxTypingMs: MAX_DELAY_MS,
    minCps: Math.max(5, Number(process.env.BANAT_MIN_CPS || 16)),
    maxCps: Math.max(5, Number(process.env.BANAT_MAX_CPS || 28)),
    hesitationRate: Number(process.env.BANAT_HESITATION_RATE || 0.11)
  });
  const multiplier = socialTimingMultiplier(social);
  return {
    text,
    reactionMs: Math.max(120, Math.min(1800, (Number(timing.reactionMs) || REPLY_DELAY_MS) * multiplier)),
    typingMs: Math.max(350, Math.min(MAX_DELAY_MS, (Number(timing.typingMs) || 350) * multiplier))
  };
}

function sendBanatReplyWithTyping(api, message, threadID, replyToMessageID = null, dependencies = {}) {
  const send = dependencies.trafficSendMessage;
  if (typeof send !== "function") return Promise.resolve(false);
  const prepared = prepareBanatReply(threadID, message, dependencies.incomingText || "");
  const delay = resolveReplyDelayMs(dependencies.replyDelayMs, prepared.reactionMs);
  return new Promise(resolve => {
    setTimeout(() => {
      if (dependencies.typingEnabled !== false) startTyping(api, threadID);
      setTimeout(() => {
        let done = false;
        const finish = ok => {
          if (done) return;
          done = true;
          if (dependencies.typingEnabled !== false) stopTyping(api, threadID);
          resolve(ok);
        };
        try {
          send(api, prepared.text, threadID, (err) => {
            if (err) { console.error("[BANAT] send failed:", err?.message || err); finish(false); return; }
            finish(true);
          }, replyToMessageID || null);
        } catch (e) { console.error("[BANAT] reply error:", e); finish(false); }
      }, prepared.typingMs);
    }, delay);
  });
}

module.exports = {
  BANAT_REPLY_DELAY_MS: REPLY_DELAY_MS,
  BANAT_MAX_HUMAN_DELAY_MS: MAX_DELAY_MS,
  prepareBanatReply,
  resolveReplyDelayMs,
  sendBanatReplyWithTyping
};
