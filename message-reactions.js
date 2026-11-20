"use strict";

function extractMessageID(info) {
  if (!info) return null;
  if (typeof info === "string") return info;
  return info.messageID || info.messageId || info.id || null;
}

function dispatchMessageReaction(api, emoji, messageID, threadID, options = {}) {
  if (!api || !emoji || !messageID || !threadID) return false;
  const onStatus = typeof options.onStatus === "function" ? options.onStatus : () => {};
  try {
    if (typeof api.setMessageReactionMqtt === "function") {
      api.setMessageReactionMqtt(emoji, String(messageID), String(threadID), (err) => {
        if (err) onStatus("failed", { method: "mqtt", error: err });
        else onStatus("submitted", { method: "mqtt" });
      });
      return true;
    }
    if (typeof api.setMessageReaction === "function") {
      api.setMessageReaction(emoji, String(messageID), (err) => {
        if (err) onStatus("failed", { method: "http", error: err });
        else onStatus("submitted", { method: "http" });
      }, true);
      return true;
    }
    onStatus("failed", { error: new Error("No reaction API available") });
  } catch (error) {
    onStatus("failed", { error });
  }
  return false;
}

module.exports = { extractMessageID, dispatchMessageReaction };
