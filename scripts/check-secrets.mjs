import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const trackedFiles = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const binaryExtension = /\.(png|jpe?g|gif|webp|ico|pdf|zip|woff2?|ttf)$/i;
const patterns = [
  /(?:OPENROUTER_API_KEY|SUPABASE_SERVICE_ROLE_KEY|IRIS_APP_PIN)\s*=\s*(?!your-|replace-with|change-me|\.\.\.)[^\s#]+/i,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /-----BEGIN (?:RSA|OPENSSH|EC|DSA|PRIVATE) KEY-----/,
];

const findings = [];
for (const file of trackedFiles) {
  if (!existsSync(file)) continue;
  if (binaryExtension.test(file)) continue;

  const content = readFileSync(file, "utf8");
  for (const pattern of patterns) {
    if (pattern.test(content)) {
      findings.push(file);
      break;
    }
  }
}

if (findings.length > 0) {
  console.error("Potential secret-like content found in tracked files:");
  for (const file of findings) console.error(`- ${file}`);
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed for ${trackedFiles.length} tracked files.`);
}
