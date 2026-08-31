"use client";

import { useEffect } from "react";

export default function ProtectedError({
  error,
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-xl items-center justify-center p-6">
      <div className="w-full rounded-3xl border border-red-100 bg-white p-7 text-center shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-red-500">Something went wrong</p>
        <h1 className="mt-3 text-2xl font-semibold text-slate-900">Iris could not load this view.</h1>
        <button
          type="button"
          onClick={reset}
          className="mt-6 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-white transition hover:bg-slate-700"
          aria-label="Try again"
          title="Try again"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" aria-hidden="true"><path d="M20 11a8 8 0 1 0 2 5.3" /><path d="M20 4v7h-7" /></svg>
        </button>
      </div>
    </div>
  );
}
