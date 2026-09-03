import "server-only";

import webpush from "web-push";
import type { ProfileId } from "@/lib/profiles";
import { getDatabase } from "@/server/db/client";

export type NotificationPreferences = {
  enabled: boolean;
  previewLevel: "none" | "summary";
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timeZone: string;
  salience: "silent" | "normal" | "important";
};

export type PushSubscriptionInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  deviceId: string;
  permission: "granted" | "denied" | "default";
  userAgent?: string | null;
};

const DEFAULT_PREFERENCES: NotificationPreferences = {
  enabled: true,
  previewLevel: "none",
  quietHoursStart: null,
  quietHoursEnd: null,
  timeZone: "UTC",
  salience: "normal",
};

function toPreferences(row: {
  enabled: boolean; preview_level: "none" | "summary"; quiet_hours_start: string | null; quiet_hours_end: string | null; time_zone: string; salience: "silent" | "normal" | "important";
} | null): NotificationPreferences {
  if (!row) return DEFAULT_PREFERENCES;
  return { enabled: row.enabled, previewLevel: row.preview_level, quietHoursStart: row.quiet_hours_start, quietHoursEnd: row.quiet_hours_end, timeZone: row.time_zone, salience: row.salience };
}

export async function getNotificationPreferences(profileId: ProfileId): Promise<NotificationPreferences> {
  const { data, error } = await getDatabase().from("profile_notification_preferences")
    .select("enabled, preview_level, quiet_hours_start, quiet_hours_end, time_zone, salience")
    .eq("profile_id", profileId).maybeSingle();
  if (error) throw error;
  return toPreferences(data);
}

export async function updateNotificationPreferences(profileId: ProfileId, preferences: NotificationPreferences): Promise<NotificationPreferences> {
  const { data, error } = await getDatabase().from("profile_notification_preferences").upsert({
    profile_id: profileId, enabled: preferences.enabled, preview_level: preferences.previewLevel,
    quiet_hours_start: preferences.quietHoursStart, quiet_hours_end: preferences.quietHoursEnd,
    time_zone: preferences.timeZone, salience: preferences.salience, updated_at: new Date().toISOString(),
  }, { onConflict: "profile_id" }).select("enabled, preview_level, quiet_hours_start, quiet_hours_end, time_zone, salience").single();
  if (error) throw error;
  return toPreferences(data);
}

export async function registerPushSubscription(profileId: ProfileId, input: PushSubscriptionInput): Promise<void> {
  const { error } = await getDatabase().from("push_subscriptions").upsert({
    profile_id: profileId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth,
    device_id: input.deviceId, permission: input.permission, user_agent: input.userAgent ?? null,
    revoked_at: input.permission === "granted" ? null : new Date().toISOString(), updated_at: new Date().toISOString(),
  }, { onConflict: "profile_id,device_id" });
  if (error) throw error;
}

export async function revokePushSubscription(profileId: ProfileId, deviceId: string): Promise<void> {
  const { error } = await getDatabase().from("push_subscriptions")
    .update({ revoked_at: new Date().toISOString(), permission: "denied", updated_at: new Date().toISOString() })
    .eq("profile_id", profileId).eq("device_id", deviceId);
  if (error) throw error;
}

function localTime(instant: Date, timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant);
  } catch { return null; }
}

export function isWithinQuietHours(preferences: NotificationPreferences, now = new Date()): boolean {
  if (!preferences.quietHoursStart || !preferences.quietHoursEnd) return false;
  const current = localTime(now, preferences.timeZone);
  if (!current || preferences.quietHoursStart === preferences.quietHoursEnd) return false;
  return preferences.quietHoursStart < preferences.quietHoursEnd
    ? current >= preferences.quietHoursStart && current < preferences.quietHoursEnd
    : current >= preferences.quietHoursStart || current < preferences.quietHoursEnd;
}

export async function sendDeliveryPush(input: { profileId: ProfileId; threadId: string; messageId: string; summary: string | null; now?: Date }): Promise<{ attempted: number; sent: number; reason?: string }> {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return { attempted: 0, sent: 0, reason: "not_configured" };
  const preferences = await getNotificationPreferences(input.profileId);
  if (!preferences.enabled || isWithinQuietHours(preferences, input.now)) return { attempted: 0, sent: 0, reason: "disabled_or_quiet_hours" };
  webpush.setVapidDetails(subject, publicKey, privateKey);
  const { data, error } = await getDatabase().from("push_subscriptions")
    .select("id, endpoint, p256dh, auth").eq("profile_id", input.profileId).eq("permission", "granted").is("revoked_at", null);
  if (error) throw error;
  const payload = JSON.stringify({ title: "Iris", body: preferences.previewLevel === "summary" ? (input.summary ?? "You have a follow-up.") : "You have a follow-up.", threadId: input.threadId, messageId: input.messageId, tag: `iris-delivery-${input.messageId}`, silent: preferences.salience === "silent" });
  let sent = 0;
  await Promise.all((data ?? []).map(async (subscription) => {
    try {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload, { TTL: 60 * 60 });
      sent += 1;
      await getDatabase().from("push_subscriptions").update({ last_success_at: new Date().toISOString(), last_failure_at: null, last_failure_code: null, updated_at: new Date().toISOString() }).eq("id", subscription.id);
    } catch (error) {
      const statusCode = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 0;
      await getDatabase().from("push_subscriptions").update({ last_failure_at: new Date().toISOString(), last_failure_code: statusCode ? `http_${statusCode}` : "send_failed", revoked_at: statusCode === 404 || statusCode === 410 ? new Date().toISOString() : null, updated_at: new Date().toISOString() }).eq("id", subscription.id);
      console.warn(JSON.stringify({ scope: "push", stage: "send", profileId: input.profileId, code: statusCode || "send_failed" }));
    }
  }));
  return { attempted: (data ?? []).length, sent };
}
