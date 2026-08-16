"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  createDelayedPresenceController,
  type DelayedPresenceController,
  type DelayedPresencePhase,
} from "@/lib/delayed-presence";

function usePrefersReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return reducedMotion;
}

function useDelayedPresence(active: boolean): DelayedPresencePhase {
  const reducedMotion = usePrefersReducedMotion();
  const [phase, setPhase] = useState<DelayedPresencePhase>("hidden");
  const [controller] = useState<DelayedPresenceController>(() => createDelayedPresenceController({ onPhaseChange: setPhase }));

  useEffect(() => {
    controller.setReducedMotion(reducedMotion);
  }, [controller, reducedMotion]);

  useEffect(() => {
    controller.setActive(active);
  }, [active, controller]);

  useEffect(() => {
    return () => controller.dispose();
  }, [controller]);

  return phase;
}

export function DelayedPagePresence({ active, children, className = "" }: Readonly<{ active: boolean; children?: ReactNode; className?: string }>) {
  const phase = useDelayedPresence(active);
  const loading = active || phase !== "hidden";
  return (
    <div className={`relative ${className}`} aria-busy={loading}>
      {children}
      <DelayedPageLoader phase={phase} />
    </div>
  );
}

function DelayedPageLoader({ phase }: Readonly<{ phase: DelayedPresencePhase }>) {
  if (phase === "hidden") return null;
  return (
    <div className={`page-loader page-loader--${phase}`} role="status" aria-live="polite" aria-label="Loading">
      <span className="page-loader__orb" aria-hidden="true" />
    </div>
  );
}
