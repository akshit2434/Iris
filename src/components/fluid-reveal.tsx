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
      { autoAlpha: 0, y: 14, scale: 0.99, filter: "blur(4px)" },
      { autoAlpha: 1, y: 0, scale: 1, filter: "blur(0px)", duration: 0.64, stagger: 0.065, ease: "power3.out", clearProps: "transform,opacity,visibility,filter" },
    );
  }, { scope });

  return <div ref={scope} className={className}>{children}</div>;
}
