"use strict";
const { Readable } = require("stream");
let Pool = null;
try { ({ Pool } = require("pg")); } catch (_) {}

function invoke(api, method, args) {
  return new Promise((resolve, reject) => {
    if (!api || typeof api[method] !== "function") return reject(new Error("API unavailable"));
    try {
      api[method](...args, (err, res) => err ? reject(err) : resolve(res));
    } catch (e) { reject(e); }
  });
}

function createRaidMode(options = {}) {
  const env = process.env;
  const databaseUrl = env.ECLIPSE_RAID_DATABASE_URL || env.DATABASE_URL || "";
  const apiGetter = options.getApi || (() => null);
  let initialized = false;
  let pool = null;
  let theme = null;
  let imageBuffer = null;

  if (!Pool || !databaseUrl) {
    return {
      initialize: async () => false,
      start: () => {}, stop: () => {},
      activate: async () => { throw new Error("Raid Mode needs a DATABASE_URL."); },
      emergencyStop: async () => ({}), repairGroup: async () => ({}),
      handleEvent: async () => {},
      saveTheme: async (t) => { theme = t; return t; },
      uploadImage: async (buf, type) => { imageBuffer = buf; return { ok: true }; },
      getImage: async () => ({ buffer: imageBuffer, contentType: "image/jpeg" }),
      getStatus: async () => ({ available: false, active: false, groups: [], theme }),
      getGroups: async () => [],
      close: async () => {},
      isInitialized: () => false
    };
  }

  pool = new Pool({ connectionString: databaseUrl, ssl: /sslmode=require/i.test(databaseUrl) ? { rejectUnauthorized: false } : undefined });

  async function initialize() {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS raid_theme (id INT PRIMARY KEY DEFAULT 1, title TEXT, nickname TEXT, image BYTEA);
        CREATE TABLE IF NOT EXISTS raid_groups (thread_id TEXT PRIMARY KEY, enabled BOOLEAN DEFAULT TRUE);
      `);
      initialized = true;
      return true;
    } catch (e) { return false; }
  }

  async function getStatus() {
    if (!initialized) return { available: false };
    const themeRes = await pool.query("SELECT title, nickname, image IS NOT NULL as has_img FROM raid_theme WHERE id=1");
    const groupsRes = await pool.query("SELECT thread_id, enabled FROM raid_groups");
    const t = themeRes.rows[0];
    return {
      available: true, active: groupsRes.rows.some(r => r.enabled),
      theme: t ? { groupTitle: t.title, nickname: t.nickname, hasImage: t.has_img } : null,
      groups: groupsRes.rows.map(r => ({ threadID: r.thread_id, enabled: r.enabled, status: "active" }))
    };
  }

  async function saveTheme(input) {
    theme = input;
    if (initialized) await pool.query("INSERT INTO raid_theme (id, title, nickname) VALUES (1, $1, $2) ON CONFLICT (id) DO UPDATE SET title=$1, nickname=$2", [input.groupTitle, input.nickname]);
    return theme;
  }

  async function uploadImage(buf) {
    imageBuffer = buf;
    if (initialized) await pool.query("INSERT INTO raid_theme (id, image) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET image=$1", [buf]);
    return { ok: true };
  }

  async function getImage() {
    if (initialized) {
      const res = await pool.query("SELECT image FROM raid_theme WHERE id=1");
      if (res.rows[0]?.image) return { buffer: res.rows[0].image, contentType: "image/jpeg" };
    }
    return { buffer: imageBuffer, contentType: "image/jpeg" };
  }

  async function applyRaid(threadID) {
    const api = apiGetter();
    if (!api) return;
    if (!theme || !theme.groupTitle || !theme.nickname) return;
    const img = await getImage();

    try { await invoke(api, "setTitle", [theme.groupTitle, String(threadID)]); } catch (_) {}
    try {
      const info = await invoke(api, "getThreadInfo", [String(threadID)]);
      const ids = info?.participantIDs || [];
      for (const id of ids) {
        try { await invoke(api, "changeNickname", [theme.nickname, String(threadID), String(id)]); } catch (_) {}
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (_) {}
    if (img.buffer) {
      try { await invoke(api, "changeGroupImage", [Readable.from([img.buffer]), String(threadID)]); } catch (_) {}
    }
  }

  return {
    initialize,
    start: () => {},
    stop: () => {},
    isInitialized: () => initialized,
    getStatus,
    saveTheme,
    uploadImage,
    getImage,
    activate: async (input) => {
      if (initialized) {
        for (const id of input.threadIDs || []) {
          await pool.query("INSERT INTO raid_groups (thread_id) VALUES ($1) ON CONFLICT DO NOTHING", [String(id)]);
          applyRaid(id).catch(() => {});
        }
      }
      return { activated: (input.threadIDs || []).length };
    },
    emergencyStop: async () => { if (initialized) await pool.query("UPDATE raid_groups SET enabled=FALSE"); return { stopped: 1 }; },
    repairGroup: async (id) => applyRaid(id),
    handleEvent: async (event) => { if (event.threadID) applyRaid(event.threadID).catch(() => {}); },
    getGroups: async () => [],
    close: async () => { if (pool) await pool.end(); }
  };
}
module.exports = { createRaidMode };
