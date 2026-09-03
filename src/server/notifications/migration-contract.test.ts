import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Database } from "@/server/db/types";

const migration = readFileSync(new URL("../../../supabase/migrations/20260904100001_notifications.sql", import.meta.url), "utf8").toLowerCase();

describe("notifications migration contract", () => {
  it("keeps preferences and subscriptions profile-scoped and private", () => {
    for (const fragment of ["profile_notification_preferences", "push_subscriptions", "references public.profiles(id) on delete cascade", "enable row level security", "revoke all on table public.push_subscriptions"]) expect(migration).toContain(fragment);
  });

  it("exposes the notification tables to the typed database client", () => {
    const tables: Array<keyof Database["public"]["Tables"]> = ["profile_notification_preferences", "push_subscriptions"];
    expect(tables).toHaveLength(2);
  });
});
