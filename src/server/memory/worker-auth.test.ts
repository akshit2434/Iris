import { describe, expect, it } from "vitest";
import { hasWorkerSecret } from "@/server/memory/worker-auth";

describe("memory worker auth", () => {
  it("rejects missing and wrong secrets without reaching worker code", () => {
    const previous = process.env.MEMORY_WORKER_SECRET;
    process.env.MEMORY_WORKER_SECRET = "worker-secret";
    try {
      expect(hasWorkerSecret("")).toBe(false);
      expect(hasWorkerSecret("wrong")).toBe(false);
      expect(hasWorkerSecret("worker-secret")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.MEMORY_WORKER_SECRET;
      else process.env.MEMORY_WORKER_SECRET = previous;
    }
  });
});
