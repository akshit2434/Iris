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
          className="mt-6 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
