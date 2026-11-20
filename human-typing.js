"use strict";
const ENABLED = !/^(false|0|no|off)$/i.test(String(process.env.TYPING_ENABLED || "true"));
const activeStates = new WeakMap();
const REFRESH_MS = 25000;
function getThreadStates(api) {
  let states = activeStates.get(api);
  if (!states) { states = new Map(); activeStates.set(api, states); }
  return states;
}
function requestTyping(api, active, threadID) {
  const key = String(threadID);
  try {
    if (typeof api.sendTypingIndicator === "function") {
      api.sendTypingIndicator(Boolean(active), key, err => {
        if (err) console.warn("[TYPING] indicator error:", err?.message || err);
      });
      return true;
    }
    if (typeof api.sendTyping === "function") {
      api.sendTyping(key, Boolean(active));
      return true;
    }
  } catch (error) { console.warn("[TYPING] request failed:", error?.message || error); }
  return false;
}
function refreshTyping(api, key, state) {
  if (state.stopped || getThreadStates(api).get(key) !== state) return;
  requestTyping(api, true, key);
  state.timer = setTimeout(() => refreshTyping(api, key, state), REFRESH_MS);
  if (typeof state.timer?.unref === "function") state.timer.unref();
}
function startTyping(api, threadID) {
  if (!ENABLED || !api || !threadID) return false;
  const key = String(threadID);
  try {
    const states = getThreadStates(api);
    const existing = states.get(key);
    if (existing && !existing.stopped) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = setTimeout(() => refreshTyping(api, key, existing), REFRESH_MS);
      if (typeof existing.timer?.unref === "function") existing.timer.unref();
      return true;
    }
    const state = { timer: null, stopped: false };
    states.set(key, state);
    if (!requestTyping(api, true, key)) { states.delete(key); return false; }
    state.timer = setTimeout(() => refreshTyping(api, key, state), REFRESH_MS);
    if (typeof state.timer?.unref === "function") state.timer.unref();
    return true;
  } catch (error) { console.warn("[TYPING] start failed:", error?.message || error); return false; }
}
function stopTyping(api, threadID) {
  if (!api || !threadID) return false;
  const key = String(threadID);
  try {
    const states = activeStates.get(api);
    const state = states?.get(key);
    if (state) {
      state.stopped = true;
      if (state.timer) clearTimeout(state.timer);
      states.delete(key);
      return requestTyping(api, false, key);
    }
    if (typeof api.sendTyping === "function" && typeof api.sendTypingIndicator !== "function") {
      return requestTyping(api, false, key);
    }
    return false;
  } catch (error) { console.warn("[TYPING] stop failed:", error?.message || error); return false; }
}
module.exports = { startTyping, stopTyping };
