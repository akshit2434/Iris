"use client";

import { FormEvent, useState } from "react";
import { LoaderCircle, LockKeyhole, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";

export function GateScreen() {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/gate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not unlock Iris.");
      router.replace("/");
    } catch (gateError) {
      setError(gateError instanceof Error ? gateError.message : "Could not unlock Iris.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--iris-background)] px-5 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center justify-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--iris-accent)] text-white shadow-sm"><Sparkles size={20} /></span><span className="text-xl font-bold tracking-tight text-slate-950">Iris</span></div>
        <div className="rounded-[32px] border border-white/80 bg-white/80 p-7 shadow-[0_18px_60px_rgba(120,145,190,0.12)] sm:p-9">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100 text-slate-600"><LockKeyhole size={19} /></div>
          <h1 className="mt-6 text-2xl font-semibold tracking-tight text-slate-950">Enter your PIN</h1>
          <form onSubmit={submit} className="mt-6 space-y-3">
            <label htmlFor="pin" className="sr-only">Access PIN</label>
            <input id="pin" name="pin" value={pin} onChange={(event) => setPin(event.target.value)} type="password" autoComplete="current-password" placeholder="PIN" className="w-full rounded-[18px] border border-slate-200 bg-slate-50 px-4 py-3.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[var(--iris-accent)] focus:bg-white" />
            <button type="submit" disabled={loading || pin.length === 0} className="flex w-full items-center justify-center gap-2 rounded-[18px] bg-slate-950 px-4 py-3.5 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50">{loading ? <LoaderCircle size={17} className="animate-spin" /> : "Continue"}</button>
          </form>
          {error ? <p className="mt-4 text-sm font-medium text-red-600">{error}</p> : null}
        </div>
      </div>
    </main>
  );
}
