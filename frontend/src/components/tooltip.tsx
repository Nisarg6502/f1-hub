"use client";

import { useId, useState, type ReactNode } from "react";
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
            } left-1/2 -translate-x-1/2 w-56 rounded-[10px] bg-[rgba(20,16,13,0.97)] border border-white/10 px-3.5 py-2.5 text-xs font-medium leading-snug text-warm-200 shadow-xl pointer-events-none`}
          >
            {content}
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  );
}
