import "server-only";

import { cookies } from "next/headers";
import { isProfileId, PROFILE_COOKIE, type ProfileId } from "@/lib/profiles";

export async function getSelectedProfile(): Promise<ProfileId | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get(PROFILE_COOKIE)?.value;
  return isProfileId(value) ? value : null;
}
