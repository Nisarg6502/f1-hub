"use client";

/**
 * Thumbs up/down on an assistant answer (CP69).
 *
 * One vote per message, client-side — once `feedback` is set the buttons
 * lock in place rather than allowing a second vote. Renders nothing when
 * there's no `run_id` to attach the vote to: a cached answer never opened a
 * LangSmith trace (`main.py`'s cache-hit path), and an echo-mode answer
 * isn't a real answer to rate at all — same guard `StatusFooter` already
 * applies for the latter, extended here to the (also real) null-run_id case.
 *
 * Thumbs-down opens a small comment popover before submitting, reusing this
 * app's existing liquid-glass popover pattern (`compare-drivers-panel.tsx`'s
 * `DriverSelect`): `bg-surface-container/98 border border-white/10`,
 * `motion/react` for the open/close transition, click-outside + Escape to
 * dismiss.
 */

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ThumbsUp, ThumbsDown } from "lucide-react";

interface FeedbackControlsProps {
  runId: string | null;
  feedback: 1 | -1 | null;
  echoMode: boolean;
  onVote: (score: 1 | -1, comment?: string) => void;
}

export default function FeedbackControls({
  runId,
  feedback,
  echoMode,
  onVote,
}: FeedbackControlsProps) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    // A popover a user opens should be usable from the keyboard immediately,
    // not just after a click into the textarea.
    textareaRef.current?.focus();
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (!runId || echoMode) return null;

  const voted = feedback !== null;

  const submitDown = () => {
    onVote(-1, comment.trim() ? comment.trim() : undefined);
    setOpen(false);
    setComment("");
  };

  /* The four controls below carry `before:-inset-2` rather than real padding:
     they are 24px as drawn and a finger needs 40, but padding them would push
     the row apart and re-space a footer that is already tuned. The uniform
     `-inset-2` form is used deliberately — this codebase has a measured case
     (see the footer link in app/layout.tsx) of a COMPOUND negative inset
     (`-inset-y-3`) silently generating no CSS at all, so the working uniform
     pattern from `pitwall-assistant-launcher.tsx` is the one copied here. */
  return (
    <div className="mt-2 flex items-center gap-1">
      {/* A visible label, because four unlabelled grey squares are not an
          invitation.
          Thumbs-up, thumbs-down, Copy and Regenerate render as near-identical
          24px icons in the same muted grey, one after another. Nothing among
          them says which pair is "tell us this was wrong" — and a feedback
          control nobody recognises collects nothing, which is the same as not
          having one. Three words in front of the thumbs is the cheapest way to
          make the affordance legible; the icons keep their `aria-label`s for
          anyone not reading it visually. */}
      <span className="mr-1 font-medium text-[11px] text-[var(--color-on-surface-variant)]">
        Was this right?
      </span>
      <button
        type="button"
        onClick={() => onVote(1)}
        disabled={voted}
        aria-label="Good answer"
        aria-pressed={feedback === 1}
        className={`relative before:absolute before:-inset-2 before:content-[''] flex h-6 w-6 items-center justify-center rounded-md transition-[color,transform,background-color] duration-150 active:scale-90 disabled:active:scale-100 ${
          feedback === 1
            ? "text-[var(--color-primary)]"
            : voted
              ? "text-[var(--color-on-surface-variant)]/30"
              : "text-[var(--color-on-surface-variant)] hover:bg-white/[0.06] hover:text-[var(--color-on-surface)]"
        }`}
      >
        <ThumbsUp className="h-3.5 w-3.5" strokeWidth={2} fill={feedback === 1 ? "currentColor" : "none"} />
      </button>

      <div className="relative" ref={rootRef}>
        <button
          type="button"
          onClick={() => {
            if (voted) return;
            setOpen((v) => !v);
          }}
          disabled={voted}
          aria-label="Bad answer"
          aria-pressed={feedback === -1}
          aria-expanded={open}
          className={`relative before:absolute before:-inset-2 before:content-[''] flex h-6 w-6 items-center justify-center rounded-md transition-[color,transform,background-color] duration-150 active:scale-90 disabled:active:scale-100 ${
            feedback === -1
              ? "text-[var(--color-error)]"
              : voted
                ? "text-[var(--color-on-surface-variant)]/30"
                : "text-[var(--color-on-surface-variant)] hover:bg-white/[0.06] hover:text-[var(--color-on-surface)]"
          }`}
        >
          <ThumbsDown className="h-3.5 w-3.5" strokeWidth={2} fill={feedback === -1 ? "currentColor" : "none"} />
        </button>

        <AnimatePresence>
          {open && (
            <motion.div
              initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
              animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
              transition={{ duration: reduce ? 0.1 : 0.16, ease: [0.23, 1, 0.32, 1] }}
              style={{ transformOrigin: "top left" }}
              role="dialog"
              aria-label="Add feedback comment"
              className="absolute top-full left-0 z-50 mt-1.5 w-64 rounded-xl border border-white/10 bg-surface-container/98 p-2.5 shadow-2xl"
            >
              <textarea
                ref={textareaRef}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submitDown();
                  }
                }}
                placeholder="What went wrong? (optional)"
                rows={2}
                className="w-full resize-none rounded-lg bg-veil/6 border border-white/10 px-2.5 py-2 text-xs text-[var(--color-on-surface)] outline-none placeholder:text-[var(--color-on-surface-variant)] focus:border-flame-bright/50"
              />
              <div className="mt-2 flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md px-2 py-1 text-[11px] font-semibold text-[var(--color-on-surface-variant)] transition-[color,transform] duration-150 hover:text-[var(--color-on-surface)] active:scale-95"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitDown}
                  className="rounded-md bg-[var(--color-error)]/15 px-2.5 py-1 text-[11px] font-semibold text-[var(--color-error)] transition-[background-color,transform] duration-150 hover:bg-[var(--color-error)]/25 active:scale-95"
                >
                  Submit
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
