"use client";

import { useId, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import TeamHeritageCard, {
  type TeamHeritageCardProps,
} from "./team-heritage-card";
import { EASE_OUT } from "./motion-primitives";

/**
 * Puts the heritage half of a `/teams` card behind a disclosure.
 *
 * The heritage block is the most interesting thing on the page and also the
 * longest: four stats, a base, a paragraph, an era chain and a panel for the
 * selected era, on every one of eleven cards. All of it open at once turns a
 * grid of teams into a wall of prose you have to scroll past to compare two
 * constructors' seasons — the job the page is nominally for.
 *
 * So it closes by default and opens in place, unchanged, per card. Per card
 * rather than one page-wide switch because the question it answers ("what is
 * this team, really?") is asked about one team at a time, and because a global
 * toggle would re-flow every row the moment you touched it.
 *
 * The collapsed state is not just a chevron: it carries the three facts most
 * likely to make someone open it (how long the team has been here, its
 * all-time win count, how many names it has raced under), so the button is an
 * answer in itself rather than a promise of one.
 */
export default function TeamHeritageDisclosure({
  dossier,
  accentHex,
  titlesComplete,
  titlesThroughSeason,
  profileIsCurrent,
  teamName,
}: TeamHeritageCardProps & { teamName: string }) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();
  const panelId = useId();

  const eraCount = dossier.eras.length;
  const summary = [
    dossier.currentSince ? `Since ${dossier.currentSince}` : null,
    `${dossier.lineageWins} all-time ${
      dossier.lineageWins === 1 ? "win" : "wins"
    }`,
    eraCount > 1 ? `${eraCount} names` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="relative mt-6 border-t border-white/[0.07]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        /* `outline`, not `ring` — `.apex-glass-*` is declared unlayered and its
           box-shadow swallows a Tailwind ring, which has already cost this repo
           a focus indicator once (see team-heritage-card.tsx). */
        className="group/disc w-full flex items-center gap-3 pt-4 text-left rounded-lg outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFAE6A]"
      >
        {/* Eleven of these buttons sit on one page and the visible label is
            identical on all of them, so the team name leads the accessible
            name. No "show"/"hide" verb: `aria-expanded` already announces the
            state, and saying it twice is worse than saying it once. */}
        <span className="sr-only">{teamName}, </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-[9.5px] tracking-[0.1em] uppercase text-warm-500 group-hover/disc:text-warm-300 transition-colors">
            Heritage &amp; lineage
          </span>
          <span className="block font-semibold text-[11.5px] text-warm-300 tabular-nums mt-0.5 truncate">
            {summary}
          </span>
        </span>
        <span
          aria-hidden
          className="material-symbols-outlined text-[20px] leading-none text-warm-500 group-hover/disc:text-warm-200 transition-[color,transform] duration-300 flex-none"
          style={{
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            transitionTimingFunction: "var(--ease-out-apex)",
          }}
        >
          expand_more
        </span>
      </button>

      {/* The panel id is on this wrapper, which is always in the DOM, rather
          than on the animated child that only exists while open — `aria-controls`
          pointing at a missing element is a dangling reference, and assistive
          tech has nothing to move to. */}
      <div id={panelId}>
        <AnimatePresence initial={false}>
          {open && (
          <motion.div
            key="panel"
            initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduce ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduce ? 0.1 : 0.32, ease: EASE_OUT }}
            // The measured child must not spill while the height is animating
            // between 0 and its natural value.
            className="overflow-hidden"
          >
            <TeamHeritageCard
              dossier={dossier}
              accentHex={accentHex}
              titlesComplete={titlesComplete}
              titlesThroughSeason={titlesThroughSeason}
              profileIsCurrent={profileIsCurrent}
              bare
            />
          </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
