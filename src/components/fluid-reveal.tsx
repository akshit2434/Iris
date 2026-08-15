"use client";

import { useRef, type ReactNode } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(useGSAP);

export function FluidReveal({ children, className = "" }: Readonly<{ children: ReactNode; className?: string }>) {
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    gsap.fromTo(
      "[data-reveal]",
      { autoAlpha: 0, y: 18, scale: 0.985 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.72, stagger: 0.07, ease: "power3.out", clearProps: "transform,opacity,visibility" },
    );
  }, { scope });

  return <div ref={scope} className={className}>{children}</div>;
}
