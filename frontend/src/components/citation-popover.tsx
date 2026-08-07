"use client";

/**
 * The evidence behind one citation (CP71, Task 3).
 *
 * Before this, a citation exposed only its *provenance* — a kind, a label, a
 * timestamp. The fact it rested on stayed in the ledger. `CitationPopover`
 * renders the `snippet` pairs the ledger now ships (Task 1) so a reader can
 * click a pill and see the actual supporting value, with the values the answer
 * actually quotes emphasised in place (see {@link findHighlightedIndices}).
 *
 * Visuals follow the established liquid-glass popover pattern
 * (`feedback-controls.tsx`, CP69): `bg-[rgba(26,22,19,0.98)]`,
 * `border border-white/10`, `motion/react` for enter/exit, click-outside and
 * Escape to dismiss. Kind colours/icons come from the one shared definition in
 * `@/lib/source-kind` so the pill, the card and this popover cannot drift.
 *
 * Props are pure data-in / callbacks-out — it owns no panel state, so Task 5
 * can mount it wherever a pill lives.
 */

import { useEffect, useMemo, useRef } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ExternalLink, X } from "lucide-react";
import LocalDateTime from "./local-datetime";
import { sourceKindStyle } from "@/lib/source-kind";
import type { AgentSnippetPair, AgentSource } from "@/lib/agent-api";

interface CitationPopoverProps {
  source: AgentSource;
  /**
   * The full answer text this citation appears in. Snippet values that
   * literally occur in it are emphasised — see {@link findHighlightedIndices}.
   */
  answerText?: string;
  onClose: () => void;
}

/**
 * Indices of the snippet pairs whose values the answer *actually quotes*.
 *
 * The obvious direction — guess the cited value out of the prose next to the
 * pill — is unreliable. This runs the inverse: every snippet value is a known,
 * exact string, so we ask which of them literally appear in the answer. A hit
 * means "this line is the fact that sentence rests on"; a miss highlights
 * nothing, which is the correct outcome for provenance-only evidence.
 *
 * Two guards keep it from lighting up the whole popover, the noise risk the
 * plan called out: values shorter than 3 characters and bare integers ("1",
 * "2026") are skipped, since they match half of any answer by coincidence.
 * Anything surviving those guards is specific enough that several simultaneous
 * hits are informative rather than noisy, so all of them are returned.
 */
export function findHighlightedIndices(
  pairs: AgentSnippetPair[],
  answerText?: string
): Set<number> {
  const hits = new Set<number>();
  const haystack = answerText?.toLowerCase() ?? "";
  if (!haystack) return hits;
  pairs.forEach((pair, i) => {
    const value = (pair.value ?? "").trim();
    if (value.length < 3) return;
    if (/^\d+$/.test(value)) return;
    if (haystack.includes(value.toLowerCase())) hits.add(i);
  });
  return hits;
}

export default function CitationPopover({
  source,
  answerText,
  onClose,
}: CitationPopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const reduce = useReducedMotion();

  const kind = sourceKindStyle(source.kind);
  const pairs = useMemo(
    () => (Array.isArray(source.snippet) ? source.snippet : []),
    [source.snippet]
  );
  const highlighted = useMemo(
    () => findHighlightedIndices(pairs, answerText),
    [pairs, answerText]
  );

  const asOfMs = source.as_of ? new Date(source.as_of).getTime() : null;
  const hasLink = source.kind !== "data" && Boolean(source.url);

  // Mount-only, and deliberately SEPARATE from the listener effect below.
  // Folding it in there would re-run `focus()` every time `onClose`'s identity
  // changed — which, with an unmemoised parent, is once per streamed token:
  // focus would be yanked back to the close button dozens of times a second
  // while a later answer streamed.
  useEffect(() => {
    // Move focus in so the popover is immediately dismissible from the
    // keyboard, and so a screen reader lands on the evidence it just opened.
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Capture phase + stopPropagation: Escape inside an open popover must
        // dismiss the popover only. The assistant panel listens for Escape on
        // `window` to close itself, and closing both at once would rip the
        // whole conversation away from someone who only wanted to shut this
        // card.
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      // The popover portals outside the assistant panel's dialog subtree, so
      // the panel's own trap sees focus as "outside" and snaps it back to the
      // panel header — which made the "Open source" link unreachable by
      // keyboard. Trapping Tab here, in capture phase, keeps the cycle inside
      // the popover and stops the panel's handler from ever seeing it.
      const root = rootRef.current;
      if (!root || !root.contains(document.activeElement)) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      e.stopPropagation();
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onClose]);

  return (
    <motion.div
      ref={rootRef}
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -2 }}
      transition={{ duration: reduce ? 0.1 : 0.18, ease: [0.23, 1, 0.32, 1] }}
      style={{ transformOrigin: "top left" }}
      role="dialog"
      aria-label={`Evidence for ${source.title}`}
      className="absolute top-full left-0 z-50 mt-1.5 w-72 max-w-[min(18rem,calc(100vw-2rem))] rounded-xl border border-white/10 bg-[rgba(26,22,19,0.98)] p-3 shadow-2xl"
    >
      <div className="flex items-start gap-2">
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
          style={{ color: kind.accent, backgroundColor: kind.tint }}
          title={kind.description}
        >
          <span className="material-symbols-outlined text-[13px] leading-none">
            {kind.icon}
          </span>
          {kind.label}
        </span>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close citation"
          className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[var(--color-on-surface-variant)] transition-[color,transform,background-color] duration-150 hover:bg-white/[0.06] hover:text-[var(--color-on-surface)] active:scale-90"
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>

      <p className="mt-2 text-xs leading-snug font-semibold text-[var(--color-on-surface)]">
        {source.title}
      </p>

      {pairs.length > 0 ? (
        <dl className="mt-2 space-y-1">
          {pairs.map((pair, i) => {
            const hit = highlighted.has(i);
            return (
              <div
                key={`${pair.label}-${i}`}
                className={`flex items-baseline gap-2 rounded-md px-1.5 py-1 ${
                  hit ? "bg-[rgba(255,138,61,0.12)]" : ""
                }`}
              >
                <dt className="shrink-0 text-[10px] tracking-wide text-[var(--color-on-surface-variant)] uppercase">
                  {pair.label}
                </dt>
                <dd
                  className={`min-w-0 flex-1 text-right text-[11px] break-words ${
                    hit
                      ? "font-semibold text-[var(--color-primary)]"
                      : "text-[var(--color-on-surface)]"
                  }`}
                >
                  {pair.value}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <p className="mt-2 text-[11px] text-[var(--color-on-surface-variant)]">
          No further detail was recorded for this source.
        </p>
      )}

      {(asOfMs || hasLink) && (
        <div className="mt-2.5 flex items-center gap-2 border-t border-white/[0.07] pt-2">
          {asOfMs && (
            <span className="text-[10px] text-[var(--color-on-surface-variant)]">
              <LocalDateTime
                timestampMs={asOfMs}
                options={{ dateStyle: "medium", timeStyle: "short" }}
              />
            </span>
          )}
          {hasLink && (
            <a
              href={source.url ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold text-[var(--color-primary)] transition-[opacity,transform] duration-150 hover:opacity-80 active:scale-95"
            >
              Open source
              <ExternalLink className="h-3 w-3" strokeWidth={2} />
            </a>
          )}
        </div>
      )}
    </motion.div>
  );
}
