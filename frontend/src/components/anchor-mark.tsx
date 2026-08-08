"use client";

/**
 * CP74 — the cited value *is* the citation.
 *
 * This replaces `CitationPill`. The pill was a superscript number next to a
 * fact; this is the fact itself, underlined in its source kind's colour, and
 * activating it opens the record that proves it. The user's verdict on the
 * numbered version was that it was "senseless": a footnote marker carries no
 * information until it is clicked, and the thing it pointed at was a whole
 * tool bundle rather than the field being claimed.
 *
 * ## Accessibility is the cost of this direction, and it is paid here
 *
 * An underline that only means something on hover is invisible to a screen
 * reader and unreachable from a keyboard. So every mark is a real `<button>`:
 * it is in the tab order, it carries `aria-haspopup="dialog"` and
 * `aria-expanded`, and its accessible name states the claimed value, the field
 * it came from and the record it came from — "George Russell, winner, from
 * Race results" — so the source is spoken even when the colour is not seen.
 * The underline is `text-decoration`, not a hover-only background, so it is
 * visible at rest; hover and focus only *strengthen* it. Focus gets a real
 * ring, since a focus state that merely darkens an underline is not a focus
 * state.
 *
 * Everything else follows CP71's popover mechanics unchanged — portal to
 * `document.body` (a `role="dialog"` inside a markdown `<p>` is invalid HTML,
 * and the message list is an `overflow-y-auto` scroller that would clip it),
 * anchor to the rect at activation time, restore focus on close.
 */

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "motion/react";
import CitationPopover from "./citation-popover";
import { sourceKindStyle } from "@/lib/source-kind";
import {
  citationAnchorId,
  parseAnchorHref,
  type AgentAnchor,
  type AgentSource,
} from "@/lib/agent-api";

/** Must track `CitationPopover`'s own `w-72`. */
const POPOVER_WIDTH = 288;

/**
 * The message a mark belongs to, and everything it needs to resolve itself.
 *
 * `react-markdown` hands a `components.a` override only `{href, children}`,
 * with no way to pass props from the call site, so the owning bubble publishes
 * its evidence through context. `anchors` is the *resolved* list from
 * `buildAnchoredMarkdown`, indexed by the href — the two are written together
 * and cannot disagree.
 */
export const AnchorContext = createContext<{
  messageId: string;
  sources: AgentSource[];
  anchors: AgentAnchor[];
  /** The answer with citation markers stripped — see `CitationPopover`. */
  answerText: string;
}>({ messageId: "", sources: [], anchors: [], answerText: "" });

export default function AnchorMark({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}) {
  const { messageId, sources, anchors, answerText } = useContext(AnchorContext);
  const [rect, setRect] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Stable identity: `CitationPopover`'s listener effect depends on `onClose`,
  // and a fresh closure per render would rebind two document listeners on
  // every streamed token of a later answer.
  const close = useCallback(() => {
    setRect(null);
    buttonRef.current?.focus();
  }, []);

  const parsed = parseAnchorHref(href);
  const anchor = parsed ? anchors[parsed.index] : undefined;
  const source = anchor
    ? sources.find((s) => s.id === anchor.evidence_id) ?? null
    : null;

  // An ordinary markdown link in an answer stays an ordinary link. And an
  // anchor whose evidence entry is missing from `sources` degrades to plain
  // text rather than an inert-looking control — a mark that opens nothing is
  // worse than no mark.
  if (!parsed || !anchor || !source) {
    if (!parsed) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
          {children}
        </a>
      );
    }
    return <>{children}</>;
  }

  const kind = sourceKindStyle(source.kind);
  const spoken = [anchor.value || anchor.text, anchor.field, source.title]
    .filter(Boolean)
    .join(", ");

  const open = () => {
    const box = buttonRef.current?.getBoundingClientRect();
    // Always open rather than toggle: the popover's click-outside handler
    // fires on `pointerdown`, before this `click`, so a toggle would
    // close-then-reopen and the mark would appear inert.
    if (box) {
      const MARGIN = 8;
      const maxLeft = Math.max(MARGIN, window.innerWidth - POPOVER_WIDTH - MARGIN);
      setRect({
        top: box.bottom,
        left: Math.min(Math.max(box.left, MARGIN), maxLeft),
      });
    }
    const chip = document.getElementById(citationAnchorId(messageId, source.id));
    if (!chip) return;
    chip.classList.add("apex-citation-flash");
    window.setTimeout(() => chip.classList.remove("apex-citation-flash"), 1200);
  };

  return (
    <span className="relative inline">
      <button
        ref={buttonRef}
        type="button"
        onClick={open}
        style={{
          textDecorationColor: kind.accent,
          backgroundColor: rect ? kind.tint : undefined,
        }}
        className="apex-anchor-mark inline rounded-[3px] px-[1px] text-left underline decoration-[1.5px] underline-offset-[3px] transition-[background-color,text-decoration-thickness] duration-150 [transition-timing-function:cubic-bezier(0.23,1,0.32,1)] hover:decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
        aria-haspopup="dialog"
        aria-expanded={rect !== null}
        aria-label={`${spoken} — show the record this came from`}
      >
        {children}
      </button>
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {rect && (
              <span
                className="relative z-[90]"
                style={{ position: "fixed", top: rect.top, left: rect.left }}
              >
                <CitationPopover
                  source={source}
                  anchor={anchor}
                  answerText={answerText}
                  onClose={close}
                />
              </span>
            )}
          </AnimatePresence>,
          document.body
        )}
    </span>
  );
}
