"use strict";

function createSpamMode({ getApi, sendMessage, isAuthorized = () => true } = {}) {
  const runs = new Map();

  function stop(threadID) {
    const key = String(threadID || "").trim();
    const run = runs.get(key);
    if (!run) return { stopped: false, threadID: key };
    run.stopped = true;
    if (run.timer) clearTimeout(run.timer);
    runs.delete(key);
    return { stopped: true, threadID: key, sent: run.sent };
  }

  function stopAll(reason = "manual") {
    for (const key of [...runs.keys()]) stop(key);
  }

  function getStatus() {
    return [...runs.values()].map(run => ({
      threadID: run.threadID,
      intervalSeconds: run.intervalSeconds,
      totalMessages: run.totalMessages,
      mode: run.mode,
      loops: run.loops,
      sent: run.sent
    }));
  }

  async function tick(run) {
    if (run.stopped || runs.get(run.threadID) !== run) return;
    if (!isAuthorized()) return stop(run.threadID);
    const api = typeof getApi === "function" ? getApi() : null;
    if (!api || typeof sendMessage !== "function") return stop(run.threadID);
    try {
      const message = run.messages[run.sent % run.messages.length];
      await sendMessage(api, String(message).trim(), run.threadID);
      if (run.stopped || runs.get(run.threadID) !== run) return;
      run.sent++;
      if (run.sent >= run.totalMessages) return stop(run.threadID);
      run.timer = setTimeout(() => tick(run), run.intervalSeconds * 1000);
      run.timer.unref?.();
    } catch (error) {
      stop(run.threadID);
    }
  }

  function start(input = {}) {
    const threadID = String(input.threadID || "").trim();
    const rawMessage = String(input.message || "").trim();
    const intervalSeconds = Number(input.intervalSeconds);
    if (!threadID || !rawMessage || intervalSeconds < 2) throw new Error("Invalid spam settings.");
    if (runs.has(threadID)) throw new Error("Spam Mode is already running in this group.");

    const lines = rawMessage.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const messages = lines.length > 0 ? lines.map(l => l.replace(/^\d+[.)]\s*/, "")) : [rawMessage];
    const totalMessages = messages.length * (Number(input.loops) || 1);

    const run = { threadID, messages, totalMessages, intervalSeconds, loops: Number(input.loops) || 1, sent: 0, stopped: false, timer: null };
    runs.set(threadID, run);
    run.timer = setTimeout(() => tick(run), intervalSeconds * 1000);
    run.timer.unref?.();
    return { threadID, intervalSeconds, totalMessages, mode: "sequence", loops: run.loops };
  }

  return { start, stop, stopAll, getStatus };
}
module.exports = { createSpamMode };
