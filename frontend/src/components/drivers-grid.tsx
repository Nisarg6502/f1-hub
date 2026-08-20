"use client";

import { useState } from "react";
import Image from "next/image";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react";
import type { DriverStanding } from "@/lib/api";
import { getDriverImagePath, hasDriverImage } from "@/lib/driver-images";
import { driverPortraitFrameStyle, driverPortraitSizes } from "@/lib/driver-portrait";
import { getFlagPath } from "@/lib/flags";
import { getTeamColor, type TeamColor } from "@/lib/team-colors";
import { getTeamAbbreviation, getTeamLogoPath } from "@/lib/team-images";
import TiltCard from "@/components/tilt-card";
import FlagImg from "@/components/flag-img";
import { EASE_OUT, Stagger, StaggerItem } from "@/components/motion-primitives";
import DriverModal from "@/components/driver-modal";

interface DriversGridProps {
  drivers: DriverStanding[];
}

/**
 * The portrait rises further than its card does, and slightly behind it.
 *
 * `StaggerItem` already brings the card up 18px; this takes the driver up from
 * 34 with a small delay, so the figure arrives *into* a card that is already
 * there rather than the whole thing sliding as one flat plate. That offset is
 * the entire effect — it is a parallax cue, not a second animation competing
 * with the first, which is why it shares the group's easing and finishes with
 * it rather than running long.
 *
 * Skipped outright under `prefers-reduced-motion` (the variant is not passed at
 * all): the card's own fade still communicates arrival, and a 34px translate is
 * exactly the vestibular trigger that setting exists to remove.
 */
const photoReveal: Variants = {
  hidden: { opacity: 0, transform: "translateY(34px)" },
  show: {
    opacity: 1,
    transform: "translateY(0px)",
    transition: { duration: 0.55, delay: 0.06, ease: EASE_OUT },
  },
};

/**
 * The team's own mark, or its colour and abbreviation when it has none.
 *
 * **Landscape, not square.** These are wordmarks: McLaren is 3.3:1, Alpine and
 * Cadillac are near 2:1, while Mercedes, Williams, Haas and Audi are all
 * roughly square. Fitted into a 32x32 box the wide ones `object-contain` down
 * to a 6px-tall smear that reads as an empty white chip — which is exactly what
 * the first pass shipped. A 58x30 plate holds the widest wordmark legibly and
 * still centres a square mark with sensible margins.
 *
 * On a light plate, matching `/teams`. These marks are drawn for white
 * backgrounds — Mercedes and Haas are near-black SVGs — and dropped straight
 * onto a dark card several of them disappear entirely.
 *
 * Only eight of the eleven current constructors have a freely-licensed logo
 * (see `team-images.ts`), so the lettered fallback is a normal case rather than
 * an edge case. It keeps the plate's silhouette and swaps cream for the livery
 * colour, so a grid of 22 cards stays regular instead of alternating between
 * two differently-shaped badges.
 */
function TeamMark({
  team,
  color,
  logoPath,
}: {
  team: string;
  color: TeamColor;
  logoPath: string | null;
}) {
  if (logoPath) {
    return (
      <span className="relative w-[58px] h-[30px] rounded-[9px] flex-none bg-[rgba(245,235,222,0.94)] shadow-[0_2px_10px_rgba(0,0,0,0.35)]">
        <Image
          src={logoPath}
          alt={`${team} logo`}
          fill
          sizes="58px"
          className="object-contain p-1"
        />
      </span>
    );
  }
  return (
    <span
      className="w-[58px] h-[30px] rounded-[9px] flex-none flex items-center justify-center font-[family-name:var(--font-headline)] font-extrabold text-[13px] tracking-[0.06em] shadow-[0_2px_10px_rgba(0,0,0,0.35)]"
      style={{ background: color.hex, color: "#0a0908" }}
      aria-label={`${team} logo`}
    >
      {getTeamAbbreviation(team)}
    </span>
  );
}

export default function DriversGrid({ drivers }: DriversGridProps) {
  const [selected, setSelected] = useState<DriverStanding | null>(null);
  const reduce = useReducedMotion();

  const list = drivers ?? [];
  const maxPoints = list.length ? Number(list[0].points) || 1 : 1;

  const selectedId = selected?.Driver.driverId;
  const selectedImgPath = selected
    ? hasDriverImage(selected.Driver.givenName, selected.Driver.familyName)
      ? getDriverImagePath(selected.Driver.givenName, selected.Driver.familyName)
      : null
    : null;
  const selectedFlagSrc = selected ? getFlagPath(selected.Driver.nationality) : null;
  const selectedColor = selected
    ? getTeamColor(selected.Constructors?.[0]?.name ?? "—")
    : null;

  return (
    <>
      <Stagger
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 [perspective:1400px]"
        gap={0.05}
      >
        {list.map((driver, idx) => {
          const given = driver.Driver.givenName ?? "";
          const family = driver.Driver.familyName ?? "";
          const team = driver.Constructors?.[0]?.name ?? "—";
          const color = getTeamColor(team);
          const pts = Number(driver.points);
          const barPct = maxPoints > 0 ? (pts / maxPoints) * 100 : 0;
          const num = driver.Driver.permanentNumber ?? String(idx + 1);
          const driverId = driver.Driver.driverId;
          const hasImg = hasDriverImage(given, family);
          const imgPath = hasImg ? getDriverImagePath(given, family) : null;
          const flagSrc = getFlagPath(driver.Driver.nationality);
          const photoLayoutId =
            !reduce && driverId ? `driver-photo-${driverId}` : undefined;

          return (
            <StaggerItem key={`${given} ${family}` || idx}>
              <TiltCard
                className="group apex-glass rounded-[18px] overflow-hidden p-5 min-h-[340px] block h-full cursor-pointer"
                strength={6}
                onClick={() => setSelected(driver)}
                ariaLabel={`View ${given} ${family}'s profile`}
              >
                {/* team accent */}
                <div
                  className="absolute top-0 left-0 right-0 h-[3px] z-30"
                  style={{ background: color.hex }}
                />

                {/* The portrait is the card's background now, not a framed
                    inset. It runs from under the name block to the card's own
                    bottom edge and is CLIPPED there by the card's
                    `overflow-hidden`, so the driver stands in the card rather
                    than sitting in a box on it.

                    Layer order, bottom to top: portrait, scrim, number, text.
                    The number is deliberately in FRONT of the driver and is
                    drawn as etched glass — a low-opacity fill with a slightly
                    brighter stroke — so it reads as a graphic laid over the
                    photo without hiding the face behind it. A solid numeral
                    here would just be a hole in the picture. */}
                <div className="absolute inset-x-0 top-[84px] bottom-0 z-0 overflow-hidden">
                  {imgPath ? (
                    // Two wrappers, each with exactly one job, because they
                    // cannot share an element: `photoLayoutId` drives the
                    // shared layout transition into the modal and Motion owns
                    // that element's `transform`, the entrance variant owns the
                    // next one's, and the CSS hover transform owns the outer.
                    // Collapsing any pair would have one silently overwrite
                    // another.
                    <div className="absolute inset-0 transition-transform duration-[260ms] ease-[var(--ease-out-apex)] will-change-transform group-hover:[transform:translateY(-10px)_scale(1.04)] motion-reduce:transition-none motion-reduce:group-hover:[transform:none]">
                      <motion.div
                        className="absolute inset-0"
                        variants={reduce ? undefined : photoReveal}
                      >
                        <motion.div layoutId={photoLayoutId} className="absolute inset-0">
                          <div style={driverPortraitFrameStyle("figure")}>
                            <Image
                              src={imgPath}
                              alt={`${given} ${family}`}
                              fill
                              sizes={driverPortraitSizes(256, "figure")}
                              className="object-cover drop-shadow-[0_18px_40px_rgba(0,0,0,0.75)]"
                              priority={idx < 4}
                            />
                          </div>
                        </motion.div>
                      </motion.div>
                    </div>
                  ) : (
                    <div className="absolute inset-0 apex-hatch flex items-end justify-center pb-2">
                      <span className="font-semibold text-[8px] tracking-[0.1em] text-warm-500">
                        {"// CUTOUT"}
                      </span>
                    </div>
                  )}
                </div>

                {/* Scrim. The stats footer sits on top of a photograph now, and
                    a driver in a pale suit against pale text is unreadable —
                    this keeps the contrast fixed rather than depending on which
                    driver it is. Team colour at the very bottom ties the card
                    to the livery. */}
                <div
                  className="absolute inset-x-0 bottom-0 h-[46%] z-10 pointer-events-none"
                  style={{
                    background: `linear-gradient(to top, rgba(10,9,8,0.94) 0%, rgba(10,9,8,0.72) 38%, rgba(10,9,8,0) 100%)`,
                  }}
                />
                <div
                  className="absolute inset-x-0 bottom-0 h-[3px] z-10 opacity-50 pointer-events-none"
                  style={{ background: color.hex }}
                />

                {/* The permanent number, in front of the driver. */}
                <div
                  className="absolute right-[-8px] bottom-[52px] z-20 font-[family-name:var(--font-headline)] font-extrabold text-[128px] leading-none select-none pointer-events-none text-white/[0.07] transition-[opacity,transform] duration-[260ms] ease-[var(--ease-out-apex)] group-hover:text-white/[0.11] group-hover:[transform:translateX(-4px)] motion-reduce:transition-none motion-reduce:group-hover:[transform:none]"
                  style={{ WebkitTextStroke: "1px rgba(255,255,255,0.13)" }}
                >
                  {num}
                </div>

                {/* Header: who they race *for* on the right, where they are
                    *from* on the left.

                    These two used to sit side by side — flag, then team name —
                    which read as one caption, so a Dutch flag next to "Red Bull"
                    looked like a claim about the team's nationality. Splitting
                    them to opposite corners and labelling the flag with the
                    nationality itself makes each half self-describing: the left
                    is a country and says so, the right is a brand mark. The
                    team's *name* is spelled out in the footer, where the scrim
                    guarantees contrast and there is room for "Aston Martin
                    Aramco" without truncating it to nonsense. */}
                <div className="relative z-20 flex items-start justify-between gap-2">
                  <span className="flex items-center gap-[7px] min-w-0">
                    <span className="w-[26px] h-[18px] rounded flex items-center justify-center overflow-hidden bg-[rgba(245,235,222,0.08)] flex-none">
                      <FlagImg
                        src={flagSrc}
                        alt=""
                        width={26}
                        height={18}
                        className="object-cover w-full h-full"
                      />
                    </span>
                    <span className="font-semibold text-[10px] tracking-[0.08em] uppercase text-warm-400 truncate">
                      {driver.Driver.nationality ?? "—"}
                    </span>
                  </span>
                  <TeamMark team={team} color={color} logoPath={getTeamLogoPath(team)} />
                </div>
                <div className="relative z-20 mt-2">
                  <div className="font-medium text-xs text-warm-300">{given}</div>
                  <div className="font-[family-name:var(--font-headline)] font-extrabold text-[22px] leading-none">
                    {family}
                  </div>
                </div>

                {/* stats footer */}
                <div className="absolute left-5 right-5 bottom-5 z-20">
                  {/* The team, named. Sits on the scrim rather than up in the
                      header because this is the one place on the card with
                      guaranteed contrast and the full card width — the longest
                      constructor names run past twenty characters and there is
                      nowhere else they fit unabbreviated. The swatch is the same
                      colour as the accent stripe at the card's top edge and the
                      progress bar directly below, so the three read as one
                      livery rather than three decorations. */}
                  <div className="flex items-center gap-[7px] mb-2 min-w-0">
                    <span
                      className="w-[3px] h-[11px] rounded-full flex-none"
                      style={{ background: color.hex }}
                    />
                    <span className="font-bold text-[10px] tracking-[0.09em] uppercase text-warm-200 truncate">
                      {team}
                    </span>
                  </div>
                  <div className="flex justify-between mb-2">
                    {[
                      { v: driver.wins, l: "Wins", accent: false },
                      { v: driver.points, l: "Pts", accent: false },
                      { v: `P${driver.position}`, l: "Pos", accent: true },
                    ].map((s) => (
                      <div key={s.l} className="text-center">
                        <div
                          className={`font-extrabold text-[15px] tabular-nums ${
                            s.accent ? "text-[#FFAE6A]" : ""
                          }`}
                        >
                          {s.v}
                        </div>
                        <div className="font-semibold text-[8px] tracking-[0.1em] uppercase text-warm-500">
                          {s.l}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="h-1 bg-white/[0.06] rounded-[3px] overflow-hidden">
                    <div
                      className="h-full anim-bar"
                      style={{ width: `${barPct}%`, background: color.hex }}
                    />
                  </div>
                </div>
              </TiltCard>
            </StaggerItem>
          );
        })}
      </Stagger>

      <AnimatePresence>
        {selected && selectedColor && (
          <DriverModal
            key={selectedId}
            driver={selected}
            imgPath={selectedImgPath}
            flagSrc={selectedFlagSrc}
            color={selectedColor}
            onClose={() => setSelected(null)}
          />
        )}
      </AnimatePresence>
    </>
  );
}
