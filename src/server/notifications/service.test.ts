import { describe, expect, it } from "vitest";
import { isWithinQuietHours, type NotificationPreferences } from "@/server/notifications/service";

const preferences: NotificationPreferences = {
  enabled: true, previewLevel: "none", quietHoursStart: "22:00", quietHoursEnd: "07:00", timeZone: "UTC", salience: "normal",
};

describe("notification quiet-hours policy", () => {
  it("handles an overnight local-time range without suppressing in-app delivery", () => {
    expect(isWithinQuietHours(preferences, new Date("2026-09-03T23:00:00.000Z"))).toBe(true);
    expect(isWithinQuietHours(preferences, new Date("2026-09-03T12:00:00.000Z"))).toBe(false);
  });

  it("treats an equal range as disabled rather than a 24-hour silence", () => {
    expect(isWithinQuietHours({ ...preferences, quietHoursStart: "22:00", quietHoursEnd: "22:00" })).toBe(false);
  });
});
