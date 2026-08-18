"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { EASE_OUT } from "./motion-primitives";

interface TooltipProps {
  content: string;
  children: ReactNode;
  side?: "top" | "bottom";
}

/**
 * Small hover/focus/tap-triggered explanatory panel. No reusable tooltip
 * existed in the app before this — built on `motion/react` to match the
 * animation library already used everywhere else.
 */
export default function Tooltip({ content, children, side = "top" }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const reduce = useReducedMotion();

  const hidden = { opacity: 0, ...(reduce ? {} : { scale: 0.94, y: side === "top" ? 4 : -4 }) };

  /**
   * Escape dismisses it.
   *
   * This tooltip opens on click as well as hover, because a touch device has no
   * hover — which means on a phone it is a thing the user *opens*, and anything
   * a user opens they expect Escape to close. Without this the only ways out
   * were tapping the trigger again or moving the pointer, and a keyboard user
   * who opened it on focus had no dismissal at all.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={() => setOpen((o) => !o)}
    >
      <span aria-describedby={open ? id : undefined}>{children}</span>
      <AnimatePresence>
        {open && (
          <motion.div
            id={id}
            role="tooltip"
            initial={hidden}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={hidden}
            transition={{ duration: 0.16, ease: EASE_OUT }}
            className={`absolute z-50 ${
              side === "top" ? "bottom-full mb-2.5" : "top-full mt-2.5"
            } left-1/2 -translate-x-1/2 w-56 max-w-[min(14rem,calc(100vw-2rem))] rounded-[10px] bg-[rgba(20,16,13,0.97)] border border-white/10 px-3.5 py-2.5 text-xs font-medium leading-snug text-warm-200 shadow-xl pointer-events-none`}
          >
            {content}
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  );
}
