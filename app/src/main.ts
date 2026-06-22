import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl, openPath } from "@tauri-apps/plugin-opener";

// ── Settings schema (flat, grouped; lives inline in the dashboard) ───────────
type Field = { key: string; label: string; placeholder?: string; default?: string; secret?: boolean; required?: boolean };
type Group = { label: string; fields: Field[] };

const GROUPS: Group[] = [
  { label: "身份", fields: [
    { key: "self_name", label: "你的名字", placeholder: "张续" },
    { key: "self_aliases", label: "别名（逗号分隔，可选）", placeholder: "zack, 张总" },
  ]},
  { label: "录音与输出", fields: [
    { key: "VOICENOTE_RECORD_DIR", label: "录音目录", placeholder: "留空=自动(macOS 的 VTR6500)；Windows 填盘符，如 E:\\RECORD" },
    { key: "VOICENOTE_WORKSPACE", label: "纪要输出目录", default: "$HOME/Documents/meetings" },
  ]},
  { label: "转写（火山 / 豆包）", fields: [
    { key: "VOLCANO_ASR_KEY", label: "ASR Key", secret: true, required: true },
    { key: "VOLCANO_TOS_BUCKET", label: "TOS Bucket", required: true },
    { key: "VOLCANO_TOS_ACCESS_KEY", label: "TOS Access Key", secret: true, required: true },
    { key: "VOLCANO_TOS_SECRET_KEY", label: "TOS Secret Key", secret: true, required: true },
  ]},
  { label: "网络代理（访问 ChatGPT 用；留空自动用系统代理）", fields: [
    { key: "LOCAL_PROXY_HOST", label: "代理 Host（可选）", placeholder: "留空 = 跟随系统代理" },
    { key: "LOCAL_PROXY_PORT", label: "代理 Port（可选）", placeholder: "留空 = 跟随系统代理" },
  ]},
  { label: "高级（一般用默认即可）", fields: [
    { key: "VOLCANO_ASR_RESOURCE_ID", label: "ASR Resource ID", default: "volc.seedasr.auc" },
    { key: "VOLCANO_TOS_REGION", label: "TOS Region", default: "cn-guangzhou" },
    { key: "VOLCANO_TOS_ENDPOINT", label: "TOS Endpoint", default: "tos-s3-cn-guangzhou.volces.com" },
  ]},
];
const ALL_FIELDS = GROUPS.flatMap((g) => g.fields);
const ENV_KEYS = ALL_FIELDS.map((f) => f.key).filter((k) => !k.startsWith("self_"));

// ── Types ────────────────────────────────────────────────────────────────────
type Status = {
  workspace: string;
  recorder: { dir: string; exists: boolean };
  volcano: { configured: true; tos: { bucket: string } } | { configured: false };
  pi: { auth: boolean };
  proxy: { httpProxy: string | null };
  identity: { self: string | null };
  deps: { ffprobe: boolean };
  agent: { installed: boolean; logTail: string[] };
};
type Job = {
  status: "processing" | "done" | "failed";
  name: string;
  title: string | null;
  step?: string;
  time?: string | null;
  reason?: string | null;
  notes: string | null;
};

let status: Status | null = null;
let loginRunning = false;
let loginSucceeded = false;
let settingsBuilt = false;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function inputEl(key: string) { return document.getElementById(`f_${key}`) as HTMLInputElement | null; }
function setStatus(el: HTMLElement, text: string, kind: "" | "ok" | "err" | "wait" = "") { el.textContent = text; el.className = `status ${kind}`; }
function showScreen(which: "dash" | "settings") { $("dash").hidden = which !== "dash"; $("settings").hidden = which !== "settings"; }

// ── Agent pill ───────────────────────────────────────────────────────────────
function renderAgentPill(a: Status["agent"]) {
  const pill = $("agent-pill");
  let text = "后台运行中", tone = "ok";
  const last = (a.logTail ?? []).slice(-1)[0] ?? "";
  if (!a.installed) { text = "后台未启用"; tone = "err"; }
  else if (/ERROR|failed|失败/i.test(last)) { text = "后台出错 · 查看日志"; tone = "err"; }
  else if (/Idle|no new recordings/i.test(last)) { text = "待命中 · 插上录音笔即自动处理"; tone = "ok"; }
  else if (/transcrib|Volcano|Step 2|转写/i.test(last)) { text = "正在转写录音…"; tone = "wait"; }
  else if (/generate|notes|Step 3|纪要/i.test(last)) { text = "正在生成纪要…"; tone = "wait"; }
  else if (/Completed|✓|Queue|processing/i.test(last)) { text = "正在处理…"; tone = "wait"; }
  pill.textContent = text; pill.className = `agent-pill ${tone}`;
}

// ── Status rows ──────────────────────────────────────────────────────────────
function statusRow(label: string, value: string, tone: "ok" | "warn" | "err" | "muted") {
  const row = document.createElement("div");
  row.className = "srow";
  const dot = document.createElement("span"); dot.className = `dot ${tone}`;
  const lbl = document.createElement("span"); lbl.className = "lbl"; lbl.textContent = label;
  const val = document.createElement("span"); val.className = `val ${tone === "err" ? "err" : ""}`; val.textContent = value;
  row.append(dot, lbl, val);
  return row;
}

function renderStatus() {
  const box = $("status-rows");
  box.innerHTML = "";
  if (!status) { box.appendChild(statusRow("状态", "检测中…", "muted")); return; }
  const s = status;
  box.appendChild(statusRow("ChatGPT", s.pi.auth ? "已连接" : "未登录", s.pi.auth ? "ok" : "err"));
  box.appendChild(statusRow("转写", s.volcano.configured ? `已配置 · ${s.volcano.tos.bucket}` : "未配置", s.volcano.configured ? "ok" : "err"));
  box.appendChild(statusRow("代理", s.proxy.httpProxy ?? "未设置", s.proxy.httpProxy ? "ok" : "warn"));
  box.appendChild(statusRow("录音笔", s.recorder.exists ? "已插入" : "未检测到", s.recorder.exists ? "ok" : "muted"));
  box.appendChild(statusRow("音频工具", s.deps.ffprobe ? "就绪" : "缺失", s.deps.ffprobe ? "ok" : "err"));
  const btn = $("login-btn") as HTMLButtonElement;
  btn.textContent = s.pi.auth ? "重新登录 ChatGPT" : "登录 ChatGPT";
}

// ── Jobs (processing status of each recording) ───────────────────────────────
const JOB_META: Record<Job["status"], { label: string; tone: string }> = {
  processing: { label: "处理中", tone: "wait" },
  done: { label: "完成", tone: "ok" },
  failed: { label: "失败", tone: "err" },
};

function renderJobs(jobs: Job[]) {
  const list = $("notes-list");
  list.innerHTML = "";
  if (!jobs.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.innerHTML = `<div class="e-icon">🎙️</div>`;
    const p = document.createElement("p");
    p.textContent = "还没有录音。插上录音笔，后台会自动转写并生成纪要，处理状态会显示在这里。";
    e.appendChild(p);
    list.appendChild(e);
    return;
  }
  for (const j of jobs) {
    const meta = JOB_META[j.status];
    const openable = j.status === "done" && !!j.notes;
    const card = document.createElement("button");
    card.className = "job-card";
    card.disabled = !openable;

    const head = document.createElement("div"); head.className = "job-head";
    const badge = document.createElement("span"); badge.className = `jbadge ${meta.tone}`;
    badge.textContent = j.status === "processing" && j.step ? `${meta.label} · ${j.step}` : meta.label;
    head.appendChild(badge);
    if (openable) { const open = document.createElement("span"); open.className = "job-open"; open.textContent = "打开 ↗"; head.appendChild(open); }

    const title = document.createElement("div"); title.className = "job-title";
    title.textContent = j.title || j.name;
    card.append(head, title);

    if (j.time) { const tm = document.createElement("div"); tm.className = "job-time"; tm.textContent = j.time; card.appendChild(tm); }
    if (j.status === "failed" && j.reason) {
      const r = document.createElement("div"); r.className = "job-reason"; r.textContent = j.reason; card.appendChild(r);
    }
    if (openable) card.addEventListener("click", () => openPath(j.notes!));
    list.appendChild(card);
  }
}

function renderError(containerId: string, msg: string) {
  const box = $(containerId);
  box.innerHTML = "";
  const p = document.createElement("p");
  p.className = "load-error";
  p.textContent = msg;
  box.appendChild(p);
}

async function refreshJobs() {
  try {
    const r = (await invoke("recent_jobs")) as { items: Job[] };
    renderJobs(r.items ?? []);
  } catch (e) {
    renderError("notes-list", `读取处理状态失败：${e}`);
  }
}

async function refreshStatus() {
  try {
    status = (await invoke("doctor_status")) as Status;
  } catch (e) {
    status = null;
    const pill = $("agent-pill");
    pill.textContent = "状态读取失败";
    pill.className = "agent-pill err";
    renderError("status-rows", `读取状态失败：${e}`);
    return;
  }
  renderAgentPill(status.agent);
  renderStatus();
  void refreshJobs();
}

// ── Settings (inline, built once; values loaded from config) ─────────────────
function makeInput(f: Field): HTMLElement {
  const wrap = document.createElement("label"); wrap.className = "field";
  const span = document.createElement("span"); span.textContent = f.label;
  if (f.required) { const s = document.createElement("em"); s.textContent = " *"; s.className = "req"; span.appendChild(s); }
  const el = document.createElement("input"); el.id = `f_${f.key}`; el.type = f.secret ? "password" : "text";
  if (f.placeholder) el.placeholder = f.placeholder;
  wrap.append(span, el);
  return wrap;
}

function buildSettings() {
  if (settingsBuilt) return;
  const root = $("fields");
  for (const g of GROUPS) {
    const sec = document.createElement("section");
    sec.className = "settings-group";
    const lbl = document.createElement("div"); lbl.className = "group-label"; lbl.textContent = g.label;
    sec.appendChild(lbl);
    for (const f of g.fields) sec.appendChild(makeInput(f));
    root.appendChild(sec);
  }
  settingsBuilt = true;
}

async function openSettings() { buildSettings(); showScreen("settings"); setStatus($("settings-status"), ""); await loadConfig(); }

async function loadConfig() {
  buildSettings();
  let cfg: { env?: Record<string, string>; self?: { name?: string | null; aliases?: string[] } } = {};
  try { cfg = (await invoke("config_get")) as typeof cfg; } catch { /* defaults */ }
  for (const f of ALL_FIELDS) {
    if (f.key.startsWith("self_")) continue;
    const el = inputEl(f.key); if (el) el.value = cfg.env?.[f.key] ?? f.default ?? "";
  }
  const name = inputEl("self_name"); if (name) name.value = cfg.self?.name ?? "";
  const al = inputEl("self_aliases"); if (al) al.value = (cfg.self?.aliases ?? []).join(", ");
}

async function ensureAgent(force = false) { try { await invoke("ensure_agent", { force }); } catch (e) { console.error("ensure_agent", e); } }

async function saveSettings(e: Event) {
  e.preventDefault();
  for (const f of ALL_FIELDS) { if (f.required && !(inputEl(f.key)?.value ?? "").trim()) { setStatus($("settings-status"), `请填写「${f.label}」`, "err"); return; } }
  const env: Record<string, string | null> = {};
  for (const key of ENV_KEYS) { const v = (inputEl(key)?.value ?? "").trim(); env[key] = v === "" ? null : v; }
  const aliases = (inputEl("self_aliases")?.value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const self = { name: (inputEl("self_name")?.value ?? "").trim() || null, aliases };
  const btn = $("save-btn") as HTMLButtonElement;
  btn.disabled = true;
  setStatus($("settings-status"), "保存中…", "wait");
  try {
    await invoke("config_set", { payload: { env, self } });
    await ensureAgent(true);
    await refreshStatus();
    showScreen("dash");
  } catch (err) {
    setStatus($("settings-status"), `保存失败：${err}`, "err");
  } finally {
    btn.disabled = false;
  }
}

// ── Login (inline) ───────────────────────────────────────────────────────────
type LoginEvent =
  | { event: "auth_url"; url: string }
  | { event: "device_code"; userCode: string; verificationUri: string }
  | { event: "success"; provider: string }
  | { event: "error"; message: string }
  | { event: "closed"; code: number | null };

function onLoginEvent(e: LoginEvent) {
  const st = $("login-status");
  switch (e.event) {
    case "auth_url":
      setStatus(st, "已打开浏览器，授权后会自动完成…", "wait");
      ($("auth-link") as HTMLAnchorElement).dataset.url = e.url; $("auth-link-wrap").hidden = false; break;
    case "device_code":
      setStatus(st, `请在 ${e.verificationUri} 输入：${e.userCode}`, "wait"); break;
    case "success":
      loginSucceeded = true; setStatus(st, "✓ 登录成功", "ok"); $("auth-link-wrap").hidden = true; break;
    case "error":
      setStatus(st, `登录失败：${e.message}`, "err"); ($("login-btn") as HTMLButtonElement).disabled = false; break;
    case "closed":
      loginRunning = false; ($("login-btn") as HTMLButtonElement).disabled = false;
      if (loginSucceeded) ensureAgent(true).then(() => refreshStatus());
      else if (e.code !== 0) setStatus(st, `登录已退出（code=${e.code ?? "?"}）`, "err");
      break;
  }
}

function startLogin() {
  if (loginRunning) return;
  loginRunning = true; loginSucceeded = false;
  $("auth-link-wrap").hidden = true; ($("login-btn") as HTMLButtonElement).disabled = true;
  setStatus($("login-status"), "正在启动登录…", "wait");
  invoke("login_chatgpt").catch((err) => { loginRunning = false; setStatus($("login-status"), `无法启动：${err}`, "err"); ($("login-btn") as HTMLButtonElement).disabled = false; });
}

// ── Boot ─────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", async () => {
  listen<LoginEvent>("login-event", (e) => onLoginEvent(e.payload));

  $("refresh-btn").addEventListener("click", refreshStatus);
  $("settings-btn").addEventListener("click", () => void openSettings());
  $("settings-back").addEventListener("click", (e) => { e.preventDefault(); showScreen("dash"); });
  $("open-ws").addEventListener("click", (e) => { e.preventDefault(); if (status?.workspace) openPath(status.workspace); });
  $("settings-form").addEventListener("submit", saveSettings);
  $("login-btn").addEventListener("click", startLogin);
  $("auth-link").addEventListener("click", (e) => { e.preventDefault(); const u = ($("auth-link") as HTMLAnchorElement).dataset.url; if (u) openUrl(u); });

  buildSettings();
  // Show the dashboard shell immediately (status rows read “检测中…”) so sidecar
  // latency — bun cold start + `pi --version` — never leaves a blank window.
  showScreen("dash");
  renderStatus();
  await refreshStatus();
  // First run (transcription not configured) lands on the settings page; otherwise
  // stay on the dashboard.
  if (status && !status.volcano.configured) await openSettings();
  else if (status?.pi.auth) ensureAgent(false).then(() => refreshStatus());
});
