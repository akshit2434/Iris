import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memoryWorker: vi.fn(),
  runAccountabilitySweep: vi.fn(),
}));

vi.mock("../../memory/consolidate/route", () => ({ POST: mocks.memoryWorker }));
vi.mock("@/server/accountability/sweeper", () => ({ runAccountabilitySweep: mocks.runAccountabilitySweep }));

import { GET } from "./route";

const request = (authorization?: string) => new Request("https://example.test/api/internal/cron/workers", {
  headers: authorization ? { authorization } : undefined,
});

describe("cron worker adapter", () => {
  beforeEach(() => {
    process.env.SUPABASE_CRON_SECRET = "cron-secret";
    delete process.env.CRON_SECRET;
    process.env.MEMORY_WORKER_SECRET = "worker-secret";
    mocks.memoryWorker.mockReset();
    mocks.runAccountabilitySweep.mockReset();
  });

  it("keeps the legacy cron secret as a backwards-compatible fallback", async () => {
    delete process.env.SUPABASE_CRON_SECRET;
    process.env.CRON_SECRET = "legacy-cron-secret";
    mocks.memoryWorker.mockResolvedValue(new Response(JSON.stringify({ claimed: 0, completed: 0, skipped: 0, failed: 0 }), { status: 200 }));
    mocks.runAccountabilitySweep.mockResolvedValue({ profiles: [], at: "2026-09-03T12:00:00.000Z" });
    const response = await GET(request("Bearer legacy-cron-secret"));
    expect(response.status).toBe(200);
  });

  it("rejects requests without the bearer cron secret", async () => {
    const response = await GET(request("Bearer wrong"));
    expect(response.status).toBe(401);
    expect(mocks.memoryWorker).not.toHaveBeenCalled();
    expect(mocks.runAccountabilitySweep).not.toHaveBeenCalled();
  });

  it("runs both workers and returns aggregate safe counts", async () => {
    mocks.memoryWorker.mockImplementation(async (workerRequest: Request) => {
      expect(workerRequest.method).toBe("POST");
      expect(workerRequest.headers.get("x-iris-worker-secret")).toBe("worker-secret");
      expect(await workerRequest.json()).toEqual({ limit: 1 });
      return new Response(JSON.stringify({ claimed: 3, completed: 2, skipped: 1, failed: 0 }), { status: 200 });
    });
    mocks.runAccountabilitySweep.mockResolvedValue({
      at: "2026-09-03T12:00:00.000Z",
      profiles: [
        { profileId: "profile-a", selected: 2, delivered: 1, mergedBatches: 1, cancelledStale: 0, cancelledOrphans: 0, skippedNoThread: 0, suppressed: 0, failed: 0 },
        { profileId: "profile-b", selected: 1, delivered: 1, mergedBatches: 0, cancelledStale: 1, cancelledOrphans: 0, skippedNoThread: 0, suppressed: 0, failed: 0 },
      ],
    });

    const response = await GET(request("Bearer cron-secret"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      memory: { claimed: 3, completed: 2, skipped: 1, failed: 0 },
      accountability: { selected: 3, delivered: 2, mergedBatches: 1, cancelledStale: 1, failed: 0 },
    });
  });
});
