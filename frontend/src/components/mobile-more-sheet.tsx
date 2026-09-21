"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useModalDialog } from "@/lib/use-modal-dialog";
import GlobalSearch from "./global-search";

/**
 * The overflow half of the phone navigation.
 *
 * The bottom bar can hold six columns before its labels stop being legible
 * (see `MobileNav` in `nav-links.tsx` for the measurement), and the app has
 * more than six places worth going. Everything that does not fit lives here,
 * plus the search field — which below `lg` has no other home at all, because
 * `global-search.tsx`'s own root is `hidden lg:block`.
 *
 * A sheet rather than a full-screen route so the page behind it is never
 * unmounted: this is a menu, and coming back from a menu should not cost a
 * re-fetch of whatever the visitor was already reading.
 */

/** Destinations, in the order they earn a phone visitor's attention. */
const items = [
  {
    href: "/circuits",
    icon: "route",
    label: "Circuits",
    blurb: "Every track, with a 3D elevation model of the real centreline",
  },
  {
    href: "/teams",
    icon: "shield",
    label: "Teams",
    blurb: "Each constructor, and the chain of teams it grew out of",
  },
  {
    href: "/history",
    icon: "history",
    label: "History",
    blurb: "Every championship race since 1950 as one colour barcode",
  },
  {
    /* `/telemetry` is reachable here and from the footer, but deliberately not
       from the primary nav on either breakpoint — the feed behind it was never
       provisioned. Listed last, and described honestly, so a visitor who taps
       it knows what they are getting before the page loads. */
    href: "/telemetry",
    icon: "sensors",
    label: "Live timing",
    blurb: "Session status and a countdown — no live feed yet",
  },
];

export default function MobileMoreSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const reduce = useReducedMotion();

  /* A search result opens its own modal, portalled to `body` at z-[80] — on
     top of this sheet. While that is up, this sheet must stop behaving like a
     dialog: `useModalDialog` binds to `window` without stacking, so two live
     instances would both answer one Escape (closing the modal AND the sheet
     under it) and the outer Tab trap would drag focus back out of the modal. */
  const [detailOpen, setDetailOpen] = useState(false);

  /* Escape, the Tab trap and focus restoration all come from here, so this
     sheet behaves like the driver and circuit modals rather than inventing a
     third set of dialog semantics. */
  const dialogRef = useModalDialog<HTMLDivElement>({
    onClose,
    enabled: open && !detailOpen,
  });

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            type="button"
            aria-label="Close menu"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0.1 : 0.18 }}
            className="lg:hidden fixed inset-0 z-[60] bg-black/60 backdrop-blur-[2px]"
          />

          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="More sections"
            initial={reduce ? { opacity: 0 } : { y: "100%" }}
            animate={reduce ? { opacity: 1 } : { y: 0 }}
            exit={reduce ? { opacity: 0 } : { y: "100%" }}
            transition={
              reduce
                ? { duration: 0.1 }
                : { type: "spring", stiffness: 420, damping: 38 }
            }
            /* `max-h`/`overflow-y` because a short landscape phone is a real
               viewport: 390x844 fits this comfortably, 844x390 does not. */
            className="lg:hidden fixed bottom-0 left-0 right-0 z-[61] max-h-[85dvh] overflow-y-auto rounded-t-2xl bg-surface-container-low/97 backdrop-blur-2xl border-t border-white/[0.1] px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]"
          >
            {/* Decorative grabber. Not a control — the sheet is not draggable,
                and dressing it up as if it were would be a lie about the
                affordance. */}
            <div
              aria-hidden="true"
              className="mx-auto mb-4 h-1 w-9 rounded-full bg-white/20"
            />

            <div className="flex items-center justify-between mb-3">
              <h2 className="font-[family-name:var(--font-headline)] font-bold text-lg text-on-background">
                More
              </h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close menu"
                className="w-9 h-9 -mr-1 rounded-full flex items-center justify-center text-warm-300 hover:text-on-background transition-colors"
              >
                <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                  close
                </span>
              </button>
            </div>

            {/* The one place a phone can search the app. `variant="sheet"`
                exists purely so this can be full-width and drop its own
                `hidden lg:block`; the field's behaviour is untouched. */}
            <div className="mb-4">
              <GlobalSearch variant="sheet" onDetailOpenChange={setDetailOpen} />
            </div>

            <nav aria-label="More sections" className="flex flex-col gap-1.5">
              {items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onClose}
                  className="flex items-start gap-3 rounded-xl px-3 py-3 bg-veil/5 border border-white/[0.06] active:bg-veil/10 transition-colors"
                >
                  <span
                    className="material-symbols-outlined text-[22px] text-primary flex-none mt-0.5"
                    aria-hidden="true"
                  >
                    {item.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-semibold text-sm text-on-background">
                      {item.label}
                    </span>
                    <span className="block text-xs text-warm-400 leading-snug mt-0.5">
                      {item.blurb}
                    </span>
                  </span>
                </Link>
              ))}
            </nav>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
