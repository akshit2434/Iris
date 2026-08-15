import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const trackedFiles = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const forbiddenPaths = [
  /^iris_context_pack\//,
  /^\.private\//,
  /^private_context\//,
  /(^|\/)(?:data|exports|backups|uploads|storage)\//,
  /\.(?:sqlite3?|db|jsonl|pem|key|p12|pfx)$/i,
];

const denylistPath = ".private/privacy-denylist.txt";
const denylist = existsSync(denylistPath)
  ? readFileSync(denylistPath, "utf8").split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
  : [];

const findings = [];
for (const file of trackedFiles) {
  if (!existsSync(file)) continue;
  const isPrivateEnvironmentFile = /(^|\/)\.env(?:\.|$)/.test(file) && file !== ".env.example";
  if (isPrivateEnvironmentFile || forbiddenPaths.some((pattern) => pattern.test(file))) {
    findings.push(`${file} is a private path or file type`);
    continue;
  }

  if (denylist.length === 0) continue;
  const content = readFileSync(file, "utf8").toLocaleLowerCase();
  for (const entry of denylist) {
    if (content.includes(entry.toLocaleLowerCase())) {
      findings.push(`${file} contains a locally denied term`);
      break;
    }
  }
}

if (findings.length > 0) {
  console.error("Privacy check failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Privacy check passed for ${trackedFiles.length} tracked files.`);
}
