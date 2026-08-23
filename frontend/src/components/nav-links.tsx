"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";

const navItems = [
  { href: "/", label: "Home" },
  { href: "/schedule", label: "Schedule" },
  { href: "/watch", label: "Watch" },
  { href: "/standings", label: "Standings" },
  { href: "/drivers", label: "Drivers" },
  { href: "/teams", label: "Teams" },
  { href: "/circuits", label: "Circuits" },
  { href: "/telemetry", label: "Live" },
  { href: "/history", label: "History" },
];

/** Where the underline should sit, in the row's own coordinate space. */
type Underline = { left: number; width: number; top: number };

/**
 * `useLayoutEffect` warns when React renders this on the server. The row is
 * `hidden` below `lg` and has nothing to measure before hydration anyway, so
 * falling back to `useEffect` there is correct rather than merely quiet.
 */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export default function NavLinks() {
  const pathname = usePathname();
  const reduce = useReducedMotion();

  /*
   * ONE indicator for the whole row, positioned from a measurement — not a
   * `layoutId` shared element per link, which is what this used to be and
   * what made it fly in from the bottom of the screen.
   *
   * Motion's layout projection measures boxes in DOCUMENT space: it snapshots
   * the outgoing element, re-measures the incoming one, and corrects the
   * difference by however much the page scrolled in between. That correction
   * is right for content that scrolls with the document and wrong for this
   * nav, which is `position: sticky` (see `layout.tsx`) and therefore does
   * not move when the page scrolls at all.
   *
   * The App Router resets scroll to the top on navigation, so clicking a tab
   * from part-way down a page handed the underline a bogus vertical delta
   * equal to the old scroll position. Measured over CDP at scrollY 682, the
   * underline started at viewport top 711 — near the bottom of a 900px
   * window — and flew ~665px up to the nav. It looked broken because it was
   * genuinely animating from the bottom of the screen.
   *
   * `layoutRoot` on the row is Motion's documented answer for `position:
   * sticky`; it was tried here and did not remove the correction (the
   * shared-element path still resolved a document-space target: still 513px
   * of vertical flight). Measuring the active link ourselves sidesteps
   * projection entirely: the numbers below are offsets inside this row, which
   * scroll cannot change, so the indicator can only ever move horizontally.
   */
  const rowRef = useRef<HTMLDivElement | null>(null);
  const linkRefs = useRef(new Map<string, HTMLAnchorElement>());
  const [underline, setUnderline] = useState<Underline | null>(null);

  const activeHref = navItems.reduce<string | null>((match, item) => {
    const hit =
      item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
    return hit ? item.href : match;
  }, null);

  const measure = useCallback(() => {
    const row = rowRef.current;
    const el = activeHref ? linkRefs.current.get(activeHref) : undefined;
    if (!row || !el) {
      setUnderline(null);
      return;
    }
    const rowBox = row.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    // Zero-width while the row is `display: none` below `lg`. Nothing to
    // point at, and a zero-width underline would be a visible sliver at x=0.
    if (box.width === 0) {
      setUnderline(null);
      return;
    }
    // Rects rather than `offsetLeft`/`offsetWidth`, which are integers: the
    // labels land on fractional pixels and rounding them visibly shortened
    // the bar. The row has no border or padding, so its border box and the
    // absolute positioning context agree.
    const next: Underline = {
      left: box.left - rowBox.left,
      width: box.width,
      // The link's own bottom edge: the old underline was `-bottom-0.5` with
      // `h-[2px]`, i.e. its top edge sat exactly on that line.
      top: box.bottom - rowBox.top,
    };
    setUnderline((prev) =>
      prev &&
      prev.left === next.left &&
      prev.width === next.width &&
      prev.top === next.top
        ? prev
        : next
    );
  }, [activeHref]);

  // Before paint, so a route change never shows the underline at the old tab.
  useIsomorphicLayoutEffect(measure, [measure]);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    // Covers the `lg` breakpoint crossing, window resizes and the moment the
    // webfont swaps in — all of which change where the labels are, and any of
    // which would otherwise leave the underline stranded under the old
    // position until the next navigation.
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    for (const link of linkRefs.current.values()) observer.observe(link);
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (!cancelled) measure();
    });
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [measure]);

  return (
    /*
     * The row lives here rather than in `layout.tsx` because the indicator has
     * to be measured against it and drawn inside it.
     *
     * `lg`, not `md`, and the difference is two unreachable destinations. Nine
     * links plus the logo, search, launcher and season badge need about 900px;
     * at `md` the bar overflowed its own container — measured at 768x1024 the
     * page scrollWidth was 880 against a clientWidth of 768, "History"
     * rendered as "Histor" and the season badge was off-screen entirely. At
     * 844x390 the Pitwall launcher was drawn *on top of* a nav link. Every
     * tablet and every landscape phone lands in that 768-900 band. `lg` is
     * also where GlobalSearch already hides itself, so the two agree, and the
     * mobile bar in `layout.tsx` must move with this or 768-1023px is left
     * with no navigation at all.
     */
    <div
      ref={rowRef}
      className="relative hidden lg:flex items-center gap-[30px] font-[family-name:var(--font-body)] font-semibold text-[13px]"
    >
      {underline && (
        <motion.span
          aria-hidden="true"
          data-nav-underline=""
          className="absolute left-0 h-[2px] rounded-full bg-primary-container shadow-[0_0_10px_rgb(var(--rgb-primary-container)_/_0.8)] pointer-events-none"
          style={{ top: underline.top }}
          /* `initial={false}` is what protects first load, hard refresh and
             back/forward: the indicator adopts its measured position on mount
             instead of animating in from a default. Only later changes to
             `animate` — i.e. actually switching tabs — produce motion. */
          initial={false}
          animate={{ x: underline.left, width: underline.width }}
          /* Motion only consults the OS setting when a `MotionConfig` tells it
             to, and this app has none, so this has to be explicit. The
             `globals.css` reduced-motion block cannot reach it either: this
             animates an inline transform, not a CSS transition. Zero duration
             cuts to the new tab, matching `template.tsx`. */
          transition={
            reduce
              ? { duration: 0 }
              : { type: "spring", stiffness: 400, damping: 32 }
          }
        />
      )}
      {navItems.map((item) => {
        const isActive = item.href === activeHref;

        return (
          <Link
            key={item.href}
            href={item.href}
            ref={(node) => {
              if (node) linkRefs.current.set(item.href, node);
              else linkRefs.current.delete(item.href);
            }}
            // The active link was marked only by colour and an animated
            // underline, both invisible to a screen reader. `/watch`'s season
            // tabs already do this correctly, so the pattern was known here
            // and simply not applied to the main nav.
            aria-current={isActive ? "page" : undefined}
            /* `py-1` leaves these 28px tall. That clears WCAG 2.5.8's 24px
               floor but not the 40px a finger needs, and 1280px is a landscape
               tablet as often as it is a laptop. The hit area grows vertically
               only — 6px top and bottom takes it to 40 — because the row is
               laid out with a horizontal gap and widening these would let
               adjacent links overlap. Written as two offsets rather than
               `-inset-y-1.5`; see the footer link in layout.tsx for why a
               negative compound inset is not trusted here without measuring. */
            className={`relative py-1 transition-colors duration-200 before:absolute before:-top-1.5 before:-bottom-1.5 before:left-0 before:right-0 before:content-[''] ${
              isActive
                ? "text-on-background"
                : "text-warm-400 hover:text-on-background"
            }`}
          >
            {item.label}
            {/* The server cannot measure anything, so the server-rendered
                markup carries a plain, correctly-placed underline. The
                measured indicator above replaces it in the same commit as the
                first layout effect, before paint — which keeps the underline
                visible from the very first frame of a hard refresh instead of
                popping in at hydration. */}
            {isActive && !underline && (
              <span
                aria-hidden="true"
                className="absolute -bottom-0.5 left-0 right-0 h-[2px] rounded-full bg-primary-container shadow-[0_0_10px_rgb(var(--rgb-primary-container)_/_0.8)]"
              />
            )}
          </Link>
        );
      })}
    </div>
  );
}

export function MobileNav() {
  const pathname = usePathname();

  /**
   * Six, and the sixth is Watch on purpose.
   *
   * This bar is the *only* navigation below 1024px, so anything missing from
   * it is unreachable on a phone. Watch mode is the app's second-screen
   * feature — it is designed for a phone propped against a television — and it
   * had no way to be reached from one, which is close to the definition of a
   * feature that does not ship.
   *
   * It stops at six because the labels have to stay legible: at 390px the row
   * has ~342px to divide, and a seventh column puts "Standings" under 48px.
   * Teams, Live and History remain desktop-only here; they are reachable from
   * in-page links, and a bottom bar that has to scroll is worse than a short
   * one. Labels are shortened rather than dropped — an unlabelled icon row is
   * a guessing game.
   */
  const mobileItems = [
    { href: "/", icon: "home", label: "Home" },
    { href: "/schedule", icon: "event", label: "Races" },
    { href: "/watch", icon: "smart_display", label: "Watch" },
    { href: "/standings", icon: "leaderboard", label: "Table" },
    { href: "/drivers", icon: "groups", label: "Drivers" },
    { href: "/circuits", icon: "route", label: "Tracks" },
  ];

  return (
    <>
      {mobileItems.map((item) => {
        const isActive =
          item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={`flex flex-col items-center gap-1 flex-1 min-w-0 transition-colors ${
              isActive ? "text-primary" : "text-warm-500"
            }`}
          >
            {/* Hidden from assistive technology because the ligature text IS
                the glyph: a Material Symbols span containing "home" is read
                aloud as the word, so this link announced itself as "homeHome"
                and the schedule one as "eventRaces". The launcher button
                already sets this; the nav simply never did. */}
            <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
              {item.icon}
            </span>
            <span className="text-[9px] font-semibold tracking-[0.1em] uppercase">
              {item.label}
            </span>
          </Link>
        );
      })}
    </>
  );
}
