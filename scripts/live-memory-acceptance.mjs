import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const enabled = process.env.IRIS_RUN_LIVE_MEMORY_ACCEPTANCE === "1";
if (!enabled) {
  console.error("Live memory acceptance is disabled. Set IRIS_RUN_LIVE_MEMORY_ACCEPTANCE=1 explicitly.");
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Vitest does not reliably expose .env.local through process.env. Load only
// missing names in memory; values are never logged or written to the report.
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

loadLocalEnv();
if (!process.env.OPENROUTER_API_KEY) {
  console.error("Live memory acceptance requires an OpenRouter key in the environment.");
  process.exit(2);
}

const resultFile = path.join(root, `.iris-live-acceptance-${process.pid}.json`);
const vitestEntry = path.join(root, "node_modules", "vitest", "vitest.mjs");
const childEnv = { ...process.env, IRIS_LIVE_ACCEPTANCE_RESULT_FILE: resultFile };
const result = spawnSync(process.execPath, [vitestEntry, "run", "scripts/live-memory-acceptance.test.ts", "--reporter=dot", "--testTimeout=120000", "--hookTimeout=120000"], {
  cwd: root,
  env: childEnv,
  encoding: "utf8",
  maxBuffer: 1_000_000,
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
const safeTools = Array.isArray(value.observedToolNames)
  ? value.observedToolNames.filter((item) => typeof item === "string").slice(0, 12)
  : [];
const safeAssertions = value.assertions && typeof value.assertions === "object" ? value.assertions : {};
function classifyChildFailure(text) {
  const normalized = text.toLocaleLowerCase();
  if (normalized.includes("timed out")) return "child_timeout";
  if (normalized.includes("profile_missing")) return "profile_missing";
  if (normalized.includes("supabase") || normalized.includes("database")) return "local_database_error";
  if (normalized.includes("openrouter") || normalized.includes("api key")) return "provider_configuration_error";
  return "child_failed_before_report";
}
const output = {
  status: value.status === "passed" ? "passed" : "failed",
  model: typeof value.model === "string" ? value.model.slice(0, 120) : "unknown",
  requestCount: Number.isInteger(value.requestCount) ? value.requestCount : null,
  observedToolNames: safeTools,
  assertions: safeAssertions,
  ...(typeof value.errorCode === "string" ? { errorCode: value.errorCode.slice(0, 80) } : {}),
  ...(value.status === "running" ? { errorCode: result.signal ? `child_${String(result.signal).toLowerCase()}` : classifyChildFailure(`${result.stdout ?? ""}\n${result.stderr ?? ""}`) } : {}),
  ...(value.status === "running" ? { childStatus: result.status, childSignal: result.signal ?? null } : {}),
};
console.log(JSON.stringify(output));
process.exit(result.status === 0 && output.status === "passed" ? 0 : 1);
