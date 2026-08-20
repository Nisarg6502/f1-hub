"use client";

import { useState } from "react";
import Image from "next/image";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react";
import type { DriverStanding } from "@/lib/api";
import { getDriverImagePath, hasDriverImage } from "@/lib/driver-images";
import { driverPortraitFrameStyle, driverPortraitSizes } from "@/lib/driver-portrait";
import { getFlagPath } from "@/lib/flags";
import { getTeamColor } from "@/lib/team-colors";
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

                {/* header */}
                <div className="relative z-20 flex items-center gap-2">
                  <span className="w-[26px] h-[18px] rounded flex items-center justify-center overflow-hidden bg-[rgba(245,235,222,0.08)]">
                    <FlagImg
                      src={flagSrc}
                      alt={driver.Driver.nationality ?? ""}
                      width={26}
                      height={18}
                      className="object-cover w-full h-full"
                    />
                  </span>
                  <span className="font-semibold text-[10px] tracking-[0.1em] uppercase text-warm-400 truncate">
                    {team}
                  </span>
                </div>
                <div className="relative z-20 mt-2">
                  <div className="font-medium text-xs text-warm-300">{given}</div>
                  <div className="font-[family-name:var(--font-headline)] font-extrabold text-[22px] leading-none">
                    {family}
                  </div>
                </div>

                {/* stats footer */}
                <div className="absolute left-5 right-5 bottom-5 z-20">
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
