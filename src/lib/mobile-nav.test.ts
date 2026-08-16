import { describe, expect, it } from "vitest";
import { MOBILE_NAV_DESTINATIONS, MOBILE_NAV_SLOTS, canCreateNewChat, isMobileNavActive, PROFILE_ROUTE } from "@/lib/mobile-nav";

describe("mobile navigation", () => {
  it("keeps the center action in a symmetrical five-slot order", () => {
    expect(MOBILE_NAV_SLOTS).toEqual(["home", "history", "new-chat", "files", "profile"]);
    expect(MOBILE_NAV_SLOTS.indexOf("new-chat")).toBe(2);
    expect(MOBILE_NAV_DESTINATIONS.map(({ href }) => href)).toEqual(["/", "/history", "/files", PROFILE_ROUTE]);
  });

  it("marks nested destination routes active without activating the center action", () => {
    expect(isMobileNavActive("/", "/")).toBe(true);
    expect(isMobileNavActive("/", "/history")).toBe(false);
    expect(isMobileNavActive("/history", "/history/abc")).toBe(true);
    expect(isMobileNavActive("/files", "/profile")).toBe(false);
    expect(isMobileNavActive(PROFILE_ROUTE, "/profile")).toBe(true);
  });

  it("guards duplicate new-chat submissions and missing profile scope", () => {
    expect(canCreateNewChat("profile-a", false)).toBe(true);
    expect(canCreateNewChat("profile-a", true)).toBe(false);
    expect(canCreateNewChat(null, false)).toBe(false);
  });
});
