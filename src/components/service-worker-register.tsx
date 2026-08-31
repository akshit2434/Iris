"use client";

import { useEffect } from "react";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;

    let disposed = false;

    void navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((registration) => {
        if (!disposed) void registration.update();
      })
      .catch(() => {
        // PWA enhancement failure should not block the chat experience.
      });

    return () => {
      disposed = true;
    };
  }, []);

  return null;
}
