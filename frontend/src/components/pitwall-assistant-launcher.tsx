"use client";

/**
 * The nav trigger for CP66's Pitwall Assistant panel.
 *
 * A small client wrapper is needed because `layout.tsx` is a server
 * component and the open/closed state has to live somewhere client-side —
 * `GlobalSearch` (already in the same nav row) is the precedent for exactly
 * this shape: a small stateful client component slotted into an otherwise
 * server-rendered layout.
 *
 * The panel itself is only rendered while open, not mounted-but-hidden —
 * each open is a fresh mount, which is what gives `pitwall-assistant-panel`'s
 * own `threadId` ref a clean new conversation every time rather than an
 * ever-growing one from a panel that never actually unmounts.
 */

import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import PitwallAssistantPanel from "./pitwall-assistant-panel";

export default function PitwallAssistantLauncher() {
  const [open, setOpen] = useState(false);

  // Global open shortcut (CP70): Cmd/Ctrl+K, the common convention for
  // "open the command/search surface" (already familiar from apps like
  // Linear, Slack, Vercel). Lives here rather than in the panel itself
  // because this component owns `open` — the panel only mounts once
  // already open. Guarded against firing while the user is typing
  // elsewhere on the page (an input/textarea/contenteditable), the standard
  // hygiene check for any global single-key-ish shortcut; this codebase has
  // no other global shortcut to match an existing guard pattern against, so
  // this follows the plan's own guidance directly.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey)) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
        return;
      }
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Ask the Pitwall Assistant"
        title="Ask the Pitwall Assistant"
        className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-[var(--color-surface-container-low)] text-warm-200 transition-[background-color,transform] duration-150 hover:bg-[var(--color-surface-container)] active:scale-[0.95]"
      >
        <span className="material-symbols-outlined text-[19px]" aria-hidden="true">
          forum
        </span>
      </button>
      <AnimatePresence>
        {open && <PitwallAssistantPanel onClose={() => setOpen(false)} />}
      </AnimatePresence>
    </>
  );
}
