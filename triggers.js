"use strict";

/**
 * triggers.js — minimal build
 * Every message that reaches the bot replies with exactly: ops
 * No random pools, no no-repeat bag, no per-trigger matching.
 */

const REPLY = "ops";

function getTriggerReply() {
  return REPLY;
}

function getBanatConversationReply() {
  return REPLY;
}

// Kept so any code that imported `groups` doesn't crash.
const groups = [];

module.exports = { groups, getTriggerReply, getBanatConversationReply };
