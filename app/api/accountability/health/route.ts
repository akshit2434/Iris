import { NextResponse } from "next/server";
import { assertAppAccess } from "@/server/auth/gate";
import { getSelectedProfile } from "@/server/auth/profile";
import { getDatabase } from "@/server/db/client";
import { getNotificationPreferences } from "@/server/notifications/service";

export async function GET() {
  try { await assertAppAccess(); } catch { return NextResponse.json({ error: "App access is required." }, { status: 401 }); }
  const profileId = await getSelectedProfile();
  if (!profileId) return NextResponse.json({ error: "Select a profile first." }, { status: 401 });
  try {
    const database = getDatabase();
    const now = new Date().toISOString();
    const [preferences, delivered, overdue, subscription] = await Promise.all([
      getNotificationPreferences(profileId),
      database.from("checkin_deliveries").select("delivered_at").eq("profile_id", profileId).eq("status", "delivered").order("delivered_at", { ascending: false }).limit(1).maybeSingle(),
      database.from("scheduled_checks").select("due_at").eq("profile_id", profileId).eq("status", "pending").lte("due_at", now).order("due_at", { ascending: true }).limit(1).maybeSingle(),
      database.from("push_subscriptions").select("last_failure_at, last_failure_code, revoked_at").eq("profile_id", profileId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (delivered.error || overdue.error || subscription.error) throw new Error("health query failed");
    const needsAction = !preferences.enabled || Boolean(overdue.data) || Boolean(subscription.data?.last_failure_at && !subscription.data.revoked_at);
    const message = !preferences.enabled ? "Notifications are off." : overdue.data ? "Iris could not deliver follow-ups recently." : subscription.data?.last_failure_at && !subscription.data.revoked_at ? "Push notifications need attention." : null;
    return NextResponse.json({ needsAction, message, lastSuccessfulSweep: delivered.data?.delivered_at ?? null, oldestDueUndelivered: overdue.data?.due_at ?? null, pushAvailable: Boolean(subscription.data && !subscription.data.revoked_at), lastFailureCode: subscription.data?.last_failure_code ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "Could not load delivery health." }, { status: 500 }); }
}
