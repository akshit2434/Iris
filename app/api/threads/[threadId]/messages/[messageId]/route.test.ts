import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertAppAccess: vi.fn(async () => undefined),
  getSelectedProfile: vi.fn(async () => "profile-a" as const),
  readMessages: vi.fn(),
}));

vi.mock("@/server/auth/gate", () => ({ assertAppAccess: mocks.assertAppAccess }));
vi.mock("@/server/auth/profile", () => ({ getSelectedProfile: mocks.getSelectedProfile }));
vi.mock("@/server/memory/retrieval", () => ({
  createProductionMemoryRetrievalService: () => ({ readMessages: mocks.readMessages }),
}));

import { GET } from "@/../app/api/threads/[threadId]/messages/[messageId]/route";

const threadId = "00000000-0000-4000-8000-000000000011";
const messageId = "00000000-0000-4000-8000-000000000012";

function context(profileId: "profile-a" | "profile-b" = "profile-a") {
  return {
    thread: { id: threadId, profileId, title: "Source chat", createdAt: "2026-08-15T10:00:00.000Z", updatedAt: "2026-08-15T10:01:00.000Z" },
    target: { messageId, threadId, profileId, role: "user" as const, content: "Original assertion", createdAt: "2026-08-15T10:00:00.000Z" },
    before: [], after: [],
  };
}

describe("source preview route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSelectedProfile.mockResolvedValue("profile-a");
    mocks.readMessages.mockResolvedValue(context());
  });

  it("returns only an exact source re-read inside the selected profile", async () => {
    const response = await GET(new Request("http://localhost"), { params: Promise.resolve({ threadId, messageId }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ source: context() });
    expect(mocks.readMessages).toHaveBeenCalledWith("profile-a", messageId, 3);
  });

  it("rejects a foreign-profile context even if its IDs otherwise match", async () => {
    mocks.readMessages.mockResolvedValue(context("profile-b"));
    const response = await GET(new Request("http://localhost"), { params: Promise.resolve({ threadId, messageId }) });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Source message is no longer available." });
  });

  it("rejects a context window containing a foreign neighbor", async () => {
    mocks.readMessages.mockResolvedValue({
      ...context(),
      before: [{ messageId: "00000000-0000-4000-8000-000000000013", threadId, profileId: "profile-b", role: "assistant", content: "Foreign", createdAt: "2026-08-15T09:59:00.000Z" }],
    });
    const response = await GET(new Request("http://localhost"), { params: Promise.resolve({ threadId, messageId }) });
    expect(response.status).toBe(404);
  });

  it("does not query source storage when app access fails", async () => {
    mocks.assertAppAccess.mockRejectedValueOnce(new Error("locked"));
    const response = await GET(new Request("http://localhost"), { params: Promise.resolve({ threadId, messageId }) });
    expect(response.status).toBe(401);
    expect(mocks.readMessages).not.toHaveBeenCalled();
  });
});
