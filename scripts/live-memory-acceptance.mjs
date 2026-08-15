import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const enabled = process.env.IRIS_RUN_LIVE_MEMORY_ACCEPTANCE === "1";
if (!enabled) {
  console.error("Live memory acceptance is disabled. Set IRIS_RUN_LIVE_MEMORY_ACCEPTANCE=1 explicitly.");
  process.exit(2);
}

if (!process.env.OPENROUTER_API_KEY) {
  console.error("Live memory acceptance requires an OpenRouter key in the environment.");
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitestEntry = path.join(root, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(process.execPath, [vitestEntry, "run", "scripts/live-memory-acceptance.test.ts", "--reporter=dot"], {
  cwd: root,
  env: process.env,
  encoding: "utf8",
  maxBuffer: 1_000_000,
});

const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const marker = output.match(/IRIS_LIVE_ACCEPTANCE_RESULT:(\{[^\n]+\})/);
if (result.status === 0 && marker) {
  try {
    const parsed = JSON.parse(marker[1]);
    const tools = Array.isArray(parsed.observedToolNames) ? parsed.observedToolNames.filter((value) => typeof value === "string").slice(0, 8) : [];
    const assertions = parsed.assertions && typeof parsed.assertions === "object" ? parsed.assertions : {};
    console.log(JSON.stringify({
      model: typeof parsed.model === "string" ? parsed.model : "unknown",
      totalRequests: parsed.totalRequests === 4 ? 4 : null,
      observedToolNames: tools,
      assertions,
    }));
    process.exit(0);
  } catch {
    // Fall through to the intentionally terse failure below.
  }
}

console.log("FAIL synthetic_memory_acceptance");
process.exit(1);
