"use client";

import { createContext, useContext, useRef, useState } from "react";
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
export const CitationContext = createContext<{
  messageId: string;
  sources: AgentSource[];
}>({ messageId: "", sources: [] });

/**
 * Renders a `[ev_N]` citation marker (rewritten by `rewriteCitations` into a
 * `#cite-<messageId>-ev_N` markdown link) as a numbered, clickable pill.
 *
 * Clicking opens a `CitationPopover` showing the evidence itself (CP71), and
 * simultaneously scrolls to and briefly flashes the matching `SourceCard` — so
 * a click both answers "what is this?" in place and locates the full card.
 *
 * Registered as the `a` component override for `react-markdown` — an ordinary
 * markdown link (anything not matching the `#cite-…-ev_` href shape) renders
 * as a normal link, unchanged, so this component is safe to register globally
 * on every answer even for messages containing a genuine external link.
 *
 * **No `highlight` is passed.** The popover supports emphasising the cited
 * value, but a pill's own `children` is just its number, and recovering the
 * neighbouring prose value from a react-markdown child node is guesswork —
 * "P2" in the sentence may or may not be the fact this evidence supports.
 * Passing a wrong highlight is worse than passing none, so this passes none;
 * the prop stays available for a future call site that genuinely knows.
 */
export default function CitationPill({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}) {
  const { messageId, sources } = useContext(CitationContext);
  // `anchor` is the pill's viewport rect at click time. The popover is
  // portaled to `document.body` for two reasons: a pill lives inside a
  // markdown `<p>`, and a `<div role="dialog">` inside a `<p>` is invalid HTML
  // that React reports as a hydration error; and the message list is an
  // `overflow-y-auto` scroller, which would clip an in-flow popover at the
  // bubble's edge.
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
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
          if (rect) setAnchor({ top: rect.bottom, left: rect.left });
          const target = document.getElementById(citationAnchorId(ownerId, evidenceId));
          if (!target) return;
          target.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
                <CitationPopover source={source} onClose={() => setAnchor(null)} />
              </span>
            )}
          </AnimatePresence>,
          document.body
        )}
    </span>
  );
}
