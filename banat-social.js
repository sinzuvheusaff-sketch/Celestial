"use strict";
const REACTION_WORDS = new Set([
  "lol","lmao","lmfao","haha","hahaha","hehe","fr","real","damn","wtf","wth",
  "bro","bruh","nah","😭","💀","🤣",
  "💬","👎","👀","💣","💨","👻","😴","😂","😪","🤔","🤐","💤","💫","🤖"
]);
function normalize(text) {
  return String(text || "").toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
}
function countWords(text) { return normalize(text).split(" ").filter(Boolean).length; }
function incomingEnergy(text) {
  const value = String(text || "");
  let score = 0;
  if (/[!?]{2,}/.test(value)) score += 1;
  if (/\b(?:HAHA+|LMAO+|LMFAO+)\b/i.test(value)) score += 1;
  if (/[\u{1F300}-\u{1FAFF}]/u.test(value)) score += 1;
  if (/\b(?:bro|bruh|wtf|nah)\b/i.test(value)) score += 1;
  if (value === value.toUpperCase() && /[A-Z]/.test(value)) score += 1;
  return Math.min(5, score);
}
function isQuestion(text) {
  return /\?|\b(?:why|what|how|who|where|when|bakit|ano|paano|sino|saan|kelan)\b/i.test(normalize(text));
}
function isReaction(text) {
  const value = normalize(text);
  const words = value.split(" ").filter(Boolean);
  return words.length <= 3 && words.length > 0 &&
    (words.every(w => REACTION_WORDS.has(w)) || /^[!?😭💀🤣.]+$/u.test(value));
}
function chooseSocialResponse(incomingText, candidateText = "", context = {}) {
  const incoming = String(incomingText || "").trim();
  const candidate = String(candidateText || "").trim();
  const words = countWords(incoming);
  const energy = incomingEnergy(incoming);
  const question = isQuestion(incoming);
  const reaction = isReaction(incoming);
  const momentum = Number(context.momentum || 1);
  let type = "tease";
  if (reaction) type = "reaction";
  else if (question) type = "answer";
  else if (momentum >= 4 && words <= 8) type = "short";
  else if (energy >= 3) type = "react";
  else if (/\b(?:agree|tama|true|real|same|exactly|oo|yes|yep|yup)\b/i.test(incoming)) type = "agree";
  else if (/\b(?:idk|i don't know|di ko alam|wala|nothing|nvm|never mind)\b/i.test(incoming)) type = "deflect";
  else if (candidate && /\?\s*$/.test(candidate)) type = "ask";
  else if (context.recentMessages >= 3 && words >= 12) type = "callback";
  return { type, energy, momentum, incomingWords: words };
}
function socialTimingMultiplier(decision) {
  switch (decision?.type) {
    case "reaction": return 0.55;
    case "react": return 0.75;
    case "short": return 0.72;
    case "answer": return 1.05;
    case "ask": return 1.02;
    case "callback": return 1.08;
    case "deflect": return 0.82;
    case "agree": return 0.78;
    default: return 1;
  }
}
module.exports = { chooseSocialResponse, socialTimingMultiplier };
