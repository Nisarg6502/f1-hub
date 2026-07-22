"use client";

import { useEffect, useRef } from "react";
import EmberCanvas from "./ember-canvas";

/**
 * Decorative hero backdrop: drifting embers + a warm spotlight that follows the
 * cursor. Attaches its pointer listener to the parent hero element, so the hero
 * itself can stay a server component.
 */
export default function HeroFX() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const onMove = (e: MouseEvent) => {
      const r = parent.getBoundingClientRect();
      parent.style.setProperty("--hx", e.clientX - r.left + "px");
      parent.style.setProperty("--hy", e.clientY - r.top + "px");
    };
    parent.addEventListener("mousemove", onMove);
    return () => parent.removeEventListener("mousemove", onMove);
  }, []);

  return (
    <div
      ref={ref}
      className="absolute inset-0 pointer-events-none overflow-hidden"
      aria-hidden="true"
    >
      <EmberCanvas className="absolute inset-0 w-full h-full" />
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(320px circle at var(--hx,72%) var(--hy,26%),rgba(255,150,72,0.13),transparent 62%)",
        }}
      />
    </div>
  );
}
