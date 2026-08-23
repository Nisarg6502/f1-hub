"use client";

/**
 * "Also in here" — a one-line discovery rail for the home page.
 *
 * The problem it solves: APEX's best surfaces (the WebGL elevation model, the
 * Pitwall strategy lab, the real-pace race replay, the 75-season barcode) are
 * two or three navigations deep and a first-time visitor has no reason to
 * suspect they exist. The home page links to Schedule / Standings / Drivers /
 * Teams and stops there.
 *
 * The form is the "loading screen tip" the user asked for: one short pointer at
 * a time, rotating slowly, each one a real link to a route that actually works.
 *
 * Three things it deliberately does NOT do:
 *   - It never advertises anything unverified. Every tip below points at a
 *     route confirmed to render: `/circuits/spa` is one of the four geometry
 *     payloads bundled in `frontend/public/tracks/`, so the 3D viewer loads
 *     with no bucket and no backend. `/telemetry` is excluded on purpose — it
 *     has never rendered a row of timing data (see FEATURES.md, "Known gaps").
 *   - It never rotates during server render. The first tip is seeded from the
 *     round number, so server and client HTML agree; rotation only begins in an
 *     effect after mount. `Math.random()` here would be a hydration mismatch on
 *     a `force-dynamic` page.
 *   - It never moves under someone who is reading or operating it. Rotation
 *     pauses on hover and on focus-within, and is off entirely under
 *     `prefers-reduced-motion`, where the dots stay as manual controls.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { EASE_OUT } from "@/components/motion-primitives";

/** How long each tip holds before the rail advances. */
const ROTATE_MS = 7000;

interface Tip {
  id: string;
  /** Material Symbols ligature. Decorative — the text carries the meaning. */
  icon: string;
  /** Short label, sentence case, no trailing punctuation. */
  title: string;
  /** One clause saying what you get. This is the part that sells the click. */
  blurb: string;
  href: string;
}

/**
 * Build the tip list. `pitwallHref` depends on there being a completed round,
 * so the Pitwall tip drops out of the rotation entirely rather than pointing at
 * a round with no strategy data behind it.
 */
function buildTips(pitwallHref: string | null): Tip[] {
  const tips: Tip[] = [
    {
      id: "circuit-3d",
      icon: "landscape",
      title: "Circuits in 3D",
      blurb:
        "Spa's 100 m of elevation change, modelled from real survey data",
      href: "/circuits/spa",
    },
    {
      id: "watch",
      icon: "play_circle",
      title: "Replay a race at real pace",
      blurb: "A timing tower that re-orders itself lap by lap, as it happened",
      href: "/watch",
    },
    {
      id: "history",
      icon: "barcode",
      title: "75 seasons as one barcode",
      blurb: "Every championship race since 1950, coloured by who won it",
      href: "/history",
    },
    {
      id: "drivers",
      icon: "compare_arrows",
      title: "Put two drivers head-to-head",
      blurb: "Season-long comparison with a written recap of the fight",
      href: "/drivers",
    },
    {
      id: "circuit-dna",
      icon: "conversion_path",
      title: "Compare circuit DNA",
      blurb: "Overlay two track layouts and see what actually differs",
      href: "/circuits",
    },
  ];

  if (pitwallHref) {
    // Second in the list rather than last: it is the deepest surface in the app
    // (three navigations from here) and the one most worth finding.
    tips.splice(1, 0, {
      id: "pitwall",
      icon: "insights",
      title: "Open the Pitwall",
      blurb: "Tyre stints, pit stops and lap-by-lap position for the last race",
      href: pitwallHref,
    });
  }

  return tips;
}

export default function DiscoveryTips({
  seasonYear,
  latestCompletedRound = null,
  seed = 0,
}: {
  seasonYear: number;
  /** Round number of the most recent completed race, if any. */
  latestCompletedRound?: number | null;
  /** Deterministic starting offset — pass the current round number. */
  seed?: number;
}) {
  const reduce = useReducedMotion();

  const tips = useMemo(
    () =>
      buildTips(
        latestCompletedRound
          ? `/schedule/${seasonYear}/${latestCompletedRound}/pitwall`
          : null,
      ),
    [seasonYear, latestCompletedRound],
  );

  // Seeded, not random: this value is computed identically on the server and on
  // the first client render.
  const start = ((seed % tips.length) + tips.length) % tips.length;
  const [index, setIndex] = useState(start);
  const [paused, setPaused] = useState(false);

  // Rotation starts only on the client, and this effect IS the guard: effects
  // never run during server rendering, so the markup the server emits is the
  // static `start` tip by construction. An extra `mounted` flag flipped from a
  // second effect would say the same thing at the cost of a synchronous
  // setState inside an effect body, which is a cascading render and a lint
  // error (`react-hooks/set-state-in-effect`) for no behavioural gain.
  //
  // A manual pick should get its full dwell time, not the remainder of the
  // interval it interrupted, so the timer is keyed on `index` too.
  useEffect(() => {
    if (reduce || paused || tips.length < 2) return;
    const t = window.setTimeout(
      () => setIndex((i) => (i + 1) % tips.length),
      ROTATE_MS,
    );
    return () => window.clearTimeout(t);
  }, [reduce, paused, index, tips.length]);

  const dotsRef = useRef<HTMLDivElement>(null);

  /** Left/Right arrows move between dots, as a carousel's controls should. */
  const onDotKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const buttons = Array.from(
        dotsRef.current?.querySelectorAll("button") ?? [],
      );
      // Move relative to the dot that actually has focus, not to the active
      // tip: they can differ (tab in, then press Right) and stepping from the
      // active tip would jump focus somewhere the user did not put it.
      const from = buttons.indexOf(e.target as HTMLButtonElement);
      const current = from >= 0 ? from : index;
      const next =
        e.key === "ArrowRight"
          ? (current + 1) % tips.length
          : (current - 1 + tips.length) % tips.length;
      setIndex(next);
      buttons[next]?.focus();
    },
    [index, tips.length],
  );

  const tip = tips[index];
  if (!tip) return null;

  return (
    <div
      className="apex-glass-soft rounded-2xl mt-4 px-[18px] py-[14px] flex flex-wrap items-center gap-x-4 gap-y-3"
      role="group"
      aria-roledescription="carousel"
      aria-label="More to explore in APEX"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <span className="font-semibold text-[10px] tracking-[0.14em] uppercase text-warm-500 flex-none">
        Also in here
      </span>

      {/* Full width below `sm` so the blurb gets two lines on a 390px phone
          rather than four, pushing the dots onto their own row. Done with
          `basis`, not `order`: a CSS `order` swap would put the dots above the
          link visually while the link still comes first in the tab sequence,
          and a focus order that disagrees with the reading order is exactly
          what WCAG 2.4.3 is about. */}
      <div className="relative basis-full sm:basis-auto sm:flex-1 min-w-0 sm:min-w-[220px]">
        {/* `mode="wait"` keeps exactly one link in the DOM at a time, so a
            keyboard user can never tab into a tip that is fading out. */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tip.id}
            initial={reduce ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 1 } : { opacity: 0, y: -6 }}
            transition={{ duration: 0.32, ease: EASE_OUT }}
          >
            <Link
              href={tip.href}
              className="group flex items-center gap-3 rounded-control -mx-1 px-1 py-0.5 outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            >
              <span
                className="material-symbols-outlined text-[18px] leading-none text-flame flex-none"
                aria-hidden="true"
              >
                {tip.icon}
              </span>
              <span className="min-w-0">
                <span className="font-bold text-[13px] text-warm-100 group-hover:text-primary transition-colors duration-150">
                  {tip.title}
                </span>
                {/* One line on a phone, one line beside the title on a laptop.
                    Inline at every width wrapped this to four lines at 390px
                    and made a 58px rail 157px tall. */}
                <span className="block sm:inline font-medium text-xs text-warm-400 sm:ml-2">
                  {tip.blurb}
                </span>
              </span>
              <span
                className="material-symbols-outlined text-[16px] leading-none text-warm-500 flex-none transition-transform duration-200 group-hover:translate-x-1 group-hover:text-primary"
                aria-hidden="true"
              >
                arrow_forward
              </span>
            </Link>
          </motion.div>
        </AnimatePresence>
      </div>

      <div
        ref={dotsRef}
        className="flex items-center gap-1.5 flex-none"
        onKeyDown={onDotKeyDown}
      >
        {tips.map((t, i) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setIndex(i)}
            aria-label={t.title}
            aria-current={i === index ? "true" : undefined}
            /* 6px to the eye, ~24px to a finger — the `before:` pseudo-element
               expands the hit area without moving the dot, the same trick the
               ring info buttons on this page use. */
            className={`relative w-1.5 h-1.5 rounded-full transition-colors duration-200 before:absolute before:-inset-2 before:content-[''] outline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${
              i === index ? "bg-flame" : "bg-veil/20 hover:bg-veil/40"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
