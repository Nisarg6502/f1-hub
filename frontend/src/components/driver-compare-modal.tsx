"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { motion, useReducedMotion } from "motion/react";
import type { DriverStanding } from "@/lib/api";
import { getSeasonResultsByRound, type SeasonRoundResults } from "@/lib/api";
import { buildHeadToHead } from "@/lib/driver-compare";
import { getDriverImagePath, hasDriverImage } from "@/lib/driver-images";
import { driverPortraitFrameStyle, driverPortraitSizes } from "@/lib/driver-portrait";
import { getFlagPath } from "@/lib/flags";
import { getTeamColor } from "@/lib/team-colors";
import { useModalDialog } from "@/lib/use-modal-dialog";
import DriverComparisonRecap from "./driver-comparison-recap";
import FlagImg from "./flag-img";
import TeamCar from "./team-car";

interface DriverCompareModalProps {
  driverA: DriverStanding;
  driverB: DriverStanding;
  seasonYear: number;
  onClose: () => void;
}

function driverHalf(driver: DriverStanding) {
  const given = driver.Driver.givenName ?? "";
  const family = driver.Driver.familyName ?? "";
  const team = driver.Constructors?.[0]?.name ?? "—";
  const color = getTeamColor(team);
  const imgPath = hasDriverImage(given, family) ? getDriverImagePath(given, family) : null;
  const flagSrc = getFlagPath(driver.Driver.nationality);
  return { given, family, team, color, imgPath, flagSrc };
}

function formatGapMs(ms: number): string {
  const sign = ms < 0 ? "-" : "+";
  return `${sign}${(Math.abs(ms) / 1000).toFixed(3)}s`;
}

export default function DriverCompareModal({
  driverA,
  driverB,
  seasonYear,
  onClose,
}: DriverCompareModalProps) {
  const reduce = useReducedMotion();
  const [rounds, setRounds] = useState<SeasonRoundResults[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const a = driverHalf(driverA);
  const b = driverHalf(driverB);
  const driverAId = driverA.Driver.driverId;
  const driverBId = driverB.Driver.driverId;

  useEffect(() => {
    // The parent only ever mounts one of these at a time per compare click
    // (see compare-drivers-panel.tsx), so this runs once with loading/failed
    // already at their initializer values above -- no need to reset them here.
    let cancelled = false;
    getSeasonResultsByRound(seasonYear)
      .then((res) => {
        if (!cancelled) setRounds(res);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [seasonYear]);

  // See `use-modal-dialog.ts`: Escape + scroll lock as before, plus the dialog
  // semantics, initial focus and Tab containment this modal never had.
  const dialogRef = useModalDialog<HTMLDivElement>({ onClose });

  const summary = useMemo(() => {
    if (!rounds || !driverAId || !driverBId) return null;
    return buildHeadToHead(rounds, driverAId, driverBId);
  }, [rounds, driverAId, driverBId]);

  return createPortal(
    <motion.div
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[80] flex items-center justify-center p-5 md:p-10 bg-[rgba(6,5,4,0.65)] backdrop-blur-[8px]"
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${a.given} ${a.family} compared with ${b.given} ${b.family}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.92, y: 24 }}
        animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 12 }}
        transition={
          reduce ? { duration: 0.15 } : { type: "spring", stiffness: 320, damping: 30 }
        }
        className="relative w-[760px] max-w-full max-h-full overflow-y-auto rounded-panel apex-glass-strong apex-sheen"
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-5 right-5 z-10 w-[34px] h-[34px] rounded-control bg-[rgba(16,14,11,0.5)] flex items-center justify-center text-warm-200 text-lg hover:bg-[rgba(16,14,11,0.7)] transition-[background-color,transform] duration-150 active:scale-90"
        >
          ×
        </button>

        {/* Header — two driver halves side by side */}
        <div className="grid grid-cols-2">
          {[{ half: a, driver: driverA }, { half: b, driver: driverB }].map(
            ({ half, driver }, idx) => (
              <div
                key={driver.Driver.driverId ?? idx}
                className="relative h-[180px] overflow-hidden"
                style={{
                  background: `linear-gradient(180deg, ${half.color.hex}26, transparent)`,
                }}
              >
                {half.imgPath && (
                  <div style={driverPortraitFrameStyle("bust")}>
                    <Image
                      src={half.imgPath}
                      alt={`${half.given} ${half.family}`}
                      fill
                      sizes={driverPortraitSizes(180, "bust")}
                      className="object-cover drop-shadow-[0_20px_40px_rgba(0,0,0,0.7)]"
                      priority
                    />
                  </div>
                )}
                {/* The name sits over the driver's chest now that the portrait
                    is framed rather than letterboxed; this keeps it legible. */}
                <div className="absolute inset-x-0 bottom-0 h-[86px] bg-gradient-to-t from-[rgba(10,8,6,0.88)] via-[rgba(10,8,6,0.45)] to-transparent pointer-events-none" />
                <div
                  className="absolute top-0 left-0 right-0 h-[4px]"
                  style={{ background: half.color.hex, boxShadow: `0 0 16px ${half.color.glow}` }}
                />
                <div className="absolute bottom-3 left-4 right-4">
                  <div className="flex items-center gap-2 mb-1">
                    {half.flagSrc && (
                      <span className="w-[22px] h-[15px] rounded overflow-hidden flex-none">
                        <FlagImg
                          src={half.flagSrc}
                          alt={driver.Driver.nationality ?? ""}
                          width={22}
                          height={15}
                          className="object-cover w-full h-full"
                        />
                      </span>
                    )}
                    <span className="font-bold text-[9px] tracking-[0.12em] uppercase text-flame">
                      {half.team}
                    </span>
                  </div>
                  <div className="font-[family-name:var(--font-headline)] font-extrabold text-xl leading-none">
                    {half.given} {half.family}
                  </div>
                </div>
              </div>
            )
          )}
        </div>

        {/* Nose to nose.

            This is the one surface where two cars facing each other is a
            truthful picture rather than a decorative one: the drivers being
            compared can be on different teams, so the two liveries meeting in
            the middle *is* the comparison. (The teammate panel deliberately
            does the opposite — same chassis, so one car behind both.)

            Each half masks its car away from the centre, leaving a clear strip
            for the divider, so the two noses approach each other without
            colliding. The colour wash comes in from the outer edges for the
            same reason: it frames the meeting point instead of filling it. */}
        <div
          className="relative h-[84px] overflow-hidden border-y border-white/[0.07]"
          style={{
            background: `linear-gradient(90deg, ${a.color.hex}1c, transparent 40%, transparent 60%, ${b.color.hex}1c)`,
          }}
        >
          {/* Insets, not widths, and deliberately narrow ones. These boxes are
              ~2.7:1 against a car that is 4.54:1, which is what makes `cover`
              keep only the leading ~60% — a half-width box would show two
              entire cars and no noses at all. The inner edges stop at 46%/54%
              so the two fronts approach the divider without touching it. */}
          <TeamCar
            team={a.team}
            variant="nose-right"
            sizes="(min-width: 640px) 240px, 32vw"
            className="absolute inset-y-2 left-[16%] right-[54%]"
          />
          <TeamCar
            team={b.team}
            variant="nose-left"
            sizes="(min-width: 640px) 240px, 32vw"
            className="absolute inset-y-2 left-[54%] right-[16%]"
          />
          <span
            aria-hidden
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 font-[family-name:var(--font-headline)] font-extrabold text-[11px] tracking-[0.16em] text-warm-400"
          >
            VS
          </span>
        </div>

        <div className="p-[30px] pt-6">
          <p className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500 mb-3">
            {seasonYear} Season
          </p>

          {/* Standings stats -- already known, no fetch needed */}
          <div className="grid grid-cols-2 gap-3 mb-6">
            {[
              { l: "Position", va: `P${driverA.position}`, vb: `P${driverB.position}` },
              { l: "Points", va: driverA.points, vb: driverB.points },
              { l: "Wins", va: driverA.wins, vb: driverB.wins },
            ].map((row) => (
              <div key={row.l} className="col-span-2 grid grid-cols-2 gap-3">
                {[row.va, row.vb].map((v, i) => (
                  <div
                    key={i}
                    className="bg-[rgba(245,235,222,0.05)] rounded-xl px-3.5 py-3 flex items-center justify-between"
                  >
                    <span className="font-semibold text-[9px] tracking-[0.1em] uppercase text-warm-500">
                      {row.l}
                    </span>
                    <span className="font-extrabold text-lg tabular-nums">{v}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500 mb-3">
            Head-to-head
          </div>

          {loading ? (
            <div className="grid grid-cols-2 gap-3 animate-pulse">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="h-[80px] rounded-xl bg-[rgba(245,235,222,0.05)]" />
              ))}
            </div>
          ) : failed || !summary ? (
            <p className="text-sm text-warm-400 font-medium">
              Head-to-head data unavailable right now.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="bg-[rgba(245,235,222,0.05)] rounded-xl px-4 py-3.5">
                <div className="font-semibold text-[9px] tracking-[0.1em] uppercase text-warm-500 mb-2">
                  Race finish, {summary.raceCommonCount} shared round
                  {summary.raceCommonCount === 1 ? "" : "s"}
                </div>
                {summary.raceCommonCount === 0 ? (
                  <p className="text-xs text-warm-400 font-medium">
                    No rounds where both drivers were classified yet.
                  </p>
                ) : (
                  <div className="flex items-center gap-3">
                    <span className="font-extrabold text-2xl tabular-nums text-primary">
                      {summary.raceAheadA}
                    </span>
                    <span className="text-xs text-warm-500 font-medium">
                      {a.family} finished ahead of {b.family}
                    </span>
                    <span className="text-warm-600 mx-1">·</span>
                    <span className="font-extrabold text-2xl tabular-nums text-primary">
                      {summary.raceAheadB}
                    </span>
                    <span className="text-xs text-warm-500 font-medium">
                      {b.family} finished ahead of {a.family}
                    </span>
                  </div>
                )}
              </div>

              <div className="bg-[rgba(245,235,222,0.05)] rounded-xl px-4 py-3.5">
                <div className="font-semibold text-[9px] tracking-[0.1em] uppercase text-warm-500 mb-2">
                  Qualifying pace, {summary.qualiCommonCount} shared round
                  {summary.qualiCommonCount === 1 ? "" : "s"}
                </div>
                {summary.qualiCommonCount === 0 ? (
                  <p className="text-xs text-warm-400 font-medium">
                    No rounds where both drivers set a comparable time yet.
                  </p>
                ) : (
                  <>
                    <div className="flex items-center gap-3 mb-2">
                      <span className="font-extrabold text-2xl tabular-nums text-primary">
                        {summary.qualiAheadA}
                      </span>
                      <span className="text-xs text-warm-500 font-medium">
                        {a.family} faster
                      </span>
                      <span className="text-warm-600 mx-1">·</span>
                      <span className="font-extrabold text-2xl tabular-nums text-primary">
                        {summary.qualiAheadB}
                      </span>
                      <span className="text-xs text-warm-500 font-medium">
                        {b.family} faster
                      </span>
                    </div>
                    {summary.avgQualiGapMs !== null && (
                      <p className="text-xs text-warm-400 font-medium">
                        Average gap: {a.family} {formatGapMs(summary.avgQualiGapMs)} vs{" "}
                        {b.family}
                      </p>
                    )}
                  </>
                )}
              </div>

              <DriverComparisonRecap
                year={seasonYear}
                driver1={driverAId ?? ""}
                driver2={driverBId ?? ""}
              />
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>,
    document.body
  );
}
