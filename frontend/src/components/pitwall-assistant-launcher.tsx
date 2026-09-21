"use client";

/**
 * The nav trigger for CP66's Pitwall Assistant panel, plus (this pass) a
 * mobile FAB and a one-time discoverability nudge.
 *
 * A small client wrapper is needed because `layout.tsx` is a server
 * component and the open/closed state has to live somewhere client-side —
 * `GlobalSearch` (already in the same nav row) is the precedent for exactly
 * this shape: a small stateful client component slotted into an otherwise
 * server-rendered layout.
 *
 * `visibility` replaces the old boolean `open`. The panel is no longer
 * mounted only while fully open — closing it (`"closed"`) unmounts it as
 * before (a fresh `threadId` and empty `messages` next time), but minimizing
 * (`"minimized"`) keeps it mounted so an in-flight turn, and everything the
 * panel knows about the conversation, survives while the user browses the
 * rest of the site. See `pitwall-assistant-panel.tsx` for the mounted-but-
 * chrome-swapped rendering this enables.
 */

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import PitwallAssistantPanel from "./pitwall-assistant-panel";
import { usePitwallNudge } from "@/lib/use-pitwall-nudge";
import { track } from "@/lib/analytics";

type Visibility = "closed" | "open" | "minimized";

/** Shared nudge-tooltip look — a small glass callout, matching the panel's
 *  own `apex-glass-strong` surfaces rather than inventing a new one. */
const NUDGE_TOOLTIP_CLASS =
  "absolute z-[71] w-[188px] rounded-lg border border-white/10 bg-[var(--color-surface-container-low)] px-3 py-2.5 text-[11px] leading-snug text-[var(--color-on-surface)] shadow-[0_10px_30px_rgba(0,0,0,0.45)]";

export default function PitwallAssistantLauncher() {
  const [visibility, setVisibility] = useState<Visibility>("closed");
  // `!mounted` (the FAB's own render guard, below) is true by default, so the
  // FAB portal would otherwise be part of the very first render — including
  // the SERVER one, where `document` does not exist and `document.body`
  // throws outright. Gating the portal on this separate, effect-set flag
  // means it renders nothing until after the first CLIENT commit, matching
  // the server output exactly (avoiding a hydration mismatch) and only then
  // touching `document`.
  const [isClient, setIsClient] = useState(false);
  useEffect(() => setIsClient(true), []);
  // The visual ping (this pass) for the minimized bubble. Owned here, not in
  // the panel: it has to survive a re-minimize without a completed turn
  // (i.e. it's independent of `visibility` itself), and every path that
  // should CLEAR it — the nav button, the FAB, the bubble, Cmd/Ctrl+K — is
  // already a real event handler in this component. The panel only reads it
  // (to render the ping) and calls `onAnswerReady` (to set it), which keeps
  // React Compiler's stricter lint rules happy over there: no effect
  // needs to setState synchronously, and no ref needs reading during render.
  const [hasUnread, setHasUnread] = useState(false);
  const reduce = useReducedMotion();
  const nudge = usePitwallNudge();
  // Once a conversation has started, the panel stays mounted across
  // minimize/restore — only an explicit Close tears it down. This is what
  // lets `abortRef`, `messages` and `threadId` inside the panel survive a
  // minimize.
  const mounted = visibility !== "closed";

  const openOrRestore = useCallback((via: string) => {
    setVisibility((prev) => {
      track(prev === "closed" ? "pitwall_panel_open" : "pitwall_panel_restore", {
        via,
      });
      return "open";
    });
    setHasUnread(false);
    nudge.dismiss();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const minimize = useCallback(() => {
    track("pitwall_panel_minimize");
    setVisibility("minimized");
  }, []);

  const close = useCallback(() => {
    track("pitwall_panel_close");
    setVisibility("closed");
    setHasUnread(false);
  }, []);

  // Global open shortcut (CP70): Cmd/Ctrl+K, the common convention for
  // "open the command/search surface" (already familiar from apps like
  // Linear, Slack, Vercel). Lives here rather than in the panel itself
  // because this component owns `visibility` — the panel only reflects it.
  // Guarded against firing while the user is typing elsewhere on the page
  // (an input/textarea/contenteditable), the standard hygiene check for any
  // global single-key-ish shortcut. Restores from minimized too — a user who
  // minimized to browse and wants back in shouldn't have to hunt for the
  // trigger.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey)) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
        return;
      }
      e.preventDefault();
      openOrRestore("shortcut");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openOrRestore]);

  return (
    <>
      {/* Desktop/tablet nav trigger. A labeled pill from `xl:` up — the nav
          row is measured tight at `lg` (see `nav-links.tsx`'s own comment on
          why `lg` and not `md`), so the label only appears once there is
          demonstrably room for it; below that it's the same icon-only disc
          this always was. Either way this is the first-time-visitor's most
          likely way to notice the feature at all on desktop, hence the
          nudge anchored to it. */}
      <div className="relative">
        <button
          onClick={() => openOrRestore("button")}
          aria-label="Ask the Pitwall Assistant"
          title="Ask the Pitwall Assistant"
          /* 36px to the eye, 44px to a finger. `before:-inset-1` is 4px on
             every side and moves nothing visually — it only pads the hit
             target past the 40px floor without widening the icon-only
             disc that has to sit in a dense nav row. */
          className="relative flex h-9 items-center justify-center gap-1.5 rounded-full border border-white/10 bg-[var(--color-surface-container-low)] px-2 text-warm-200 transition-[background-color,transform] duration-150 hover:bg-[var(--color-surface-container)] active:scale-[0.95] xl:w-auto xl:px-3.5 w-9 before:absolute before:-inset-1 before:content-['']"
        >
          <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
            forum
          </span>
          <span className="hidden xl:inline text-[12px] font-semibold whitespace-nowrap">
            Ask AI
          </span>
        </button>
        <AnimatePresence>
          {nudge.visible && !mounted && (
            <motion.div
              role="status"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.96 }}
              animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.96 }}
              transition={
                reduce ? { duration: 0.15 } : { type: "spring", stiffness: 380, damping: 30 }
              }
              className={`${NUDGE_TOOLTIP_CLASS} right-0 top-[calc(100%+10px)]`}
            >
              <button
                type="button"
                onClick={nudge.dismiss}
                aria-label="Dismiss"
                className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full text-[13px] leading-none text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)]"
              >
                ×
              </button>
              <p className="pr-4 font-medium text-[var(--color-on-surface)]">
                New: ask the Pitwall Assistant
              </p>
              <p className="mt-0.5 text-[var(--color-on-surface-variant)]">
                Get cited answers about any race, driver, or season.
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Mobile FAB. Below `lg` the nav trigger above is still rendered (it's
          not inside `NavLinks`' `hidden lg:flex` row) but it is a 36px disc
          competing with the season badge in a corner a thumb rarely lands on
          first — this is the prominent, hard-to-miss entry point the brief
          asks for on small screens. It disappears once `mounted`: once a
          conversation exists, the panel's own minimized bubble (see
          `pitwall-assistant-panel.tsx`) occupies this exact spot instead, and
          having both on screen at once would be two floating controls doing
          the same job. Positioned clear of `MobileNav` (`fixed bottom-0`,
          ~64px tall including its own padding) with room to spare.

          Portaled to `document.body` rather than rendered in place inside
          `<nav>`: this nav has `backdrop-blur` (`layout.tsx`), and
          `backdrop-filter` — like `filter` — creates a new containing block
          for `position: fixed` descendants. Left in place, this FAB's
          `fixed bottom-20 right-4` resolved against the NAV's own ~64px box
          instead of the viewport, computing a large negative `top` and
          rendering entirely off-screen above the page — confirmed with
          `getBoundingClientRect` before adding the portal, not by
          inspection. The panel's own minimized bubble
          (`pitwall-assistant-panel.tsx`) already portals for this same
          reason; this is that established pattern, applied here too. */}
      {!mounted &&
        isClient &&
        createPortal(
          <div className="lg:hidden fixed z-[70] bottom-20 right-4">
            <AnimatePresence>
              {nudge.visible && (
                <motion.div
                  role="status"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.96 }}
                  animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.96 }}
                  transition={
                    reduce ? { duration: 0.15 } : { type: "spring", stiffness: 380, damping: 30 }
                  }
                  className={`${NUDGE_TOOLTIP_CLASS} right-0 bottom-[calc(100%+10px)]`}
                >
                  <button
                    type="button"
                    onClick={nudge.dismiss}
                    aria-label="Dismiss"
                    className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full text-[13px] leading-none text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)]"
                  >
                    ×
                  </button>
                  <p className="pr-4 font-medium text-[var(--color-on-surface)]">
                    New: ask the Pitwall Assistant
                  </p>
                  <p className="mt-0.5 text-[var(--color-on-surface-variant)]">
                    Get cited answers about any race, driver, or season.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
            <button
              onClick={() => openOrRestore("fab")}
              aria-label="Ask the Pitwall Assistant"
              title="Ask the Pitwall Assistant"
              className="relative flex h-14 w-14 items-center justify-center rounded-full border border-white/10 bg-[var(--color-primary)] text-[var(--color-on-primary)] shadow-[0_10px_30px_rgba(0,0,0,0.45)] transition-transform duration-150 active:scale-[0.94]"
            >
              {!reduce && nudge.visible && (
                <motion.span
                  aria-hidden="true"
                  className="absolute inset-0 rounded-full bg-[var(--color-primary)]"
                  animate={{ scale: [1, 1.5], opacity: [0.55, 0] }}
                  transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
                />
              )}
              <span className="material-symbols-outlined text-[26px]" aria-hidden="true">
                forum
              </span>
            </button>
          </div>,
          document.body
        )}

      <AnimatePresence>
        {mounted && (
          <PitwallAssistantPanel
            visibility={visibility === "minimized" ? "minimized" : "open"}
            hasUnread={hasUnread}
            onClose={close}
            onMinimize={minimize}
            onRestore={() => openOrRestore("bubble")}
            onAnswerReady={() => setHasUnread(true)}
          />
        )}
      </AnimatePresence>
    </>
  );
}
