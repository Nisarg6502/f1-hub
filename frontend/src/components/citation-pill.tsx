"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "motion/react";
import CitationPopover from "./citation-popover";
import { sourceKindStyle } from "@/lib/source-kind";
import { citationAnchorId, parseCitationHref, type AgentSource } from "@/lib/agent-api";

/**
 * The message a pill belongs to, and that message's sources.
 *
 * `react-markdown` only hands a `components.a` override `{href, children}` —
 * there is no way to pass it props from the call site — so the owning bubble
 * publishes its identity and evidence through context instead. The message id
 * is also encoded in the href (see `rewriteCitations`); context supplies the
 * *data* the popover needs, which an href cannot carry.
 */
/** Must track `CitationPopover`'s own `w-72`. */
const POPOVER_WIDTH = 288;

export const CitationContext = createContext<{
  messageId: string;
  sources: AgentSource[];
  /**
   * The message's full answer text. The popover uses it to work out which
   * snippet values the answer actually quotes — see
   * `findHighlightedIndices` in `citation-popover.tsx`.
   */
  answerText: string;
}>({ messageId: "", sources: [], answerText: "" });

/**
 * Renders a `[ev_N]` citation marker (rewritten by `rewriteCitations` into a
 * `#cite-<messageId>-ev_N` markdown link) as a numbered, clickable pill.
 *
 * Clicking opens a `CitationPopover` showing the evidence itself (CP71) and
 * briefly flashes the matching `SourceCard`.
 *
 * It deliberately does NOT scroll to that card. The popover is anchored to the
 * pill's rect at click time, so scrolling the list out from under it detaches
 * it from its own pill — and on a message whose cards sit below the fold that
 * happened on every open. The popover now carries the evidence itself, which
 * is what the scroll was for.
 *
 * Registered as the `a` component override for `react-markdown` — an ordinary
 * markdown link (anything not matching the `#cite-…-ev_` href shape) renders
 * as a normal link, unchanged, so this component is safe to register globally
 * on every answer even for messages containing a genuine external link.
 *
 * **Highlighting runs backwards on purpose.** A pill's own `children` is just
 * its number, and recovering the cited value from the neighbouring prose is
 * guesswork. So instead of guessing the value out of the answer, the message's
 * whole answer text is handed to the popover, which checks which of its own
 * known snippet values literally appear in it. Every candidate is then an
 * exact string rather than a guess.
 */
export default function CitationPill({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}) {
  const { messageId, sources, answerText } = useContext(CitationContext);
  // `anchor` is the pill's viewport rect at click time. The popover is
  // portaled to `document.body` for two reasons: a pill lives inside a
  // markdown `<p>`, and a `<div role="dialog">` inside a `<p>` is invalid HTML
  // that React reports as a hydration error; and the message list is an
  // `overflow-y-auto` scroller, which would clip an in-flow popover at the
  // bubble's edge.
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Stable identity, and it matters: `CitationPopover`'s listener effect
  // depends on `onClose`, and a fresh closure per render would tear down and
  // rebind two document listeners on every streamed token of a later answer.
  // Closing also returns focus to the pill that opened the popover — otherwise
  // the focused close button unmounts and focus falls to `<body>`, stranding
  // keyboard users at the top of the page.
  const closePopover = useCallback(() => {
    setAnchor(null);
    buttonRef.current?.focus();
  }, []);
  const parsed = parseCitationHref(href);

  if (!parsed) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
        {children}
      </a>
    );
  }

  const { evidenceId } = parsed;
  // Prefer the href's own message id: it is what `rewriteCitations` wrote for
  // this very text, and it stays correct even if a bubble ever renders text
  // from another message.
  const ownerId = parsed.messageId || messageId;
  const source = sources.find((s) => s.id === evidenceId) ?? null;
  const kind = sourceKindStyle(source?.kind);

  return (
    <span className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          const rect = buttonRef.current?.getBoundingClientRect();
          // Always open rather than toggle: the popover's own click-outside
          // handler fires on `pointerdown` before this `click`, so a toggle
          // would close-then-reopen and the pill would appear inert.
          if (rect) {
            // Clamp so a pill in the right half of a bubble doesn't push a
            // 288px popover off the edge of the viewport: the panel is a
            // right-anchored drawer, so that is the common case, not the edge
            // case. `max-w` alone caps the width without moving the origin.
            const MARGIN = 8;
            const maxLeft = Math.max(
              MARGIN,
              window.innerWidth - POPOVER_WIDTH - MARGIN
            );
            setAnchor({
              top: rect.bottom,
              left: Math.min(Math.max(rect.left, MARGIN), maxLeft),
            });
          }
          const target = document.getElementById(citationAnchorId(ownerId, evidenceId));
          if (!target) return;
          target.classList.add("apex-citation-flash");
          window.setTimeout(() => target.classList.remove("apex-citation-flash"), 1200);
        }}
        style={{ color: kind.accent, backgroundColor: kind.tint }}
        className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 align-super text-[10px] font-semibold transition-[filter,transform] duration-150 [transition-timing-function:cubic-bezier(0.23,1,0.32,1)] hover:brightness-125 active:scale-95"
        aria-expanded={anchor !== null}
        aria-label={`Source ${children} — ${source?.title ?? kind.label}`}
      >
        {children}
      </button>
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {anchor && source && (
              <span
                className="relative z-[90]"
                style={{ position: "fixed", top: anchor.top, left: anchor.left }}
              >
                <CitationPopover
                  source={source}
                  answerText={answerText}
                  onClose={closePopover}
                />
              </span>
            )}
          </AnimatePresence>,
          document.body
        )}
    </span>
  );
}
