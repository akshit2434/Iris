import { NextResponse } from "next/server";
import { z } from "zod";
import { assertAppAccess } from "@/server/auth/gate";
import { getSelectedProfile } from "@/server/auth/profile";
import { getNotificationPreferences, registerPushSubscription, revokePushSubscription, updateNotificationPreferences } from "@/server/notifications/service";

const deviceId = z.string().min(8).max(200);
const subscriptionSchema = z.object({
  action: z.literal("register"), deviceId,
  subscription: z.object({ endpoint: z.string().url().max(2000), keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(500) }) }),
}).strict();
const revokeSchema = z.object({ action: z.literal("revoke"), deviceId }).strict();
const preferencesSchema = z.object({
  action: z.literal("preferences"), enabled: z.boolean(), previewLevel: z.enum(["none", "summary"]),
  quietHoursStart: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable(), quietHoursEnd: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable(),
  timeZone: z.string().min(1).max(100), salience: z.enum(["silent", "normal", "important"]),
}).strict().refine((value) => (value.quietHoursStart === null) === (value.quietHoursEnd === null), "Quiet hours need both times.");

async function profileOrError() {
  try { await assertAppAccess(); } catch { return null; }
  return getSelectedProfile();
}

export async function GET() {
  const profileId = await profileOrError();
  if (!profileId) return NextResponse.json({ error: "App access and a selected profile are required." }, { status: 401 });
  try {
    const preferences = await getNotificationPreferences(profileId);
    return NextResponse.json({ preferences, pushConfigured: Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY), permission: "unknown" }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "Could not load notification settings." }, { status: 500 }); }
}

export async function POST(request: Request) {
  const profileId = await profileOrError();
  if (!profileId) return NextResponse.json({ error: "App access and a selected profile are required." }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid notification request." }, { status: 400 }); }
  const parsed = z.union([subscriptionSchema, revokeSchema, preferencesSchema]).safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid notification request." }, { status: 400 });
  try {
    if (parsed.data.action === "register") {
      await registerPushSubscription(profileId, { endpoint: parsed.data.subscription.endpoint, keys: parsed.data.subscription.keys, deviceId: parsed.data.deviceId, permission: "granted", userAgent: request.headers.get("user-agent") });
      return NextResponse.json({ ok: true });
    }
    if (parsed.data.action === "revoke") {
      await revokePushSubscription(profileId, parsed.data.deviceId);
      return NextResponse.json({ ok: true });
    }
    const preferences = await updateNotificationPreferences(profileId, parsed.data);
    return NextResponse.json({ preferences });
  } catch { return NextResponse.json({ error: "Could not update notification settings." }, { status: 500 }); }
}
