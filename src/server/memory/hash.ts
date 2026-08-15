import "server-only";

import { createHash } from "node:crypto";

export function hashMemoryContent(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
