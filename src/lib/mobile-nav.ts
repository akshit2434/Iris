export type MobileNavDestination = {
  href: "/" | "/history" | "/files" | "/profile";
  label: "Home" | "History" | "Files" | "Profile";
  icon: "home" | "history" | "files" | "profile";
};

export const MOBILE_NAV_DESTINATIONS: readonly MobileNavDestination[] = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/history", label: "History", icon: "history" },
  { href: "/files", label: "Files", icon: "files" },
  { href: "/profile", label: "Profile", icon: "profile" },
];

export const MOBILE_NAV_SLOTS = ["home", "history", "new-chat", "files", "profile"] as const;
export const PROFILE_ROUTE = "/profile" as const;

export type MobileNavSlot = (typeof MOBILE_NAV_SLOTS)[number];

export function isMobileNavActive(href: string, pathname: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function canCreateNewChat(profileId: string | null, isCreating: boolean) {
  return Boolean(profileId) && !isCreating;
}
