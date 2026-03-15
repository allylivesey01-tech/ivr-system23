require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");

// ════════════════════════════════════════════════════════════════════════════
//  ⚡ EMERGENCY BYPASS
//  If you ever get locked out because of IP restriction, go to GitHub,
//  edit this file, change false to true below, save (commit).
//  Render will redeploy in ~2 minutes and you can log in from any IP.
//  After fixing your IP settings, come back and change it to false again.
const IP_BYPASS = false;
// ════════════════════════════════════════════════════════════════════════════

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

// Auto-detect and remember the public server URL from incoming requests
let detectedBaseUrl = "";
function getPublicUrl(req) {
  if (detectedBaseUrl) return detectedBaseUrl;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host  = req.headers["x-forwarded-host"] || req.headers.host || "";
  if (host) { detectedBaseUrl = proto + "://" + host; }
  return detectedBaseUrl;
}

// ── Upstash Redis persistent storage (HTTP — no driver, works everywhere) ────
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

// In-memory cache so reads are instant after first load
const memStore = {};

async function storeGet(key) {
  // Always return from cache first (instant)
  if (memStore[key] !== undefined) return memStore[key];
  // Then try Redis
  if (!REDIS_URL) return null;
  try {
    const r = await fetch(REDIS_URL + "/get/" + encodeURIComponent(key), {
      headers: { Authorization: "Bearer " + REDIS_TOKEN }
    });
    const d = await r.json();
    if (d.result !== null && d.result !== undefined) {
      const parsed = JSON.parse(d.result);
      memStore[key] = parsed;
      return parsed;
    }
  } catch(e) {}
  return null;
}

async function storeSet(key, val) {
  memStore[key] = val;  // Update cache immediately
  if (!REDIS_URL) return;
  try {
    await fetch(REDIS_URL + "/set/" + encodeURIComponent(key), {
      method: "POST",
      headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ value: JSON.stringify(val) })
    });
  } catch(e) { console.error("Redis write failed:", e.message); }
}

const DEF_AUTH = { username:"admin", password:"epewon2024", ipRestriction:{ enabled:false, allowedIPs:[], blockedCountries:[], allowedCountries:[] } };
// Sync auth cache - loaded at startup and kept in memory
let _authCache = null;
async function loadAuthAsync() { const v = await storeGet("auth"); _authCache = v ? {...DEF_AUTH,...v} : {...DEF_AUTH}; return _authCache; }
function loadAuth() { return _authCache || {...DEF_AUTH}; }
async function saveAuth(d) { _authCache = d; await storeSet("auth", d); }

// Cookie parser
app.use(function(req, res, next) {
  req.cookies = {};
  const c = req.headers.cookie;
  if (c) c.split(";").forEach(function(pair) {
    const idx = pair.indexOf("=");
    if (idx > 0) req.cookies[pair.slice(0,idx).trim()] = pair.slice(idx+1).trim();
  });
  next();
});

// Sessions in memory — login sessions are short-lived, memory is fine
const _sessions = {};
function loadSessions() { return _sessions; }
function saveSessions(s) { Object.assign(_sessions, s); }
function makeToken() { return uid()+uid()+uid(); }
function checkSession(req) {
  const token = req.cookies && req.cookies.ep_sess;
  if (!token) return false;
  if (!_sessions[token]) return false;
  if (Date.now() - _sessions[token].createdAt > 86400000) { delete _sessions[token]; return false; }
  return true;
}
function ipAllowed(req) {
  if (IP_BYPASS) return true;
  const auth = loadAuth();
  if (!auth.ipRestriction || !auth.ipRestriction.enabled) return true;
  const allowedIPs = auth.ipRestriction.allowedIPs || [];
  const blockedCountries = auth.ipRestriction.blockedCountries || [];
  const allowedCountries = auth.ipRestriction.allowedCountries || [];
  // If no restrictions set at all, allow everything
  if (!allowedIPs.length && !blockedCountries.length && !allowedCountries.length) return true;
  const clientIP = (req.headers["x-forwarded-for"]||"").split(",")[0].trim() || req.socket.remoteAddress || "";
  // IP whitelist check
  if (allowedIPs.length) {
    const ipOk = allowedIPs.some(function(ip) {
      if (!ip) return false;
      if (ip.includes("/")) {
        try { const [base,bits]=ip.split("/"); const mask=~((1<<(32-parseInt(bits)))-1)>>>0; const toNum=s=>s.split(".").reduce((a,b)=>((a<<8)|+b)>>>0,0); return(toNum(clientIP)&mask)===(toNum(base)&mask); } catch(e) { return false; }
      }
      return clientIP === ip;
    });
    if (!ipOk) return false;
  }
  // Country check is async — skip here, done at login time via getGeoInfo
  // (for real-time blocking, geoCheck is done in login + a cached property)
  return true;
}
function requireAuth(req, res, next) {
  // Only the dashboard HTML page (/) requires login
  // All API calls and twiml work without auth - the login just protects the UI
  const requiresLogin = req.path === "/" || req.path === "/index.html";
  if (!requiresLogin) return next();
  if (!ipAllowed(req)) return res.status(403).send("403: Your IP address is not allowed.");
  if (!checkSession(req)) return res.redirect("/login");
  next();
}
app.use(requireAuth);
app.use(express.static(path.join(__dirname, "public")));

// Settings + defaults
const DEF_SETTINGS = {
  provider:"twilio", companyName:"Epewon", voice:"alice", language:"en-US",
  twilio:        { accountSid:"", authToken:"", fromNumber:"", baseUrl:"" },
  signalwire:    { projectId:"",  authToken:"", fromNumber:"", baseUrl:"", spaceUrl:"" },
  vonage:        { apiKey:"",     apiSecret:"", fromNumber:"", baseUrl:"" },
  plivo:         { authId:"",     authToken:"", fromNumber:"", baseUrl:"" },
  africastalking:{ username:"",   apiKey:"",    fromNumber:"", baseUrl:"" },
  telnyx:        { apiKey:"",     fromNumber:"", baseUrl:"" }
};
const SEED_SCRIPTS = [
  {
    id:"tpl-default", name:"Default Script", isDefault:true, createdAt:new Date().toISOString(),
    greeting:{ message:"Hello! This is a call from our company. Press 1 to continue, or press 2 to end this call.", timeout:10, noInputMessage:"We did not receive your input. Goodbye." },
    steps:[{ label:"Verification Code", message:"Please enter your 5-digit verification code on your keypad, then press the hash key.", maxDigits:5, timeout:15, confirmMessage:"Thank you. " }],
    successMessage:"Thank you. Your information has been received and is being processed. Have a wonderful day. Goodbye.",
    cancelMessage:"No problem. Your request has been cancelled. If you have any questions please call us back. Goodbye.",
    errorMessage:"We did not receive your input. Please call us back at your convenience. Goodbye."
  },
  {
    id:"tpl-payment", name:"Payment Collection", isDefault:false, createdAt:new Date().toISOString(),
    greeting:{ message:"Hello! This is a call from our billing department regarding your account. Press 1 to proceed with payment, or press 2 to call us back later.", timeout:10, noInputMessage:"We did not receive your input. Goodbye." },
    steps:[
      { label:"Card Number", message:"Please enter your 16-digit card number on your keypad now, then press hash.", maxDigits:16, timeout:30, confirmMessage:"Card number received. " },
      { label:"Expiry Month and Year", message:"Please enter your card expiry date as month then year, 4 digits total, then press hash.", maxDigits:4, timeout:20, confirmMessage:"Expiry date received. " },
      { label:"CVV Code", message:"Please enter your 3-digit security code from the back of your card, then press hash.", maxDigits:3, timeout:15, confirmMessage:"Security code received. " }
    ],
    successMessage:"Thank you. Your payment details have been securely received and your transaction is being processed. You will receive a confirmation shortly. Goodbye.",
    cancelMessage:"No problem. We will try to reach you again later. Goodbye.",
    errorMessage:"We did not receive your input. For assistance please call our billing team directly. Goodbye."
  },
  {
    id:"tpl-survey", name:"Customer Survey", isDefault:false, createdAt:new Date().toISOString(),
    greeting:{ message:"Hello! This is a quick 2-question satisfaction survey from our company. It will only take 30 seconds. Press 1 to participate, or press 2 to skip.", timeout:10, noInputMessage:"We did not receive your input. Goodbye." },
    steps:[
      { label:"Overall Satisfaction", message:"On a scale of 1 to 5, how satisfied are you with our service? Press 1 for very unsatisfied up to 5 for very satisfied.", maxDigits:1, timeout:15, confirmMessage:"Thank you. " },
      { label:"Recommend Score", message:"Would you recommend us to a friend? Press 1 for yes or press 2 for no.", maxDigits:1, timeout:10, confirmMessage:"Great. " }
    ],
    successMessage:"Thank you for completing our survey. Your feedback is very important to us. Have a great day. Goodbye.",
    cancelMessage:"No problem. We appreciate your time. Goodbye.",
    errorMessage:"We did not receive your input. Thank you for your time. Goodbye."
  },
  {
    id:"tpl-appointment", name:"Appointment Reminder", isDefault:false, createdAt:new Date().toISOString(),
    greeting:{ message:"Hello! This is an appointment reminder from our office. You have an upcoming appointment scheduled. Press 1 to confirm your appointment, or press 2 to cancel.", timeout:10, noInputMessage:"We did not receive your input. Goodbye." },
    steps:[
      { label:"Confirmation", message:"Please press 1 to confirm your appointment, or press 2 to reschedule.", maxDigits:1, timeout:10, confirmMessage:"" }
    ],
    successMessage:"Your appointment has been confirmed. We look forward to seeing you. If you need to make any changes please call our office. Goodbye.",
    cancelMessage:"Your appointment has been noted for cancellation. Our team will contact you to reschedule. Goodbye.",
    errorMessage:"We did not receive your input. Please call our office to confirm your appointment. Goodbye."
  },
  {
    id:"tpl-verification", name:"Identity Verification", isDefault:false, createdAt:new Date().toISOString(),
    greeting:{ message:"Hello! This is a security verification call. We need to verify your identity before proceeding. Press 1 to begin verification, or press 2 to call us back.", timeout:10, noInputMessage:"We did not receive your input. Goodbye." },
    steps:[
      { label:"Date of Birth", message:"Please enter your date of birth as 8 digits in day month year format, then press hash.", maxDigits:8, timeout:20, confirmMessage:"Thank you. " },
      { label:"Last 4 Digits of ID", message:"Please enter the last 4 digits of your identification number, then press hash.", maxDigits:4, timeout:15, confirmMessage:"Verification complete. " }
    ],
    successMessage:"Your identity has been successfully verified. Thank you for your cooperation. Our team will now proceed with your request. Goodbye.",
    cancelMessage:"No problem. Please call us back at your convenience to complete verification. Goodbye.",
    errorMessage:"We could not verify your identity due to incorrect input. Please call our security team directly. Goodbye."
  }
];
let _settingsCache = null;
async function loadSettingsAsync() { const v = await storeGet("settings"); _settingsCache = v ? {...DEF_SETTINGS,...v} : {...DEF_SETTINGS}; return _settingsCache; }
function loadSettings() { return _settingsCache || {...DEF_SETTINGS}; }
async function saveSettings(d) { _settingsCache = d; await storeSet("settings", d); }
let _scriptsCache = null;
async function loadScriptsAsync() {
  const seeds = JSON.parse(JSON.stringify(SEED_SCRIPTS));
  const seedIds = seeds.map(s=>s.id);
  const saved = await storeGet("scripts");
  if (saved && saved.length) {
    const userCreated = saved.filter(s=>!seedIds.includes(s.id));
    _scriptsCache = seeds.concat(userCreated);
  } else {
    _scriptsCache = seeds;
  }
  return _scriptsCache;
}
function loadScripts() { return _scriptsCache || JSON.parse(JSON.stringify(SEED_SCRIPTS)); }
async function saveScripts(arr) {
  const seedIds = SEED_SCRIPTS.map(s=>s.id);
  const userOnly = arr.filter(s=>!seedIds.includes(s.id));
  _scriptsCache = arr;
  await storeSet("scripts", userOnly);
}

// Endpoint to get the built-in seed templates (always available regardless of disk)
// These are hardcoded in memory so Render disk wipes don't affect them
// saveScripts is now async - see above
let _logsCache = null;
async function loadLogsAsync() { _logsCache = (await storeGet("logs")) || []; return _logsCache; }
function loadLogs() { return _logsCache || []; }
async function saveLogs(arr) { _logsCache = arr; await storeSet("logs", arr); }

function makeClient(settings) {
  const p = settings.provider || "twilio";
  const twilio = require("twilio");
  if (p==="twilio")     { const c=settings.twilio;        if(!c.accountSid||!c.authToken) return null; return { type:"twilio",      client:twilio(c.accountSid,c.authToken), from:c.fromNumber, baseUrl:c.baseUrl, sid:c.accountSid }; }
  if (p==="signalwire") { const c=settings.signalwire;    if(!c.projectId||!c.authToken)  return null; return { type:"signalwire",   client:twilio(c.projectId,c.authToken,{accountSid:c.projectId,lazyLoading:true}), from:c.fromNumber, baseUrl:c.baseUrl, sid:c.projectId }; }
  if (p==="vonage")     { const c=settings.vonage;        if(!c.apiKey||!c.apiSecret)     return null; return { type:"vonage",       apiKey:c.apiKey, apiSecret:c.apiSecret, from:c.fromNumber, baseUrl:c.baseUrl }; }
  if (p==="plivo")      { const c=settings.plivo;         if(!c.authId||!c.authToken)     return null; return { type:"plivo",        authId:c.authId, authToken:c.authToken, from:c.fromNumber, baseUrl:c.baseUrl }; }
  if (p==="africastalking") { const c=settings.africastalking; if(!c.username||!c.apiKey) return null; return { type:"africastalking", username:c.username, apiKey:c.apiKey, from:c.fromNumber, baseUrl:c.baseUrl }; }
  if (p==="telnyx")     { const c=settings.telnyx;        if(!c.apiKey)                   return null; return { type:"telnyx",       apiKey:c.apiKey, from:c.fromNumber, baseUrl:c.baseUrl }; }
  return null;
}

async function makeCall(ctx, to, twimlUrl, statusUrl) {
  if (ctx.type==="twilio"||ctx.type==="signalwire") {
    const call = await ctx.client.calls.create({ to, from:ctx.from, url:twimlUrl, statusCallback:statusUrl, statusCallbackMethod:"POST", statusCallbackEvent:["initiated","ringing","answered","completed"] });
    return call.sid;
  }
  if (ctx.type==="plivo") { const r=await fetch("https://api.plivo.com/v1/Account/"+ctx.authId+"/Call/",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Basic "+Buffer.from(ctx.authId+":"+ctx.authToken).toString("base64")},body:JSON.stringify({to,from:ctx.from,answer_url:twimlUrl,hangup_url:statusUrl})}); const d=await r.json(); return d.request_uuid||uid(); }
  if (ctx.type==="africastalking") { const r=await fetch("https://voice.africastalking.com/call",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","apiKey":ctx.apiKey,"Accept":"application/json"},body:new URLSearchParams({username:ctx.username,to,from:ctx.from,url:twimlUrl}).toString()}); const d=await r.json(); return d.entries?.[0]?.sessionId||uid(); }
  if (ctx.type==="telnyx") { const r=await fetch("https://api.telnyx.com/v2/calls",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+ctx.apiKey},body:JSON.stringify({to,from:ctx.from,connection_id:ctx.from,webhook_url:statusUrl})}); const d=await r.json(); return d.data?.call_control_id||uid(); }
  throw new Error("Provider "+ctx.type+" not supported.");
}

// Load saved sessions from disk on startup (so monitor works after restarts)
const callSessions = {};
function syncLog(s) {
  // Save to logs file
  const logs=loadLogs();
  const i=logs.findIndex(l=>l.callSid===s.callSid);
  if(i>=0)logs[i]={...logs[i],...s};else logs.unshift(s);
  saveLogs(logs).catch(()=>{});
  // Keep memory in sync
  callSessions[s.callSid]=s;
  // Persist sessions so monitor works after restarts
  // sessions saved in memory
}


// ── GeoIP lookup ─────────────────────────────────────────────────────────────
async function getGeoInfo(ip) {
  if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127')) return { country:'Local', region:'Local', city:'Local' };
  try {
    const r = await fetch('http://ip-api.com/json/'+ip+'?fields=status,country,regionName,city', { signal: AbortSignal.timeout(3000) });
    const d = await r.json();
    if (d.status === 'success') return { country: d.country||'Unknown', region: d.regionName||'Unknown', city: d.city||'Unknown' };
  } catch(e) {}
  return { country:'Unknown', region:'Unknown', city:'Unknown' };
}

// Login logs in memory + MongoDB
let _loginLogs = [];
async function loadLoginLogsAsync() { _loginLogs = (await storeGet("login_logs")) || []; }
function loadLoginLogs() { return _loginLogs; }
async function saveLoginLog(entry) {
  _loginLogs.unshift(entry);
  if (_loginLogs.length > 500) _loginLogs.splice(500);
  await storeSet("login_logs", _loginLogs);
}

// ── Login page ────────────────────────────────────────────────────────────────
app.get("/login", (req, res) => {
  if (checkSession(req)) return res.redirect("/");
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Epewon — Login</title><link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet"/><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Inter',sans-serif;background:linear-gradient(135deg,#0e1520,#162030,#0a1018);min-height:100vh;display:flex;align-items:center;justify-content:center}body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(0,180,220,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(0,180,220,.05) 1px,transparent 1px);background-size:30px 30px;pointer-events:none}.card{background:rgba(255,255,255,.05);border:1px solid rgba(0,180,220,.2);border-radius:20px;padding:44px 40px;width:100%;max-width:400px;backdrop-filter:blur(10px);box-shadow:0 24px 60px rgba(0,0,0,.4)}.row{display:flex;align-items:center;gap:12px;margin-bottom:32px;justify-content:center}.icon{width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,#00d4ff,#00a8cc);display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,212,255,.35)}.nm{font-family:'Rajdhani',sans-serif;font-size:28px;font-weight:700;color:#e8f4ff;letter-spacing:2px}.sb{font-size:11px;color:#5a9ab8;letter-spacing:2px;text-transform:uppercase;margin-top:2px}h2{font-family:'Rajdhani',sans-serif;font-size:22px;font-weight:700;color:#cce8f8;text-align:center;margin-bottom:6px}.sub{font-size:13px;color:#5a8aaa;text-align:center;margin-bottom:28px}.f{margin-bottom:16px}.f label{display:block;font-size:11px;font-weight:600;color:#6a9ab8;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px}.f input{width:100%;background:rgba(0,0,0,.3);border:1px solid rgba(0,180,220,.2);border-radius:10px;padding:12px 14px;color:#d0eaf8;font-size:14px;outline:none;transition:border-color .15s}.f input:focus{border-color:rgba(0,212,255,.5);box-shadow:0 0 0 3px rgba(0,212,255,.1)}.f input::placeholder{color:#2a5060}.btn{width:100%;padding:13px;background:linear-gradient(135deg,#00d4ff,#00a8cc);border:none;border-radius:10px;color:#000;font-size:16px;font-weight:700;cursor:pointer;transition:all .15s;font-family:'Rajdhani',sans-serif;letter-spacing:1px;margin-top:6px}.btn:hover{opacity:.88;transform:translateY(-1px)}.err{background:rgba(255,82,82,.12);border:1px solid rgba(255,82,82,.3);border-radius:8px;padding:10px 14px;color:#ff8080;font-size:13px;margin-bottom:16px;display:none}.err.show{display:block}</style></head><body><div class="card"><div class="row"><div class="icon"><svg viewBox="0 0 36 36" fill="none" width="26" height="26"><rect x="6" y="7" width="4" height="22" rx="2" fill="#000" opacity=".8"/><rect x="6" y="7" width="18" height="4" rx="2" fill="#000" opacity=".8"/><rect x="6" y="16" width="13" height="4" rx="2" fill="#000" opacity=".8"/><rect x="6" y="25" width="18" height="4" rx="2" fill="#000" opacity=".8"/><circle cx="28" cy="10" r="2.5" fill="#000" opacity=".6"/><path d="M26 14 Q30 14 30 18 Q30 22 26 22" stroke="#000" stroke-width="1.5" stroke-linecap="round" fill="none" opacity=".5"/></svg></div><div><div class="nm">EPEWON</div><div class="sb">Command Center</div></div></div><h2>Welcome Back</h2><p class="sub">Sign in to access your dashboard</p><div class="err" id="err"></div><div class="f"><label>Username</label><input type="text" id="u" placeholder="Enter username" autocomplete="username"/></div><div class="f"><label>Password</label><input type="password" id="p" placeholder="Enter password" autocomplete="current-password"/></div><button class="btn" onclick="go()">SIGN IN →</button></div><script>document.getElementById('p').addEventListener('keypress',function(e){if(e.key==='Enter')go()});async function go(){var u=document.getElementById('u').value.trim(),p=document.getElementById('p').value,e=document.getElementById('err');e.classList.remove('show');if(!u||!p){e.textContent='Please enter username and password.';e.classList.add('show');return;}var r=await fetch('/auth/login',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});var d=await r.json();if(d.ok){window.location.href='/';}else{e.textContent=d.error||'Login failed';e.classList.add('show');}}</script></body></html>`);
});

// ── Auth endpoints ────────────────────────────────────────────────────────────
app.post("/auth/login", async (req, res) => {
  const clientIP = (req.headers["x-forwarded-for"]||"").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  const geo = await getGeoInfo(clientIP);
  const { username, password } = req.body;
  const auth = loadAuth();
  const logEntry = { time: new Date().toISOString(), ip: clientIP, country: geo.country, region: geo.region, city: geo.city, username: username||"", success: false, reason: "" };

  if (!ipAllowed(req)) {
    logEntry.reason = "IP not allowed";
    saveLoginLog(logEntry);
    return res.status(403).json({ ok:false, error:"Your IP address is not allowed." });
  }
  // Country-based blocking check
  const ipr = auth.ipRestriction || {};
  if (ipr.enabled && (ipr.blockedCountries||[]).length || (ipr.allowedCountries||[]).length) {
    const bc = (ipr.blockedCountries||[]).map(s=>s.toLowerCase());
    const ac = (ipr.allowedCountries||[]).map(s=>s.toLowerCase());
    const geoCountry = geo.country.toLowerCase();
    if (bc.length && bc.includes(geoCountry)) {
      logEntry.reason = "Country blocked: " + geo.country;
      saveLoginLog(logEntry);
      return res.status(403).json({ ok:false, error:"Access not allowed from your country ("+geo.country+")." });
    }
    if (ac.length && !ac.includes(geoCountry)) {
      logEntry.reason = "Country not in allowlist: " + geo.country;
      saveLoginLog(logEntry);
      return res.status(403).json({ ok:false, error:"Access not allowed from your country ("+geo.country+")." });
    }
  }

  if (username === auth.username && password === auth.password) {
    const token = makeToken();
    const sessions = loadSessions();
    sessions[token] = { createdAt: Date.now() };
    logEntry.success = true; logEntry.reason = "Login successful";
    saveLoginLog(logEntry);
    res.setHeader("Set-Cookie", "ep_sess="+token+"; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax");
    return res.json({ ok:true });
  }
  logEntry.reason = "Wrong password";
  saveLoginLog(logEntry);
  res.status(401).json({ ok:false, error:"Wrong username or password." });
});
app.post("/auth/logout", (req, res) => {
  const token = req.cookies && req.cookies.ep_sess;
  if (token) delete _sessions[token];
  res.setHeader("Set-Cookie", "ep_sess=; HttpOnly; Path=/; Max-Age=0");
  res.json({ ok:true });
});
app.get("/api/auth", (req, res) => { const a=loadAuth(); res.json({ username:a.username, ipRestriction:a.ipRestriction }); });
app.post("/api/auth", (req, res) => {
  const cur=loadAuth(); const body=req.body; const updated={...cur};
  if (body.username) updated.username=body.username;
  if (body.password && body.password!=="••••") updated.password=body.password;
  if (body.ipRestriction!==undefined) updated.ipRestriction={...cur.ipRestriction,...body.ipRestriction};
  saveAuth(updated); res.json({ success:true });
});


app.get("/api/auth/logs", (req, res) => {
  res.json(loadLoginLogs());
});
app.delete("/api/auth/logs", async (req, res) => {
  _loginLogs = []; await storeSet("login_logs", []);
  res.json({ success: true });
});

// ── Settings ──────────────────────────────────────────────────────────────────
app.get("/api/settings", (req, res) => {
  const s=loadSettings(); const safe=JSON.parse(JSON.stringify(s));
  ["twilio","signalwire","vonage","plivo","africastalking","telnyx"].forEach(p=>{
    if(safe[p]){if(safe[p].authToken)safe[p].authToken="••••"+safe[p].authToken.slice(-4);if(safe[p].apiKey)safe[p].apiKey="••••"+safe[p].apiKey.slice(-4);if(safe[p].apiSecret)safe[p].apiSecret="••••"+safe[p].apiSecret.slice(-4);}
  });
  res.json(safe);
});
app.post("/api/settings", async (req, res) => {
  const cur=loadSettings(); const body=req.body; const updated={...cur,...body};
  ["twilio","signalwire","vonage","plivo","africastalking","telnyx"].forEach(p=>{
    if(body[p]){updated[p]={...cur[p],...body[p]};if(body[p].authToken&&body[p].authToken.startsWith("••••"))updated[p].authToken=cur[p].authToken;if(body[p].apiKey&&body[p].apiKey.startsWith("••••"))updated[p].apiKey=cur[p].apiKey;if(body[p].apiSecret&&body[p].apiSecret.startsWith("••••"))updated[p].apiSecret=cur[p].apiSecret;}
  });
  await saveSettings(updated); res.json({ success:true });
});
app.get("/api/test", async (req, res) => {
  const s=loadSettings(); const ctx=makeClient(s);
  if(!ctx) return res.json({ok:false,error:"Credentials not configured for "+s.provider+"."});
  if(!ctx.from) return res.json({ok:false,error:"Phone number not set."});
  if(!ctx.baseUrl) return res.json({ok:false,error:"Server URL not set. Click Auto-detect."});
  try{if((ctx.type==="twilio"||ctx.type==="signalwire")&&ctx.client){const a=await ctx.client.api.accounts(ctx.sid).fetch();return res.json({ok:true,provider:ctx.type,name:a.friendlyName});}return res.json({ok:true,provider:ctx.type,name:"Credentials saved"});}catch(err){res.json({ok:false,error:err.message});}
});

// ── Scripts ───────────────────────────────────────────────────────────────────

app.get("/api/seed-scripts", (req, res) => {
  res.json(JSON.parse(JSON.stringify(SEED_SCRIPTS)));
});

app.get("/api/scripts",    (req,res) => res.json(loadScripts()));
app.post("/api/scripts", async (req,res) => {
  const body=req.body;
  const seedIds=['tpl-default','tpl-payment','tpl-survey','tpl-appointment','tpl-verification'];
  const current = loadScripts();
  if(body.id && !seedIds.includes(body.id)){
    const i=current.findIndex(s=>s.id===body.id);
    if(i>=0)current[i]={...current[i],...body,updatedAt:new Date().toISOString()};
    else current.push({...body,createdAt:new Date().toISOString()});
  } else if(!body.id){
    current.push({...body,id:uid(),createdAt:new Date().toISOString()});
  }
  await saveScripts(current);
  res.json({success:true,scripts:loadScripts()});
});
app.delete("/api/scripts/:id", async (req,res) => {
  let scripts=loadScripts();
  const seedIds=['tpl-default','tpl-payment','tpl-survey','tpl-appointment','tpl-verification'];
  if(seedIds.includes(req.params.id)) return res.status(400).json({error:"Cannot delete a template script."});
  scripts=scripts.filter(s=>s.id!==req.params.id);
  if(!scripts.find(s=>s.isDefault)&&scripts.length) scripts[0].isDefault=true;
  await saveScripts(scripts); res.json({success:true,scripts});
});
app.post("/api/scripts/:id/setdefault", async (req,res) => { const scripts=loadScripts(); scripts.forEach(s=>s.isDefault=s.id===req.params.id); await saveScripts(scripts); res.json({success:true}); });

// ── Logs ──────────────────────────────────────────────────────────────────────
app.get("/api/logs", (req,res) => {
  const disk = loadLogs();
  const mem = Object.values(callSessions);
  const diskSids = new Set(disk.map(l=>l.callSid));
  const memOnly = mem.filter(m=>!diskSids.has(m.callSid));
  const merged = [...mem.filter(m=>diskSids.has(m.callSid)).map(m=>{
    const d=disk.find(l=>l.callSid===m.callSid);
    return {...d,...m};
  }), ...memOnly, ...disk.filter(d=>!mem.find(m=>m.callSid===d.callSid))];
  merged.sort((a,b)=>new Date(b.startTime)-new Date(a.startTime));
  res.json(merged.slice(0,200));
});
app.delete("/api/logs/:id", async (req,res) => { await saveLogs(loadLogs().filter(l=>l.id!==req.params.id)); res.json({success:true}); });
app.delete("/api/logs", async (req,res) => { await saveLogs([]); res.json({success:true}); });
app.get("/api/sessions", (req,res) => {
  // Merge in-memory (current run) + disk logs (previous runs) so monitor always has data
  const diskLogs = loadLogs();
  const memSessions = Object.values(callSessions);
  const memSids = new Set(memSessions.map(s=>s.callSid));
  // Add disk entries not in memory (from previous server runs)
  const diskOnly = diskLogs.filter(l=>!memSids.has(l.callSid));
  const merged = [...memSessions, ...diskOnly].sort((a,b)=>new Date(b.startTime)-new Date(a.startTime));
  res.json(merged.slice(0,50)); // last 50 calls
});

// ── Call ──────────────────────────────────────────────────────────────────────
app.post("/api/call", async (req,res) => {
  const {phoneNumber,label,scriptId}=req.body;
  if(!phoneNumber) return res.status(400).json({error:"Phone number required."});
  const settings=loadSettings(); const ctx=makeClient(settings);
  if(!ctx) return res.status(400).json({error:"Provider credentials not configured. Go to Settings."});
  const scripts=loadScripts();
  const script=(scriptId?scripts.find(s=>s.id===scriptId):null)||scripts.find(s=>s.isDefault)||scripts[0];
  // Use saved baseUrl OR auto-detect from this request
  const baseUrl = ctx.baseUrl || getPublicUrl(req);
  if(!baseUrl) return res.status(400).json({error:"Server URL not configured. Go to Settings and click Auto-detect."});
  try{
    const callSid=await makeCall(ctx,phoneNumber,baseUrl+"/twiml/start?sid="+script.id,baseUrl+"/twiml/status");
    const entry={id:uid(),callSid,phone:phoneNumber,label:label||"Call",scriptName:script.name,provider:ctx.type,status:"initiated",statusDetail:"Dialing...",startTime:new Date().toISOString(),endTime:null,duration:null,currentStep:-1,collected:[],steps:script.steps.length};
    callSessions[callSid]=entry; const logs=loadLogs(); logs.unshift(entry); saveLogs(logs).catch(()=>{});
    res.json({success:true,callSid});
  }catch(err){res.status(500).json({error:err.message});}
});
app.post("/api/call/:sid/end", async (req,res) => {
  const {sid}=req.params; const ctx=makeClient(loadSettings());
  try{if(ctx&&(ctx.type==="twilio"||ctx.type==="signalwire")&&ctx.client)await ctx.client.calls(sid).update({status:"completed"});if(callSessions[sid]){callSessions[sid].status="ended-by-user";callSessions[sid].statusDetail="Ended by you";syncLog(callSessions[sid]);}res.json({success:true});}
  catch(err){res.status(500).json({error:err.message});}
});


// ── AI Enhance endpoint ───────────────────────────────────────────────────────
app.post("/api/ai-enhance", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "No text provided." });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: "You are rewriting a phone IVR script message to sound more professional, clear, and friendly. Keep it concise (under 2 sentences). Preserve the meaning exactly. Only return the improved text, nothing else.\n\nOriginal: " + text
        }]
      })
    });
    const d = await r.json();
    if (d.content && d.content[0] && d.content[0].text) {
      return res.json({ enhanced: d.content[0].text.trim() });
    }
    res.json({ error: "No response from AI." });
  } catch(err) {
    res.json({ error: err.message });
  }
});

// ── TwiML ─────────────────────────────────────────────────────────────────────
function getVoice(){const s=loadSettings();return{voice:s.voice||"alice",language:s.language||"en-US"};}
function getBase(req){
  const s=loadSettings();
  const p=s.provider||"twilio";
  const saved=(s[p]||{}).baseUrl||"";
  if(saved) return saved;
  if(req) return getPublicUrl(req);
  return detectedBaseUrl||"";
}
function getScript(id){const ss=loadScripts();return ss.find(s=>s.id===id)||ss[0];}

app.post("/twiml/start",(req,res)=>{
  const {voice:v,language:l}=getVoice();const sc=getScript(req.query.sid);const base=getBase(req);const sid=req.body.CallSid;
  if(callSessions[sid]){callSessions[sid].status="ringing";callSessions[sid].statusDetail="Playing greeting...";syncLog(callSessions[sid]);}
  const {VoiceResponse}=require("twilio").twiml;const t=new VoiceResponse();
  const g=t.gather({numDigits:1,action:base+"/twiml/greet?sid="+sc.id,method:"POST",timeout:sc.greeting.timeout});
  g.say({voice:v,language:l},sc.greeting.message);t.say({voice:v,language:l},sc.greeting.noInputMessage);t.hangup();
  res.type("text/xml").send(t.toString());
});
app.post("/twiml/greet",(req,res)=>{
  const {voice:v,language:l}=getVoice();const sc=getScript(req.query.sid);const base=getBase(req);const sid=req.body.CallSid;const digit=req.body.Digits;
  const {VoiceResponse}=require("twilio").twiml;const t=new VoiceResponse();
  if(digit==="2"){if(callSessions[sid]){callSessions[sid].status="cancelled";callSessions[sid].statusDetail="Caller declined";syncLog(callSessions[sid]);}t.say({voice:v,language:l},sc.cancelMessage);t.hangup();return res.type("text/xml").send(t.toString());}
  if(digit==="1"){if(callSessions[sid]){callSessions[sid].status="in-progress";callSessions[sid].statusDetail="Accepted";syncLog(callSessions[sid]);}return res.redirect(307,base+"/twiml/step/0?sid="+sc.id);}
  t.say({voice:v,language:l},"Invalid input. "+sc.greeting.message);t.redirect(base+"/twiml/start?sid="+sc.id);res.type("text/xml").send(t.toString());
});
app.all("/twiml/step/:idx",(req,res)=>{
  const {voice:v,language:l}=getVoice();const sc=getScript(req.query.sid);const base=getBase(req);const idx=parseInt(req.params.idx,10);const step=sc.steps[idx];const sid=req.body.CallSid;
  const {VoiceResponse}=require("twilio").twiml;const t=new VoiceResponse();
  if(!step){if(callSessions[sid]){callSessions[sid].status="completed";callSessions[sid].statusDetail="All steps done";syncLog(callSessions[sid]);}t.say({voice:v,language:l},sc.successMessage);t.hangup();return res.type("text/xml").send(t.toString());}
  if(callSessions[sid]){callSessions[sid].currentStep=idx;callSessions[sid].statusDetail="Waiting: "+step.label;syncLog(callSessions[sid]);}
  const g=t.gather({numDigits:step.maxDigits,action:base+"/twiml/collect/"+idx+"?sid="+sc.id,method:"POST",timeout:step.timeout});
  g.say({voice:v,language:l},step.message);t.say({voice:v,language:l},sc.errorMessage);t.hangup();res.type("text/xml").send(t.toString());
});
app.post("/twiml/collect/:idx",(req,res)=>{
  const {voice:v,language:l}=getVoice();const sc=getScript(req.query.sid);const base=getBase(req);const idx=parseInt(req.params.idx,10);const sid=req.body.CallSid;const digits=req.body.Digits||"";const step=sc.steps[idx];
  const {VoiceResponse}=require("twilio").twiml;const t=new VoiceResponse();
  // numDigits is exact - Twilio auto-submits when reached
  if(callSessions[sid]){callSessions[sid].collected.push({step:idx,label:step.label,value:digits,time:new Date().toISOString()});callSessions[sid].currentStep=idx+1;callSessions[sid].statusDetail="Received: "+step.label;syncLog(callSessions[sid]);}
  if(step.confirmMessage)t.say({voice:v,language:l},step.confirmMessage);
  t.redirect(base+"/twiml/step/"+(idx+1)+"?sid="+sc.id);res.type("text/xml").send(t.toString());
});
app.post("/twiml/status",(req,res)=>{
  const sid=req.body.CallSid;const cs=req.body.CallStatus;const dur=req.body.CallDuration;
  if(callSessions[sid]){const s=callSessions[sid];
    if(cs==="ringing")s.statusDetail="Ringing...";
    else if(cs==="answered"){s.status="in-progress";s.statusDetail="Connected";}
    else if(cs==="completed"&&!["cancelled","completed","ended-by-user"].includes(s.status)){s.status="completed";s.statusDetail="Completed";}
    else if(["no-answer","busy","failed"].includes(cs)){s.status=cs;s.statusDetail=cs.replace("-"," ");}
    if(dur)s.duration=parseInt(dur);
    if(["completed","cancelled","no-answer","busy","failed"].includes(cs))s.endTime=new Date().toISOString();
    syncLog(s);
  }
  res.sendStatus(200);
});

// Start server immediately - never block on Redis
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ Epewon Pro → http://localhost:" + PORT);
  // Load persisted data from Redis in background after server is up
  Promise.all([
    loadAuthAsync(),
    loadSettingsAsync(),
    loadScriptsAsync(),
    loadLogsAsync(),
    loadLoginLogsAsync()
  ]).then(function() {
    console.log("✅ Redis data loaded");
  }).catch(function(e) {
    console.log("⚠️ Redis load failed, using defaults:", e.message);
  });
});
