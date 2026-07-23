"use client";

import { useState } from "react";
import Image from "next/image";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { DriverStanding } from "@/lib/api";
import { getDriverImagePath, hasDriverImage } from "@/lib/driver-images";
import { getFlagPath } from "@/lib/flags";
import { getTeamColor } from "@/lib/team-colors";
import TiltCard from "@/components/tilt-card";
import FlagImg from "@/components/flag-img";
import { Stagger, StaggerItem } from "@/components/motion-primitives";
import DriverModal from "@/components/driver-modal";

interface DriversGridProps {
  drivers: DriverStanding[];
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
                className="apex-glass rounded-[18px] overflow-hidden p-5 min-h-[280px] block h-full cursor-pointer"
                strength={6}
                onClick={() => setSelected(driver)}
                ariaLabel={`View ${given} ${family}'s profile`}
              >
                {/* team accent */}
                <div
                  className="absolute top-0 left-0 right-0 h-[3px]"
                  style={{ background: color.hex }}
                />
                {/* big number watermark */}
                <div className="absolute right-[-6px] bottom-[-24px] font-[family-name:var(--font-headline)] font-extrabold text-[130px] leading-none text-white/[0.04] select-none pointer-events-none">
                  {num}
                </div>

                {/* cutout / placeholder */}
                <div className="absolute left-5 right-5 top-16 bottom-24 rounded-xl overflow-hidden flex items-end justify-center">
                  {imgPath ? (
                    <motion.div layoutId={photoLayoutId} className="absolute inset-0">
                      <Image
                        src={imgPath}
                        alt={`${given} ${family}`}
                        fill
                        sizes="(max-width: 640px) 90vw, 320px"
                        className="object-cover object-[50%_10%] drop-shadow-[0_10px_28px_rgba(0,0,0,0.7)]"
                        priority={idx < 4}
                      />
                    </motion.div>
                  ) : (
                    <div className="absolute inset-0 apex-hatch flex items-end justify-center pb-2">
                      <span className="font-semibold text-[8px] tracking-[0.1em] text-warm-500">
                        // CUTOUT
                      </span>
                    </div>
                  )}
                </div>

                {/* header */}
                <div className="relative flex items-center gap-2">
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
                <div className="relative mt-2">
                  <div className="font-medium text-xs text-warm-300">{given}</div>
                  <div className="font-[family-name:var(--font-headline)] font-extrabold text-[22px] leading-none">
                    {family}
                  </div>
                </div>

                {/* stats footer */}
                <div className="absolute left-5 right-5 bottom-5">
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
