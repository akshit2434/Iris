import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadLocalEnv() {
  const envPath = path.join(root, ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
    process.env[match[1]] = value;
  }
}

function skip(message) {
  console.log(`SKIP: ${message}`);
  process.exit(0);
}

const PROFILE_ID = "profile-a";
const SWEEP_PATH = "/api/internal/accountability/sweep";
const REQUEST_TIMEOUT_MS = 30_000;

loadLocalEnv();

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const workerSecret = process.env.MEMORY_WORKER_SECRET;
if (!supabaseUrl || !serviceRoleKey) {
  skip("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not configured for a local Supabase instance.");
}
if (!workerSecret) {
  skip("MEMORY_WORKER_SECRET is not configured; the sweep endpoint cannot be authenticated.");
}

const supabaseHost = new URL(supabaseUrl).hostname;
const isLocalSupabase = supabaseHost === "127.0.0.1" || supabaseHost === "localhost";
if (!isLocalSupabase && process.env.IRIS_ALLOW_REMOTE_LIVE_ACCOUNTABILITY !== "1") {
  skip(`SUPABASE_URL (${supabaseHost}) is not a local Supabase instance; refusing to seed synthetic rows remotely.`);
}

const baseUrl = (process.env.IRIS_ACCOUNTABILITY_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");

async function probeSweepEndpoint() {
  try {
    const response = await fetch(`${baseUrl}${SWEEP_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    return response.status === 401 && text.includes("Unauthorized");
  } catch {
    return false;
  }
}

if (!(await probeSweepEndpoint())) {
  skip(`No reachable Iris Next dev server answering at ${baseUrl}${SWEEP_PATH}.`);
}

const database = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const tag = `accept-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const nowIso = new Date().toISOString();
const pastDueAt = new Date(Date.now() - 60_000).toISOString();
const threadId = crypto.randomUUID();
const seedMessageId = crypto.randomUUID();
const loopId = crypto.randomUUID();
const checkId = crypto.randomUUID();
const loopTitle = `[live-acceptance ${tag}] Renew synthetic passport`;

const ledger = { threadId, messageIds: [seedMessageId], deliveryIds: [], checkId, loopId };
let seeded = false;

async function insertRow(table, row) {
  const { error } = await database.from(table).insert(row);
  if (error) throw new Error(`seed ${table}: ${error.message}`);
}

async function cleanup() {
  const problems = [];
  const { error: checkError } = await database.from("scheduled_checks").delete().eq("profile_id", PROFILE_ID).eq("id", ledger.checkId);
  if (checkError) problems.push(`scheduled_checks: ${checkError.message}`);
  const { data: threadDeliveries } = await database
    .from("checkin_deliveries")
    .select("id")
    .eq("profile_id", PROFILE_ID)
    .eq("thread_id", ledger.threadId);
  const deliveryIds = [...new Set([...ledger.deliveryIds, ...(threadDeliveries ?? []).map((row) => row.id)])];
  if (deliveryIds.length > 0) {
    const { error } = await database.from("checkin_deliveries").delete().eq("profile_id", PROFILE_ID).in("id", deliveryIds);
    if (error) problems.push(`deliveries: ${error.message}`);
  }
  const { error: threadError } = await database.from("threads").delete().eq("profile_id", PROFILE_ID).eq("id", ledger.threadId);
  if (threadError) problems.push(`thread+messages: ${threadError.message}`);
  const { error: loopDeleteError } = await database.from("open_loops").delete().eq("profile_id", PROFILE_ID).eq("id", ledger.loopId);
  let residue = null;
  if (loopDeleteError) {
    const { error: cancelError } = await database
      .from("open_loops")
      .update({ status: "cancelled", closed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("profile_id", PROFILE_ID)
      .eq("id", ledger.loopId);
    if (cancelError) {
      problems.push(`open_loops: ${loopDeleteError.message}; cancel fallback: ${cancelError.message}`);
    } else {
      residue = `immutable nudged loop_event keeps loop ${ledger.loopId} alive; it was force-cancelled (title "${loopTitle}")`;
    }
  }
  return { problems, residue };
}

async function singleOrThrow(query, label) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

try {
  const profile = await singleOrThrow(
    database.from("profiles").select("id").eq("id", PROFILE_ID).maybeSingle(),
    "profiles",
  );
  if (!profile) throw new Error(`Profile "${PROFILE_ID}" is missing from the local database.`);

  await insertRow("threads", { id: threadId, profile_id: PROFILE_ID, title: `Synthetic ${tag}`, created_at: nowIso, updated_at: nowIso });
  await insertRow("messages", { id: seedMessageId, thread_id: threadId, profile_id: PROFILE_ID, role: "user", content: `${tag}: synthetic seed so the thread is listed.`, created_at: nowIso });
  await insertRow("open_loops", { id: loopId, profile_id: PROFILE_ID, title: loopTitle, kind: "commitment", due_at: pastDueAt });
  await insertRow("scheduled_checks", { id: checkId, profile_id: PROFILE_ID, loop_id: loopId, due_at: pastDueAt });
  seeded = true;

  const sweepResponse = await fetch(`${baseUrl}${SWEEP_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-iris-worker-secret": workerSecret },
    body: "{}",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (sweepResponse.status !== 200) throw new Error(`sweep endpoint returned HTTP ${sweepResponse.status}`);
  const report = await sweepResponse.json();
  const profileReport = Array.isArray(report?.profiles) ? report.profiles.find((entry) => entry.profileId === PROFILE_ID) : null;
  if (!profileReport) throw new Error("sweep report has no entry for profile-a");

  const checkRow = await singleOrThrow(
    database.from("scheduled_checks").select("id, status, attempt_count, escalation_tier, delivery_id, delivered_at").eq("profile_id", PROFILE_ID).eq("id", checkId).maybeSingle(),
    "read check",
  );
  if (checkRow?.delivery_id) ledger.deliveryIds.push(checkRow.delivery_id);
  const deliveryRow = checkRow?.delivery_id
    ? await singleOrThrow(
        database.from("checkin_deliveries").select("id, thread_id, message_id, status, delivered_at").eq("profile_id", PROFILE_ID).eq("id", checkRow.delivery_id).maybeSingle(),
        "read delivery",
      )
    : null;
  const assistantMessages = deliveryRow?.message_id
    ? await singleOrThrow(
        database.from("messages").select("id, content").eq("profile_id", PROFILE_ID).eq("thread_id", threadId).eq("role", "assistant").ilike("content", `%${tag}%`),
        "read assistant message",
      )
    : [];
  const newestThread = await singleOrThrow(
    database.from("threads").select("id").eq("profile_id", PROFILE_ID).is("archived_at", null).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    "read newest thread",
  );

  const assertions = {
    sweepSelectedAndDelivered: Boolean(profileReport && profileReport.selected >= 1 && profileReport.delivered >= 1 && profileReport.failed === 0),
    checkMarkedDelivered: Boolean(checkRow && checkRow.status === "delivered" && checkRow.attempt_count >= 1 && checkRow.delivery_id && checkRow.delivered_at),
    deliveryMarkedDelivered: Boolean(deliveryRow && deliveryRow.status === "delivered" && deliveryRow.message_id && deliveryRow.thread_id === threadId),
    assistantMessageInNewestThread: assistantMessages.length >= 1 && newestThread?.id === threadId,
  };

  const passed = Object.values(assertions).every(Boolean);
  const { problems, residue } = await cleanup();
  console.log(JSON.stringify({ status: passed && problems.length === 0 ? "passed" : "failed", endpoint: `${baseUrl}${SWEEP_PATH}`, tag, assertions, residue, cleanupProblems: problems }));
  console.log(passed && problems.length === 0 ? "PASS: live accountability acceptance" : "FAIL: live accountability acceptance");
  process.exit(passed && problems.length === 0 ? 0 : 1);
} catch (error) {
  const cleanupResult = seeded ? await cleanup() : { problems: [], residue: null };
  console.log(JSON.stringify({ status: "failed", endpoint: `${baseUrl}${SWEEP_PATH}`, tag, errorCode: error instanceof Error ? error.message.slice(0, 200) : "unknown", residue: cleanupResult.residue, cleanupProblems: cleanupResult.problems }));
  console.log("FAIL: live accountability acceptance");
  process.exit(1);
}
