import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
function loadLocalEnv() {
  const envPath = path.join(ROOT, ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2];
  }
}
loadLocalEnv();

const BASE = process.env.SIM_BASE_URL ?? "http://127.0.0.1:4310";
const STATE_DIR = path.join(ROOT, "tmp", "sim");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const TRANSCRIPT = path.join(STATE_DIR, "transcript.jsonl");

function loadState() {
  if (!existsSync(STATE_FILE)) return { cookies: "", threads: {}, turns: [], day: {} };
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
const state = loadState();

function log(entry) { appendFileSync(TRANSCRIPT, JSON.stringify(entry) + "\n"); }

async function api(method, urlPath, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { "content-type": "application/json", cookie: state.cookies, ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.SIM_TIMEOUT_MS ?? (urlPath?.includes("consolidate") ? 600_000 : 240_000))),
  });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookies) {
    const pair = c.split(";")[0];
    const name = pair.split("=")[0];
    const others = state.cookies.split("; ").filter((x) => x && !x.startsWith(name + "="));
    state.cookies = [...others, pair].join("; ");
  }
  return res;
}

async function ensureSession() {
  if (state.cookies.includes("iris_access") || state.cookies.includes("iris_profile")) return;
  const gate = await api("POST", "/api/gate", { pin: process.env.IRIS_APP_PIN });
  if (gate.status !== 200) throw new Error(`gate failed: ${gate.status}`);
  const prof = await api("POST", "/api/profile", { profileId: "profile-a" });
  if (prof.status !== 200) throw new Error(`profile failed: ${prof.status}`);
  saveState(state);
}

async function readStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const tools = [];
  let failed = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "text_delta" && typeof ev.text === "string") text += ev.text;
        else if (ev.type === "tool_started") tools.push(ev.toolName ?? ev.name ?? "unknown");
        else if (ev.type === "failed") failed = ev.message ?? "failed";
      } catch { /* partial line */ }
    }
  }
  return { text: text.trim(), tools, failed };
}

async function turn({ threadKey, content, day = null, time = null, tag = "" }) {
  await ensureSession();
  const threadId = threadKey === "new" ? null : state.threads[threadKey];
  const urlPath = threadId ? `/api/threads/${threadId}/messages` : "/api/threads/new/messages";
  const res = await api("POST", urlPath, {
    content,
    timezone: "Asia/Kolkata",
    requestId: crypto.randomUUID(),
  });
  if (res.status === 409) return console.log("DUPLICATE — retry with new requestId");
  if (res.status !== 200) {
    console.log(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }
  let { text, tools, failed } = await readStream(res);
  if ((failed || !text) && threadKey !== undefined) {
    console.log("    (run failed/empty — retrying once after backoff)");
    await sleep(35_000);
    const retryBody = { content, timezone: "Asia/Kolkata", requestId: crypto.randomUUID() };
    const retryPath = threadId ? `/api/threads/${threadId}/messages` : "/api/threads/new/messages";
    const retryRes = await api("POST", retryPath, retryBody);
    if (retryRes.status === 200) { ({ text, tools, failed } = await readStream(retryRes)); }
  }
  await sleep(Number(process.env.SIM_TURN_DELAY_MS ?? 18_000));

  // Resolve thread id for new threads by listing threads (newest first).
  let resolvedThreadId = threadId;
  if (!resolvedThreadId) {
    const listRes = await fetch(`${BASE}/api/threads`, { headers: { cookie: state.cookies } });
    const list = await listRes.json();
    const newest = Array.isArray(list?.threads) ? list.threads[0]?.id : (Array.isArray(list) ? list[0]?.id : list?.[0]?.id);
    resolvedThreadId = newest;
  }
  if (threadKey !== "new") state.threads[threadKey] = resolvedThreadId;
  else state.threads[tag || `t${Object.keys(state.threads).length + 1}`] = resolvedThreadId;

  const turnRecord = { at: new Date().toISOString(), day, time, threadKey, threadId: resolvedThreadId, user: content, assistant: text, tools };
  state.turns.push(turnRecord);
  saveState(state);
  log(turnRecord);

  if (day !== null && time) {
    const simDate = simTimestamp(day, time);
    try {
      await backdateTurn(resolvedThreadId, content, text, simDate);
    } catch (e) {
      console.log(`(backdate skipped: ${String(e).slice(0, 120)})`);
    }
  }

  console.log(`\n=== [${threadKey}${day !== null ? ` · d${day} ${time}` : ""}] YOU: ${content.replace(/\s+/g, " ").slice(0, 160)}`);
  if (tools.length) console.log(`    tools: ${tools.join(", ")}`);
  console.log(`    IRIS: ${text.replace(/\s+/g, " ").slice(0, 700) || `(empty${failed ? ` — ${failed}` : ""})`}`);
}

async function backdateTurn(threadId, userText, assistantText, iso) {
  const { createClient } = await import(pathToFileURL(path.join(ROOT, "node_modules", "@supabase", "supabase-js", "dist", "index.mjs")).href);
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: msgs } = await db.from("messages").select("id,role,content,created_at").eq("thread_id", threadId).order("created_at", { ascending: false }).limit(6);
  const targets = [];
  for (const m of msgs ?? []) {
    if (m.role === "user" && m.content === userText) targets.push(m.id);
    if (m.role === "assistant" && assistantText && m.content === assistantText) targets.push(m.id);
  }
  if (targets.length === 0) throw new Error("no matching messages to backdate");
  const { error } = await db.from("messages").update({ created_at: iso }).in("id", targets);
  if (error) throw new Error(error.message);
  await db.from("threads").update({ updated_at: iso }).eq("id", threadId);
}

function simTimestamp(day, time) {
  const now = new Date();
  const [h, m] = time.split(":").map(Number);
  const daysAgo = 15 - Number(day);
  const d = new Date(now.getTime() - daysAgo * 86_400_000);
  d.setUTCHours(h - 5, m, Math.floor(Math.random() * 59), 0); // IST→UTC approx
  return d.toISOString();
}

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function sweep() {
  const res = await api("POST", "/api/internal/accountability/sweep", {}, { "x-iris-worker-secret": process.env.MEMORY_WORKER_SECRET ?? "" });
  console.log("SWEEP:", JSON.stringify(await res.json()));
}

async function consolidate() {
  const res = await api("POST", "/api/internal/memory/consolidate", {}, { "x-iris-worker-secret": process.env.MEMORY_WORKER_SECRET ?? "" });
  console.log("CONSOLIDATE:", JSON.stringify(await res.json()).slice(0, 400));
}

async function forcedue() {
  const { createClient } = await import(pathToFileURL(path.join(ROOT, "node_modules", "@supabase", "supabase-js", "dist", "index.mjs")).href);
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const past = new Date(Date.now() - 120_000).toISOString();
  const { data, error } = await db.from("scheduled_checks").update({ due_at: past }).eq("status", "pending").select("id");
  console.log(`FORCEDUE: ${error ? error.message : `${data.length} checks made due`}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "turn") {
  const [threadKey, day, time, tag, ...textParts] = rest;
  await turn({ threadKey, content: textParts.join(" "), day: day ? Number(day) : null, time: time || null, tag: tag === "-" ? "" : tag });
} else if (cmd === "sweep") await sweep();
else if (cmd === "consolidate") await consolidate();
else if (cmd === "forcedue") await forcedue();
else console.log("usage: driver.mjs turn <key|new> <day|- > <HH:MM|-> <tag|-> <text...> | sweep | consolidate | forcedue");
