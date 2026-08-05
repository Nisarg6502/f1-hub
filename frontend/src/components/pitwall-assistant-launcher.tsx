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

import { useState } from "react";
import { AnimatePresence } from "motion/react";
import PitwallAssistantPanel from "./pitwall-assistant-panel";

export default function PitwallAssistantLauncher() {
  const [open, setOpen] = useState(false);

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
