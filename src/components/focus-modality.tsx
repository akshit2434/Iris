"use client";

import { useEffect } from "react";

/** Keep custom focus rings keyboard-only, including text inputs that some browsers
 * classify as :focus-visible even after a pointer click. */
export function FocusModality() {
  useEffect(() => {
    const root = document.documentElement;
    const markKeyboard = () => { root.dataset.inputModality = "keyboard"; };
    const markPointer = () => { root.dataset.inputModality = "pointer"; };
    window.addEventListener("keydown", markKeyboard, true);
    window.addEventListener("pointerdown", markPointer, true);
    return () => {
      window.removeEventListener("keydown", markKeyboard, true);
      window.removeEventListener("pointerdown", markPointer, true);
      delete root.dataset.inputModality;
    };
  }, []);

  return null;
}
