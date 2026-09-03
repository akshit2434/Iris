"use client";

import { useEffect, useState } from "react";

type Preferences = { enabled: boolean; previewLevel: "none" | "summary"; quietHoursStart: string | null; quietHoursEnd: string | null; timeZone: string; salience: "silent" | "normal" | "important" };
type Health = { needsAction: boolean; message: string | null };
const DEVICE_KEY = "iris-push-device-id";
const EXPERIENCED_KEY = "iris-followups-experienced";

function deviceId() {
  let id = window.localStorage.getItem(DEVICE_KEY);
  if (!id) { id = crypto.randomUUID(); window.localStorage.setItem(DEVICE_KEY, id); }
  return id;
}
function publicKeyToBytes(value: string) {
  const padded = `${value}${"=".repeat((4 - value.length % 4) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded); return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function NotificationSettings() {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [pushConfigured, setPushConfigured] = useState(false);
  const [experienced, setExperienced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quietHours, setQuietHours] = useState({ start: "", end: "" });

  useEffect(() => {
    setExperienced(window.localStorage.getItem(EXPERIENCED_KEY) === "true");
    void Promise.all([fetch("/api/notifications", { cache: "no-store" }), fetch("/api/accountability/health", { cache: "no-store" })])
      .then(async ([settings, healthResponse]) => {
        const settingsBody = await settings.json() as { preferences?: Preferences; pushConfigured?: boolean };
        const healthBody = await healthResponse.json() as Health;
        if (!settings.ok || !settingsBody.preferences) throw new Error("Could not load notification settings.");
        setPreferences(settingsBody.preferences); setQuietHours({ start: settingsBody.preferences.quietHoursStart?.slice(0, 5) ?? "", end: settingsBody.preferences.quietHoursEnd?.slice(0, 5) ?? "" }); setPushConfigured(Boolean(settingsBody.pushConfigured)); setHealth(healthResponse.ok ? healthBody : null);
      }).catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : "Could not load notification settings."));
  }, []);

  async function save(next: Preferences) {
    setPreferences(next); setError(null);
    const response = await fetch("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "preferences", ...next }) });
    if (!response.ok) { setError("Could not save notification settings."); return; }
    const body = await response.json() as { preferences: Preferences }; setPreferences(body.preferences);
  }

  async function enablePush() {
    if (!pushConfigured || !("Notification" in window) || !("serviceWorker" in navigator)) return;
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return;
      const registration = await navigator.serviceWorker.ready;
      const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!key) throw new Error("Push is not configured.");
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKeyToBytes(key) });
      const response = await fetch("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "register", deviceId: deviceId(), subscription: subscription.toJSON() }) });
      if (!response.ok) throw new Error("Could not save this device.");
    } catch { setError("Could not enable push notifications on this device."); }
  }

  async function saveQuietHours() {
    if (!preferences) return;
    if (Boolean(quietHours.start) !== Boolean(quietHours.end)) { setError("Choose both quiet-hour times, or clear both."); return; }
    await save({ ...preferences, quietHoursStart: quietHours.start || null, quietHoursEnd: quietHours.end || null, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || preferences.timeZone });
  }

  if (!preferences) return null;
  return <section data-reveal className="mt-5 rounded-[26px] border border-white/70 bg-white/38 p-5 sm:p-6" aria-labelledby="notifications-heading">
    <div className="flex items-start justify-between gap-4"><div><h2 id="notifications-heading" className="font-semibold tracking-tight text-slate-900">Notifications</h2><p className="mt-1 text-sm text-slate-500">Follow-ups stay in-app; Push is optional.</p></div><label className="flex items-center gap-2 text-sm font-medium text-slate-700"><input type="checkbox" checked={preferences.enabled} onChange={(event) => void save({ ...preferences, enabled: event.target.checked })} /> On</label></div>
    {health?.needsAction && health.message ? <p className="mt-3 text-sm font-medium text-amber-700">{health.message} <span className="text-slate-500">Review this setting.</span></p> : null}
    <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
      <label className="text-slate-600">Preview<select className="mt-1 block w-full rounded-xl border border-slate-200 bg-white/70 px-3 py-2" value={preferences.previewLevel} onChange={(event) => void save({ ...preferences, previewLevel: event.target.value as Preferences["previewLevel"] })}><option value="none">Private</option><option value="summary">Summary</option></select></label>
      <label className="text-slate-600">Strength<select className="mt-1 block w-full rounded-xl border border-slate-200 bg-white/70 px-3 py-2" value={preferences.salience} onChange={(event) => void save({ ...preferences, salience: event.target.value as Preferences["salience"] })}><option value="silent">Silent</option><option value="normal">Normal</option><option value="important">Important</option></select></label>
    </div>
    <div className="mt-3 flex flex-wrap items-end gap-2 text-sm text-slate-600"><label>Quiet from<input aria-label="Quiet hours start" type="time" value={quietHours.start} onChange={(event) => setQuietHours((current) => ({ ...current, start: event.target.value }))} className="ml-2 rounded-xl border border-slate-200 bg-white/70 px-2 py-2" /></label><label>to<input aria-label="Quiet hours end" type="time" value={quietHours.end} onChange={(event) => setQuietHours((current) => ({ ...current, end: event.target.value }))} className="ml-2 rounded-xl border border-slate-200 bg-white/70 px-2 py-2" /></label><button type="button" onClick={() => void saveQuietHours()} className="soft-press rounded-xl bg-white/70 px-3 py-2 font-medium text-slate-700">Save</button></div>
    <p className="mt-2 text-xs text-slate-500">Quiet hours use this device’s local time, including daylight-saving changes.</p>
    {experienced && pushConfigured ? <button type="button" onClick={() => void enablePush()} className="soft-press mt-4 rounded-xl bg-[#111827] px-3 py-2 text-sm font-semibold text-white">Enable Push on this device</button> : null}
    {experienced && !pushConfigured ? <p className="mt-4 text-xs text-slate-500">Push is not configured for this deployment.</p> : null}
    {error ? <p className="mt-3 text-xs font-medium text-red-600">{error}</p> : null}
  </section>;
}
