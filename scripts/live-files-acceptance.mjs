import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const enabled = process.env.IRIS_RUN_LIVE_FILES_ACCEPTANCE === "1";
if (!enabled) {
  console.error("Live files acceptance is disabled. Set IRIS_RUN_LIVE_FILES_ACCEPTANCE=1 explicitly.");
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadLocalEnv() {
  const envPath = path.join(root, ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

loadLocalEnv();
for (const name of ["IRIS_APP_PIN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENROUTER_API_KEY"]) {
  if (!process.env[name]) {
    console.error(`Live files acceptance requires ${name} in the environment.`);
    process.exit(2);
  }
}

const supabaseHost = new URL(process.env.SUPABASE_URL).hostname;
const isLocalSupabase = supabaseHost === "127.0.0.1" || supabaseHost === "localhost";
if (!isLocalSupabase && process.env.IRIS_ALLOW_REMOTE_LIVE_FILES !== "1") {
  console.log(`SKIP: SUPABASE_URL (${supabaseHost}) is remote; refusing synthetic file upload without IRIS_ALLOW_REMOTE_LIVE_FILES=1.`);
  process.exit(0);
}

const resultFile = path.join(root, `.iris-live-files-${process.pid}.json`);
const vitestEntry = path.join(root, "node_modules", "vitest", "vitest.mjs");
const childEnv = { ...process.env, IRIS_LIVE_FILES_ACCEPTANCE_RESULT_FILE: resultFile };
const result = spawnSync(process.execPath, [vitestEntry, "run", "scripts/live-files-acceptance.test.ts", "--reporter=dot", "--testTimeout=120000", "--hookTimeout=120000"], {
  cwd: root,
  env: childEnv,
  encoding: "utf8",
  maxBuffer: 1_000_000,
  timeout: 360_000,
  killSignal: "SIGTERM",
});

let report = null;
try {
  if (existsSync(resultFile)) report = JSON.parse(readFileSync(resultFile, "utf8"));
} catch {
  report = null;
} finally {
  try { unlinkSync(resultFile); } catch { /* already cleaned by the child */ }
}

if (!report || typeof report !== "object") {
  console.log(JSON.stringify({ status: "error", errorCode: "acceptance_result_missing" }));
  process.exit(1);
}

const value = report;
const output = {
  status: value.status === "passed" ? "passed" : "failed",
  model: typeof value.model === "string" ? value.model.slice(0, 120) : "unknown",
  requestCount: Number.isInteger(value.requestCount) ? value.requestCount : null,
  observedToolNames: Array.isArray(value.observedToolNames) ? value.observedToolNames.filter((item) => typeof item === "string").slice(0, 12) : [],
  assertions: value.assertions && typeof value.assertions === "object" ? value.assertions : {},
  ...(typeof value.errorCode === "string" ? { errorCode: value.errorCode.slice(0, 120) } : {}),
};
console.log(JSON.stringify(output));
process.exit(result.status === 0 && output.status === "passed" ? 0 : 1);
