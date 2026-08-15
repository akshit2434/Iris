export const PROFILE_COOKIE = "iris-profile";
export const PROFILE_STORAGE_KEY = "iris-profile";

export const PROFILE_IDS = ["profile-a", "profile-b"] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

export const DEFAULT_PROFILE_LABELS: Record<ProfileId, string> = {
  "profile-a": "Profile A",
  "profile-b": "Profile B",
};

export function isProfileId(value: unknown): value is ProfileId {
  return typeof value === "string" && PROFILE_IDS.includes(value as ProfileId);
}
