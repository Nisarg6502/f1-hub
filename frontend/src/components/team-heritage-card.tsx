"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { getConstructorIdentity } from "@/lib/constructor-identity";
import { formatStint, type ResolvedNode } from "@/lib/constructor-lineages";
import type { EraStats, TeamDossier } from "@/lib/constructor-profiles";
import { EASE_OUT } from "./motion-primitives";

/**
 * The heritage half of a `/teams` card: what the team is, what its lineage
 * has won, and the chain of teams it used to be.
 *
 * PROVENANCE — every value rendered here falls into exactly one of two
 * groups, and the markup keeps them apart on purpose:
 *
 *  - COMPUTED, from cached archive data: the debut season, the seasons
 *    entered, every era's year span, race wins, and both championship
 *    counts. These come from `buildDossier` (constructor-profiles.ts), which
 *    reads `/api/constructor_seasons`, `/api/historical_race_index` and
 *    `/api/constructor_titles`. None of them is typed by hand anywhere.
 *  - HAND-AUTHORED, and labelled as such in the UI: the base location and
 *    the one-line description (`TEAM_PROFILES`), and the rename notes on
 *    each era chip (`CONSTRUCTOR_LINEAGES`, the curation the `/history`
 *    genealogy chart already ran on). No API states that Racing Bulls used
 *    to be Minardi, so that half is editorial; the "Team record" numbers
 *    beside it are not, and the two are never mixed inside one figure.
 *
 * `titlesComplete` is the guard on the championship rows. The backend fetches
 * ~144 seasons of standings on a cold build; a partial resolve produces an
 * undercount that reads exactly like a real number, so the counts are hidden
 * rather than shown low.
 */
export interface TeamHeritageCardProps {
  dossier: TeamDossier;
  /** Accent for the current era, matching the card it sits in. */
  accentHex: string;
  /** `/api/constructor_titles` resolved every season in range. False hides
   * the championship rows entirely. */
  titlesComplete: boolean;
  /** Last COMPLETED season the title data covers — the season being raced is
   * excluded, so the label has to say so rather than implying "all time". */
  titlesThroughSeason: number | null;
  /** True when the card is showing the season currently being raced.
   *
   * `TEAM_PROFILES.blurb` is written in the present tense about the team as it
   * exists NOW ("Lawrence Stroll's works Aston Martin entry... runs customer
   * Honda power units"). On `/teams?season=2019` that same card is titled
   * *Racing Point*, and the sentence would be describing a team two rebrands
   * and one engine supplier into the future. There is no per-season source to
   * correct it against — it is editorial, not archive data — so it is hidden
   * rather than shown wrong. `base` survives: an operating site is stable
   * across rebrands (Silverstone, Faenza, Enstone, Hinwil were all the same
   * address decades before the current names). */
  profileIsCurrent: boolean;
  /** Drop the block's own top rule and spacing.
   *
   * Set when the card is rendered inside `<TeamHeritageDisclosure>`, which
   * already draws a rule above its trigger — without this the panel opens with
   * a second hairline sitting a few pixels under the first. */
  bare?: boolean;
}

/** "An Aston Martin", "A Mercedes". Spelling-based rather than a phonetic
 * dictionary, which is enough for a closed set of constructor names. */
function indefiniteArticle(word: string): string {
  return /^[aeiou]/i.test(word.trim()) ? "An" : "A";
}

function eraColor(node: ResolvedNode): string {
  if (node.fallbackHex) return node.fallbackHex;
  if (node.colorKey) return getConstructorIdentity(node.colorKey).color.hex;
  return getConstructorIdentity(node.ergastIds[0]).color.hex;
}

/** Uses the era's `endYear` as capped by the season being viewed, not the
 * node's own — so the running era reads "2021–2026" at 2026 and "2021" at
 * 2021, rather than always claiming its full future span. */
function eraSpan(era: EraStats): string {
  const start = era.node.startYear;
  if (start === null) return "—";
  if (start === era.endYear) return String(start);
  return `${start}–${era.endYear}`;
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="font-semibold text-[9.5px] tracking-[0.1em] uppercase text-warm-500">
        {label}
      </div>
      <div className="font-extrabold text-[17px] tabular-nums leading-tight mt-0.5">
        {value}
      </div>
      {hint && (
        <div className="font-medium text-[10px] text-warm-500 leading-tight mt-0.5">
          {hint}
        </div>
      )}
    </div>
  );
}

export default function TeamHeritageCard({
  dossier,
  accentHex,
  titlesComplete,
  titlesThroughSeason,
  profileIsCurrent,
  bare = false,
}: TeamHeritageCardProps) {
  const reduce = useReducedMotion();
  const { eras, current, profile } = dossier;
  // Opens on the era the team races as today — the chain reads backwards
  // from "who they are now", which is the question the page is answering.
  const [selectedIndex, setSelectedIndex] = useState(
    eras.length > 0 ? eras.length - 1 : 0
  );
  const selected: EraStats | undefined = eras[selectedIndex];

  const isChain = eras.length > 1;
  // Every "N as Mercedes" hint names `current`. With the current era
  // unresolved there is no era to name, and naming the previous one attributes
  // this team's record to a team it is not — so the hints fall back to the
  // unattributed form rather than guessing.
  const attribute = isChain && current && !dossier.currentEraUnresolved;
  const titleWindow = titlesThroughSeason ? ` (to ${titlesThroughSeason})` : "";

  return (
    <div
      className={
        bare
          ? "relative pt-4"
          : "relative mt-6 pt-5 border-t border-white/[0.07]"
      }
    >
      {/* --- Computed: the team record ------------------------------------ */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-4">
        {/* Reads the CURRENT era, not `dossier.debutSeason`. This said
            "since 1970" on a card headed Mercedes — the debut of Tyrrell,
            a team of a different name, nationality and owner. The lineage
            figure is still shown, but under the lineage footnote below where
            it is labelled as one. */}
        <Stat
          label="On the grid"
          value={dossier.currentSince ? `since ${dossier.currentSince}` : "—"}
          hint={
            dossier.currentSeasons > 0
              ? `${dossier.currentSeasons} ${
                  dossier.currentSeasons === 1 ? "season" : "seasons"
                }${attribute ? ` as ${current!.node.label}` : " entered"}`
              : undefined
          }
        />
        <Stat
          label="Grand Prix wins"
          value={String(dossier.lineageWins)}
          hint={
            attribute
              ? `${current!.wins} as ${current!.node.label}`
              : "all-time"
          }
        />
        {titlesComplete ? (
          <>
            <Stat
              label="Constructors'"
              value={String(dossier.lineageConstructorTitles)}
              hint={
                attribute
                  ? `${current!.constructorTitles.length} as ${current!.node.label}`
                  : `titles${titleWindow}`
              }
            />
            <Stat
              label="Drivers'"
              value={String(dossier.lineageDriverTitles)}
              hint={
                attribute
                  ? `${current!.driverTitles.length} as ${current!.node.label}`
                  : `titles won here${titleWindow}`
              }
            />
          </>
        ) : (
          // Deliberately blank rather than zero: a failed title fetch and a
          // team with no titles are different facts and must not render the
          // same way.
          <div className="col-span-2 self-center font-medium text-[10px] text-warm-500 leading-snug">
            Championship totals unavailable — the title archive did not resolve
            in full, and a partial count would understate it.
          </div>
        )}
      </div>

      {dossier.currentEraUnresolved && (
        <div className="font-medium text-[10px] text-warm-500 mt-2.5 leading-snug">
          This team&apos;s own season history did not load, so the figures above
          cover its earlier eras only.
        </div>
      )}

      {/* The separate earlier life of a reused name. Mercedes raced in
          1954-1955 and came back in 2010; Aston Martin in 1959-1960 and came
          back in 2021. Those seasons are NOT counted into anything above —
          they were a different team by every measure except the name — but
          leaving them out entirely reads as if the team began at its most
          recent debut. */}
      {current && dossier.priorStints.length > 0 && (
        <div className="font-medium text-[10.5px] text-warm-400 mt-2.5 leading-snug">
          {indefiniteArticle(current.node.label)} {current.node.label} team also
          raced in {dossier.priorStints.map(formatStint).join(", ")} — a
          separate entry, not counted above.
        </div>
      )}

      {isChain && (
        <div className="font-medium text-[10px] text-warm-500 mt-2.5 leading-snug">
          Wins and titles are totalled across every era of this lineage — {
            dossier.seasonsEntered
          }{" "}
          seasons from {eras[0].node.label} in {dossier.debutSeason} onwards.
        </div>
      )}

      {/* --- Hand-authored: what the team is ------------------------------ */}
      {profile && (
        <div className="mt-5">
          <div className="font-semibold text-[9.5px] tracking-[0.1em] uppercase text-warm-500">
            Based
          </div>
          <div className="font-bold text-[13px] mt-0.5">{profile.base}</div>
          {profile.secondBase && (
            <div className="font-medium text-[11px] text-warm-400 mt-0.5">
              {profile.secondBase}
            </div>
          )}
          {profileIsCurrent && (
            <p className="font-medium text-[12.5px] leading-relaxed text-warm-300 mt-2.5">
              {profile.blurb}
            </p>
          )}
        </div>
      )}

      {/* --- The lineage ------------------------------------------------- */}
      <div className="mt-6">
        <div className="font-semibold text-[9.5px] tracking-[0.1em] uppercase text-warm-500 mb-2.5">
          {isChain ? "How this team came to exist" : "Lineage"}
        </div>

        {eras.length === 0 ? (
          <div className="font-medium text-[11px] text-warm-500">
            Lineage data unavailable.
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
            {eras.map((era, index) => {
              const hex = eraColor(era.node);
              const isSelected = index === selectedIndex;
              return (
                <div key={era.nodeIndex} className="flex items-center gap-1.5">
                  {index > 0 && (
                    <span
                      aria-hidden
                      className="font-bold text-[11px] text-warm-600 select-none"
                    >
                      →
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setSelectedIndex(index)}
                    aria-pressed={isSelected}
                    // `outline`, not `ring`: `.apex-glass-*` is declared
                    // unlayered and its box-shadow swallows a Tailwind ring,
                    // which has already cost this repo a focus indicator once.
                    className="group flex items-center gap-1.5 rounded-full pl-1.5 pr-2.5 py-1 outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary transition-colors"
                    style={{
                      background: isSelected
                        ? `${hex}2E`
                        : "rgba(245,235,222,0.05)",
                      border: `1px solid ${isSelected ? `${hex}9E` : "rgba(245,235,222,0.09)"}`,
                    }}
                  >
                    <span
                      className="w-2 h-2 rounded-full flex-none"
                      style={{ background: hex }}
                    />
                    <span
                      className={`font-bold text-[11px] whitespace-nowrap ${
                        isSelected ? "text-warm-100" : "text-warm-300"
                      }`}
                    >
                      {era.node.label}
                    </span>
                    <span className="font-semibold text-[10px] tabular-nums text-warm-500 whitespace-nowrap">
                      {eraSpan(era)}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <AnimatePresence mode="wait">
          {selected && (
            <motion.div
              key={selected.nodeIndex}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
              transition={{ duration: reduce ? 0.1 : 0.2, ease: EASE_OUT }}
              className="mt-3 rounded-xl px-3.5 py-3 bg-[rgba(245,235,222,0.035)] border border-white/[0.06]"
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-[family-name:var(--font-headline)] font-bold text-[13px] text-warm-100">
                  {selected.node.label}
                </span>
                <span className="font-semibold text-[10.5px] tabular-nums text-warm-400">
                  {eraSpan(selected)} · {selected.seasonCount}{" "}
                  {selected.seasonCount === 1 ? "season" : "seasons"} ·{" "}
                  {selected.wins === 0
                    ? "no wins"
                    : `${selected.wins} ${selected.wins === 1 ? "win" : "wins"}`}
                </span>
              </div>

              {titlesComplete &&
                (selected.constructorTitles.length > 0 ||
                  selected.driverTitles.length > 0) && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {selected.constructorTitles.length > 0 && (
                      <span
                        className="font-semibold text-[10px] px-2 py-[3px] rounded-md tabular-nums"
                        style={{
                          background: `${accentHex}22`,
                          color: "var(--color-warm-100)",
                        }}
                        title={selected.constructorTitles.join(", ")}
                      >
                        {selected.constructorTitles.length}× Constructors&apos;{" "}
                        <span className="text-warm-400">
                          {selected.constructorTitles.join(" · ")}
                        </span>
                      </span>
                    )}
                    {selected.driverTitles.length > 0 && (
                      <span className="font-semibold text-[10px] px-2 py-[3px] rounded-md bg-[rgba(245,235,222,0.07)] text-warm-200 tabular-nums">
                        {selected.driverTitles.length}× Drivers&apos;{" "}
                        <span className="text-warm-400">
                          {selected.driverTitles
                            .map((t) => `${t.driver} ${t.season}`)
                            .join(" · ")}
                        </span>
                      </span>
                    )}
                  </div>
                )}

              {/* The rename story. Curated, not computed — see the
                  constructor-lineages.ts header. */}
              <p className="font-medium text-[11.5px] leading-relaxed text-warm-300 mt-2">
                {selected.node.note}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
