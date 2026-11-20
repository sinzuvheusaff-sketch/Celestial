"use strict";

// CELESTIAL — gray + black dashboard, no key required
const http = require("http");

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CELESTIAL</title>
<style>
:root{color-scheme:dark;--bg:#000000;--panel:#111111;--panel2:#1a1a1a;--line:#2a2a2a;--text:#e6e6e6;--muted:#8a8a8a;--accent:#c0c0c0;--good:#a8a8a8;--bad:#7a7a7a;--warn:#9a9a9a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh}
button,input,select,textarea{font:inherit}
button{cursor:pointer;border:1px solid var(--line);border-radius:10px;padding:10px 14px;background:var(--panel2);color:var(--text);font-weight:650;min-height:42px}
button:disabled{opacity:.45}
.primary{background:var(--accent);color:#000;border-color:transparent}
.danger{border-color:#444;color:#d0d0d0}
.wrap{max-width:820px;margin:auto;padding:24px 16px 60px}
.top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px}
.brand{display:flex;gap:12px;align-items:center}
.logo{display:grid;place-items:center;width:46px;height:46px;border-radius:14px;background:var(--panel2);color:var(--text);font-size:24px;font-weight:900;border:1px solid var(--line)}
.eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);font-weight:800}
h1{font-size:clamp(23px,4vw,32px);margin:3px 0;letter-spacing:-.02em}
h2{font-size:17px;margin:0 0 13px}
.status-pill{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:99px;padding:7px 11px;color:var(--muted);font-size:13px;background:var(--panel)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--warn)}
.dot.good{background:var(--good)}.dot.bad{background:var(--bad)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px;margin-bottom:14px}
.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.metric{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:13px}
.metric label{display:block;color:var(--muted);font-size:12px}
.metric strong{display:block;font-size:21px;margin-top:4px;overflow-wrap:anywhere}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:15px}
.row{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}
.row:last-child{border:0}.row span:first-child{color:var(--muted)}
.hint{font-size:13px;color:var(--muted)}
.field{display:flex;gap:8px;flex-wrap:wrap;align-items:end}
.field input,.field select,.field textarea{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:9px;padding:10px;min-width:0}
.field label{display:grid;gap:5px;font-size:12px;color:var(--muted);font-weight:700}
.log{font:12px/1.6 ui-monospace,SFMono-Regular,monospace;color:#cfcfcf;white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto;background:var(--panel2);padding:12px;border:1px solid var(--line);border-radius:10px}
textarea{width:100%;resize:vertical}
.good{color:var(--good)}.bad{color:var(--bad)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.grid > .card{margin-bottom:0}
.span2{grid-column:span 2}
@media(max-width:700px){.metrics{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.span2{grid-column:auto}.wrap{padding:18px 12px 40px}.card{padding:15px}}
</style></head><body>
<div class="wrap">
<div class="top"><div class="brand"><div class="logo">E</div><div><div class="eyebrow">CELESTIAL</div><h1>Control Room</h1></div></div><span class="status-pill"><i class="dot" id="statusDot"></i><span id="statusText">Connecting…</span></span></div>

<div class="card"><h2>Overview</h2><div class="metrics"><div class="metric"><label>Messenger</label><strong id="connection">—</strong></div><div class="metric"><label>Bot process</label><strong id="process">—</strong></div><div class="metric"><label>Uptime</label><strong id="uptime">—</strong></div></div><div class="actions"><button class="primary" onclick="act('bot/start')">Start</button><button class="danger" onclick="act('bot/stop')">Pause</button><button onclick="refresh()">Refresh</button></div><p class="hint" id="lastUpdated">—</p></div>

<div class="card"><h2>Session</h2><div class="row"><span>Status</span><strong id="sessionStatus">—</strong></div><textarea id="cookie" rows="4" placeholder="Paste cookie header or full JSON appstate" spellcheck="false"></textarea><div class="actions"><button class="primary" onclick="saveCookie()">Save &amp; connect</button><button class="danger" onclick="clearCookie()">Clear</button><button onclick="act('reconnect')">Reconnect</button><button onclick="act('disconnect')">Disconnect</button></div><p class="hint" id="sessionMsg">—</p></div>

<div class="card"><h2>Groups</h2><div class="field"><button onclick="loadGroups()">Load groups</button><select id="threadID" style="flex:1"><option value="">Choose a group…</option></select></div><div class="field"><label>Banat mode <select id="banatMode"><option value="inherit">Use !banat on/off</option><option value="on">Always ON</option><option value="off">Always OFF</option></select></label><label style="flex-direction:row;align-items:center;gap:8px;display:flex"><input id="typing" type="checkbox" checked style="min-height:auto"> Typing indicator</label></div><div class="field"><label>Reply delay (s) <input id="replyDelay" type="number" min="0" step="0.5" placeholder="Human default"></label><label>Cooldown (ms) <input id="cooldown" type="number" min="0" placeholder="Default"></label></div><div class="actions"><button class="primary" onclick="saveGroup()">Save settings</button></div><p class="hint" id="groupMsg">—</p></div>

<div class="grid">
<div class="card"><h2>GC locks</h2><div class="row"><span>Name lock</span><strong id="nameLock">—</strong></div><div class="row"><span>Nickname lock</span><strong id="nickLock">—</strong></div><div class="actions"><button onclick="gcAct('lock-name')">Lock name</button><button onclick="gcAct('unlock-name')">Unlock name</button></div><div class="actions"><button onclick="gcAct('nick-lock')">Lock nicks</button><button onclick="gcAct('nick-unlock')">Unlock nicks</button></div><p class="hint" id="gcMsg">—</p></div>

<div class="card"><h2>Reactions</h2><div class="field"><label style="flex-direction:row;align-items:center;gap:8px;display:flex"><input id="reactionEnabled" type="checkbox" style="min-height:auto"> Enabled</label><label>Emoji <input id="reactionEmoji" maxlength="16" value="😆" style="width:80px"></label></div><div class="field"><label>Target <select id="reactionTarget"><option value="bot_replies">Bot replies</option><option value="incoming_messages">Incoming</option><option value="both">Both</option></select></label><label>Audience <select id="reactionAudience"><option value="all">Everyone</option><option value="admins">Admins</option></select></label></div><div class="actions"><button class="primary" onclick="saveReaction()">Save</button><button onclick="loadReaction()">Reload</button></div><p class="hint" id="reactionMsg">—</p></div>

<div class="card"><h2>Spam Mode</h2><textarea id="spamText" rows="5" placeholder="1. line one&#10;2. line two&#10;3. line three"></textarea><div class="field"><label>Interval (s) <input id="spamInterval" type="number" min="2" max="3600" value="6"></label><label>Loops <input id="spamLoops" type="number" min="1" max="100" value="1"></label></div><div class="actions"><button class="primary" onclick="spamStart()">Start</button><button class="danger" onclick="spamStop()">Stop</button></div><p class="hint" id="spamMsg">—</p></div>

<div class="card"><h2>Raid Mode</h2><div class="row"><span>Status</span><strong id="raidStatus">—</strong></div><div class="field"><label>Group title <input id="raidTitle" maxlength="100" style="width:100%"></label></div><div class="field"><label>Nickname <input id="raidNick" maxlength="64" style="width:100%"></label></div><div class="actions"><button onclick="loadRaid()">Reload</button><button class="primary" onclick="raidSave()">Save theme</button><button class="danger" onclick="raidStop()">Stop</button></div><div class="log" id="raidGroupsList" style="max-height:140px">No groups loaded.</div></div>

<div class="card span2"><h2>Activity</h2><div class="log" id="events">No activity yet.</div><div class="actions"><button onclick="loadEvents()">Reload events</button></div></div>
</div>
</div>
<script>
function $(id){return document.getElementById(id)}
function note(id,msg){var e=$(id);if(e)e.textContent=msg||''}
function fmt(s){s=+s||0;var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return (d?d+'d ':'')+(h?h+'h ':'')+m+'m '+(s%60)+'s'}
function api(path,opts){opts=opts||{};opts.headers=Object.assign({'Content-Type':'application/json'},opts.headers||{});return fetch('/api/dashboard/'+path,Object.assign({},opts,{cache:'no-store'})).then(function(r){return r.json().then(function(j){if(!r.ok||j.ok===false)throw new Error(j.error||('HTTP '+r.status));return j})})}
function act(p){api(p,{method:'POST',body:'{}'}).then(refresh).catch(function(e){note('lastUpdated','Action failed: '+e.message)})}
function saveCookie(){var c=$('cookie').value.trim();if(!c)return note('sessionMsg','Paste a cookie first.');api('session',{method:'POST',body:JSON.stringify({cookie:c})}).then(function(r){$('cookie').value='';note('sessionMsg',r.message||'Saved.');refresh()}).catch(function(e){note('sessionMsg','Save failed: '+e.message)})}
function clearCookie(){if(!confirm('Clear saved session?'))return;api('session',{method:'DELETE'}).then(function(){note('sessionMsg','Cleared.');refresh()}).catch(function(e){note('sessionMsg','Clear failed: '+e.message)})}
function loadGroups(){api('groups').then(function(r){var s=$('threadID');s.innerHTML='<option value="">Choose a group…</option>';for(var i=0;i<(r.groups||[]).length;i++){var g=r.groups[i];var o=document.createElement('option');o.value=g.threadID;o.textContent=g.name+(g.participantCount?' ('+g.participantCount+')':'');s.appendChild(o)}note('groupMsg',(r.groups||[]).length+' group(s) loaded.')}).catch(function(e){note('groupMsg','Load failed: '+e.message)})}
function saveGroup(){var threadID=$('threadID').value;if(!threadID)return note('groupMsg','Choose a group first.');var body={threadID:threadID,banatMode:$('banatMode').value,typingEnabled:$('typing').checked,replyDelayMs:$('replyDelay').value===''?null:Number($('replyDelay').value)*1000,cooldownMs:$('cooldown').value===''?null:Number($('cooldown').value)};api('settings/group',{method:'POST',body:JSON.stringify(body)}).then(function(r){note('groupMsg','Saved. Banat: '+r.group.banatMode);loadEvents()}).catch(function(e){note('groupMsg','Save failed: '+e.message)})}
function gcAct(action){var threadID=$('threadID').value;if(!threadID)return note('gcMsg','Choose a group first.');api('gc/'+action,{method:'POST',body:JSON.stringify({threadID:threadID})}).then(function(r){note('gcMsg',r.message||'Done');loadGc()}).catch(function(e){note('gcMsg','Failed: '+e.message)})}
function loadGc(){api('gc').then(function(r){var g=r.gc||{},n=g.names||{},k=g.nicks||{},t=$('threadID').value;$('nameLock').textContent=n[t]?('ON · '+n[t]):'OFF';$('nickLock').textContent=k[t]?('ON · '+k[t]+' nicks'):'OFF'}).catch(function(){})}
function loadEvents(){api('events').then(function(r){var list=r.events||[];$('events').textContent=list.length?list.slice(0,60).map(function(e){return new Date(e.at).toLocaleTimeString()+' · '+e.type+' · '+e.message}).join('\\n'):'No activity yet.'}).catch(function(e){$('events').textContent='Activity unavailable: '+e.message})}
function loadReaction(){api('reaction').then(function(r){var x=r.reaction||{};$('reactionEnabled').checked=!!x.enabled;$('reactionEmoji').value=x.emoji||'😆';$('reactionTarget').value=x.target||'bot_replies';$('reactionAudience').value=x.targetMode||'all';note('reactionMsg','Loaded.')}).catch(function(e){note('reactionMsg','Load failed: '+e.message)})}
function saveReaction(){var body={enabled:$('reactionEnabled').checked,emoji:$('reactionEmoji').value.trim()||'😆',target:$('reactionTarget').value,targetMode:$('reactionAudience').value};api('reaction',{method:'POST',body:JSON.stringify(body)}).then(function(r){note('reactionMsg','Saved: '+r.reaction.emoji+' · '+r.reaction.targetMode)}).catch(function(e){note('reactionMsg','Save failed: '+e.message)})}
function spamStart(){var threadID=$('threadID').value;if(!threadID)return note('spamMsg','Choose a group first.');var body={threadID:threadID,message:$('spamText').value,intervalSeconds:Number($('spamInterval').value),loops:Number($('spamLoops').value)};api('spam/start',{method:'POST',body:JSON.stringify(body)}).then(function(r){note('spamMsg','Started: '+(r.result.totalMessages||'?')+' msgs every '+r.result.intervalSeconds+'s')}).catch(function(e){note('spamMsg','Start failed: '+e.message)})}
function spamStop(){var threadID=$('threadID').value;if(!threadID)return note('spamMsg','Choose a group first.');api('spam/stop',{method:'POST',body:JSON.stringify({threadID:threadID})}).then(function(r){note('spamMsg',r.result.stopped?'Stopped.':'No active run.')}).catch(function(e){note('spamMsg','Stop failed: '+e.message)})}
function loadRaid(){api('raid/status').then(function(r){var raid=r.raid||{};note('raidStatus',raid.available?'ready':'unavailable'+(raid.error?' · '+raid.error:''));if(raid.theme){$('raidTitle').value=raid.theme.groupTitle||'';$('raidNick').value=raid.theme.nickname||''}var root=$('raidGroupsList');root.innerHTML='';(raid.groups||[]).forEach(function(g){var row=document.createElement('div');row.textContent=g.threadID+' · '+(g.enabled?'ON':'OFF')+' · '+g.status;root.appendChild(row)})}).catch(function(e){note('raidStatus','Load failed: '+e.message)})}
function raidSave(){api('raid/theme',{method:'POST',body:JSON.stringify({groupTitle:$('raidTitle').value,nickname:$('raidNick').value})}).then(function(){note('raidStatus','Theme saved.');loadRaid()}).catch(function(e){note('raidStatus','Save failed: '+e.message)})}
function raidStop(){if(!confirm('Emergency stop Raid Mode?'))return;api('raid/emergency-stop',{method:'POST',body:'{}'}).then(function(){note('raidStatus','Stopped.');loadRaid()}).catch(function(e){note('raidStatus','Stop failed: '+e.message)})}
function refresh(){api('status').then(function(s){var on=!!s.facebook_connected;$('connection').textContent=on?'ONLINE':'OFFLINE';$('connection').className=on?'good':'bad';var run=s.bot_running!==undefined?s.bot_running:on;$('process').textContent=run?'RUNNING':'PAUSED';$('process').className=run?'good':'bad';$('uptime').textContent=fmt(s.uptime_seconds);$('statusDot').className='dot '+(on?'good':'bad');$('statusText').textContent=on?'Messenger connected':'API online · session offline';$('lastUpdated').textContent=(s.login_error||s.last_listener_error||(s.last_message_at?'Last event: '+new Date(s.last_message_at).toLocaleString():'No Messenger event yet'))+' · Updated '+new Date().toLocaleTimeString();api('session').then(function(sr){var ss=sr.session||{};$('sessionStatus').textContent=ss.configured?'Saved in memory':'Not saved';note('sessionMsg',ss.configured?'Session held in memory. Cleared on restart.':'No dashboard session; FB_COOKIES/FB_APPSTATE may still be used.')}).catch(function(){});loadGc()}).catch(function(e){$('statusText').textContent='Dashboard unavailable';note('lastUpdated','Error: '+e.message)})}
refresh();loadReaction();loadRaid();setInterval(refresh,15000);
</script></body></html>`;

module.exports = function startDashboardApi(port, getStatus, controls = {}) {
  const events = [];
  const log = (type, message) => {
    events.unshift({ type, message, at: new Date().toISOString() });
    if (events.length > 200) events.length = 200;
  };

  const conn = { since: null, last_connected: null, last_disconnected: null, was: false };
  const connWatch = setInterval(() => {
    let on = false;
    try { on = Boolean(getStatus().facebook_connected); } catch (_) {}
    if (on && !conn.was) { conn.since = Date.now(); conn.last_connected = new Date().toISOString(); log("connection", "Messenger connected"); }
    else if (!on && conn.was) { conn.since = null; conn.last_disconnected = new Date().toISOString(); log("connection", "Messenger disconnected"); }
    conn.was = on;
  }, 2000);
  connWatch.unref();

  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 200000) { reject(new Error("Body too large")); req.destroy(); } });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    const url = new URL(req.url || "/", "http://localhost");

    if (url.pathname === "/health" || url.pathname === "/ping") {
      return send(res, 200, { ok: true, service: "celestial", uptime: Math.floor(process.uptime()) });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(PAGE);
    }
    if (!url.pathname.startsWith("/api/dashboard/")) return send(res, 404, { ok: false, error: "Not found" });

    const p = url.pathname;
    const isGet = req.method === "GET";
    const isPost = req.method === "POST";
    const isDelete = req.method === "DELETE";

    try {
      if (isGet && p === "/api/dashboard/status") {
        return send(res, 200, Object.assign({}, getStatus(), {
          bot_uptime_seconds: conn.since ? Math.floor((Date.now() - conn.since) / 1000) : 0,
          last_connected: conn.last_connected,
          last_disconnected: conn.last_disconnected
        }));
      }
      if (isGet && p === "/api/dashboard/session") {
        const status = typeof controls.getSessionStatus === "function" ? controls.getSessionStatus() : { configured: false };
        return send(res, 200, { ok: true, session: status });
      }
      if (isPost && p === "/api/dashboard/session") {
        let body;
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch (_) { return send(res, 400, { ok: false, error: "Invalid request" }); }
        const raw = String(body.cookie || "").trim();
        if (!raw) return send(res, 400, { ok: false, error: "Cookie is required" });
        if (typeof controls.connectSession === "function") {
          try { const r = await controls.connectSession(raw, {}); log("session", "Cookie saved"); return send(res, 200, Object.assign({ ok: true, message: "Session saved; connecting…" }, r || {})); }
          catch (e) { return send(res, 500, { ok: false, error: "Saved but connect failed: " + e.message }); }
        }
        return send(res, 501, { ok: false, error: "connectSession not wired" });
      }
      if (isDelete && p === "/api/dashboard/session") {
        if (typeof controls.disconnect === "function") await controls.disconnect();
        log("session", "Session cleared");
        return send(res, 200, { ok: true });
      }
      if (isPost && p === "/api/dashboard/reconnect") {
        if (typeof controls.reconnect !== "function") return send(res, 501, { ok: false, error: "reconnect not wired" });
        await controls.reconnect(); log("session", "Reconnect requested");
        return send(res, 200, { ok: true });
      }
      if (isPost && p === "/api/dashboard/disconnect") {
        if (typeof controls.disconnect !== "function") return send(res, 501, { ok: false, error: "disconnect not wired" });
        await controls.disconnect(); log("session", "Disconnected");
        return send(res, 200, { ok: true });
      }
      if (isGet && p === "/api/dashboard/events") {
        const extra = typeof controls.getEvents === "function" ? controls.getEvents() : [];
        const merged = [...events, ...extra].sort((a, b) => new Date(b.at) - new Date(a.at));
        return send(res, 200, { ok: true, events: merged.slice(0, 80) });
      }
      if (isGet && p === "/api/dashboard/groups") {
        if (typeof controls.getGroups !== "function") return send(res, 501, { ok: false, error: "Group list unavailable" });
        try { return send(res, 200, { ok: true, groups: await controls.getGroups() }); }
        catch (e) { return send(res, 400, { ok: false, error: e.message }); }
      }
      if (isGet && p === "/api/dashboard/group-members") {
        if (typeof controls.getGroupMembers !== "function") return send(res, 501, { ok: false, error: "Member list unavailable" });
        const threadID = String(url.searchParams.get("threadID") || "").trim();
        if (!threadID) return send(res, 400, { ok: false, error: "threadID is required" });
        try { return send(res, 200, { ok: true, members: await controls.getGroupMembers(threadID) }); }
        catch (e) { return send(res, 400, { ok: false, error: e.message }); }
      }
      if (isGet && p === "/api/dashboard/settings") {
        const settings = typeof controls.getSettings === "function" ? await controls.getSettings() : {};
        return send(res, 200, { ok: true, settings });
      }
      if (isPost && p === "/api/dashboard/settings/group") {
        let body;
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch (_) { return send(res, 400, { ok: false, error: "Invalid request" }); }
        if (typeof controls.updateGroup !== "function") return send(res, 501, { ok: false, error: "updateGroup not wired" });
        try { const group = await controls.updateGroup(String(body.threadID || ""), body); log("settings", `group ${body.threadID} saved`); return send(res, 200, { ok: true, group }); }
        catch (e) { return send(res, 400, { ok: false, error: e.message }); }
      }
      if (isGet && p === "/api/dashboard/gc") {
        return send(res, 200, { ok: true, gc: typeof controls.gcState === "function" ? controls.gcState() : { names: {}, nicks: {} } });
      }
      if (isPost && p.startsWith("/api/dashboard/gc/")) {
        if (typeof controls.gcAction !== "function") return send(res, 501, { ok: false, error: "GC tools unavailable" });
        let body;
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch (_) { return send(res, 400, { ok: false, error: "Invalid request" }); }
        const action = p.slice("/api/dashboard/gc/".length);
        try { const r = await controls.gcAction(action, body); log("gc", action + " " + (body.threadID || "")); return send(res, 200, { ok: true, message: r && r.message }); }
        catch (e) { return send(res, 400, { ok: false, error: e.message }); }
      }
      if (isGet && p === "/api/dashboard/reaction") {
        const reaction = typeof controls.getReaction === "function" ? await controls.getReaction() : {};
        return send(res, 200, { ok: true, reaction });
      }
      if (isPost && p === "/api/dashboard/reaction") {
        let body;
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch (_) { return send(res, 400, { ok: false, error: "Invalid request" }); }
        if (typeof controls.updateReaction !== "function") return send(res, 501, { ok: false, error: "updateReaction not wired" });
        try { const reaction = await controls.updateReaction(body); log("settings", `reaction ${reaction.emoji}`); return send(res, 200, { ok: true, reaction }); }
        catch (e) { return send(res, 400, { ok: false, error: e.message }); }
      }
      if (isGet && p === "/api/dashboard/spam/status") {
        const runs = typeof controls.spamMode?.getStatus === "function" ? controls.spamMode.getStatus() : [];
        return send(res, 200, { ok: true, runs });
      }
      if (isPost && p === "/api/dashboard/spam/start") {
        let body;
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch (_) { return send(res, 400, { ok: false, error: "Invalid request" }); }
        if (typeof controls.spamMode?.start !== "function") return send(res, 501, { ok: false, error: "spamMode not wired" });
        try { const result = await controls.spamMode.start(body); log("spam", `start ${body.threadID}`); return send(res, 200, { ok: true, result }); }
        catch (e) { return send(res, 400, { ok: false, error: e.message }); }
      }
      if (isPost && p === "/api/dashboard/spam/stop") {
        let body;
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch (_) { return send(res, 400, { ok: false, error: "Invalid request" }); }
        if (typeof controls.spamMode?.stop !== "function") return send(res, 501, { ok: false, error: "spamMode not wired" });
        const result = controls.spamMode.stop(String(body.threadID || ""));
        log("spam", `stop ${body.threadID}`);
        return send(res, 200, { ok: true, result });
      }
      if (isGet && p === "/api/dashboard/raid/status") {
        if (typeof controls.raidMode?.getStatus !== "function") return send(res, 200, { ok: true, raid: { available: false } });
        try { const status = await controls.raidMode.getStatus(); return send(res, 200, { ok: true, raid: status }); }
        catch (e) { return send(res, 400, { ok: false, error: e.message }); }
      }
      if (isPost && p === "/api/dashboard/raid/theme") {
        let body;
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch (_) { return send(res, 400, { ok: false, error: "Invalid request" }); }
        try { const theme = await controls.raidMode.saveTheme(body); return send(res, 200, { ok: true, theme }); }
        catch (e) { return send(res, 400, { ok: false, error: e.message }); }
      }
      if (isPost && p === "/api/dashboard/raid/emergency-stop") {
        try { const result = await controls.raidMode.emergencyStop(); log("raid", "emergency stop"); return send(res, 200, { ok: true, result }); }
        catch (e) { return send(res, 400, { ok: false, error: e.message }); }
      }
      if (isPost && p === "/api/dashboard/bot/start") {
        if (typeof controls.setPaused === "function") controls.setPaused(false);
        log("bot", "Bot started");
        return send(res, 200, { ok: true });
      }
      if (isPost && p === "/api/dashboard/bot/stop") {
        if (typeof controls.setPaused === "function") controls.setPaused(true);
        log("bot", "Bot paused");
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { ok: false, error: "Unsupported endpoint" });
    } catch (e) { return send(res, 500, { ok: false, error: e.message }); }
  });

  server.on("error", (e) => console.error("[CELESTIAL] server error:", e?.message || e));
  server.keepAliveTimeout = 65000;
  server.listen(port, () => console.log("[CELESTIAL] dashboard on :" + port));
  server.on("close", () => clearInterval(connWatch));
  return server;
};
