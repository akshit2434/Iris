"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { FluidReveal } from "@/components/fluid-reveal";
import { IrisMark } from "@/components/iris-mark";

export function GateScreen() {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoading(true); setError(null);
    try {
      const response = await fetch("/api/gate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not unlock Iris.");
      router.replace("/");
    } catch (gateError) { setError(gateError instanceof Error ? gateError.message : "Could not unlock Iris."); }
    finally { setLoading(false); }
  }

  return <main className="relative flex min-h-dvh items-end overflow-hidden px-5 pb-[max(30px,env(safe-area-inset-bottom))] pt-20 sm:items-center sm:justify-center">
    <div className="ambient-orb -right-40 top-[-8%]" />
    <FluidReveal className="relative w-full max-w-md">
      <div data-reveal className="mb-12 px-2"><IrisMark size={70} priority /><h1 className="mt-6 text-[clamp(3.6rem,16vw,5.8rem)] font-medium leading-none tracking-[-.065em]">Iris</h1></div>
      <form data-reveal onSubmit={submit} className="glass-surface rounded-[32px] p-3">
        <label htmlFor="pin" className="sr-only">Access PIN</label>
        <div className="flex items-center gap-2"><input id="pin" name="pin" value={pin} onChange={(event) => setPin(event.target.value)} type="password" inputMode="numeric" autoComplete="current-password" placeholder="PIN" className="h-14 min-w-0 flex-1 bg-transparent px-4 text-base font-medium tracking-[.16em] text-slate-900 placeholder:tracking-normal placeholder:text-slate-400" /><button type="submit" disabled={loading || pin.length === 0} className="soft-press flex h-14 w-14 shrink-0 items-center justify-center rounded-[20px] bg-[#111827] text-xl font-light text-white disabled:opacity-35" aria-label="Continue">{loading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/35 border-t-white" /> : "→"}</button></div>
      </form>
      {error ? <p className="mt-4 px-3 text-sm font-medium text-red-600">{error}</p> : null}
    </FluidReveal>
  </main>;
}
