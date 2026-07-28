"use client";

import { useEffect, useState } from "react";
import type { DriverStanding, ConstructorStanding, Race } from "@/lib/api";
import { getSeasonRaces } from "@/lib/api";
import {
  computeTitleDecider,
  type StandingEntry,
  type TitleDeciderResult,
} from "@/lib/championship-math";

interface TitleDeciderPanelProps {
  drivers: DriverStanding[];
  constructors: ConstructorStanding[];
  year: number;
}

function driverName(d: DriverStanding): string {
  return `${d.Driver.givenName ?? ""} ${d.Driver.familyName ?? ""}`.trim() || "—";
}

function toStandingEntries(
  drivers: DriverStanding[]
): StandingEntry[] {
  return drivers.map((d) => ({ name: driverName(d), points: Number(d.points) || 0 }));
}

function toConstructorEntries(
  constructors: ConstructorStanding[]
): StandingEntry[] {
  return constructors.map((c) => ({
    name: c.Constructor.name ?? "—",
    points: Number(c.points) || 0,
  }));
}

export default function TitleDeciderPanel({
  drivers,
  constructors,
  year,
}: TitleDeciderPanelProps) {
  const [races, setRaces] = useState<Race[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSeasonRaces(year)
      .then((res) => {
        if (!cancelled) setRaces(res.races ?? []);
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
  }, [year]);

  if (drivers.length < 2) return null;

  const driverResult = races
    ? computeTitleDecider(toStandingEntries(drivers), races, "driver")
    : null;
  const constructorResult =
    races && constructors.length >= 2
      ? computeTitleDecider(toConstructorEntries(constructors), races, "constructor")
      : null;

  const seasonOver =
    driverResult !== null &&
    driverResult.remainingRaces === 0 &&
    driverResult.remainingSprints === 0;

  return (
    <div className="apex-glass apex-sheen rounded-[20px] p-6 overflow-hidden">
      <span className="font-bold text-xs tracking-[0.12em] uppercase text-[#FF7A3D]">
        Title decider
      </span>

      {loading ? (
        <div className="mt-5 flex flex-col gap-[18px] animate-pulse">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-[64px] rounded-xl bg-[rgba(245,235,222,0.05)]" />
          ))}
        </div>
      ) : failed || !races || !driverResult ? (
        <p className="mt-4 text-xs text-warm-400 font-medium">
          Title-decider math unavailable right now.
        </p>
      ) : seasonOver ? (
        <p className="mt-4 text-xs text-warm-400 font-medium">
          Season complete — no rounds remain to decide the title.
        </p>
      ) : (
        <div className="mt-5 flex flex-col gap-5">
          <TitleDeciderRow label="Drivers" result={driverResult} />
          {constructorResult && (
            <TitleDeciderRow label="Constructors" result={constructorResult} />
          )}
        </div>
      )}
    </div>
  );
}

function TitleDeciderRow({
  label,
  result,
}: {
  label: string;
  result: TitleDeciderResult;
}) {
  const { leader, runnerUp, gap, maxRemainingPoints, remainingRaces, remainingSprints } =
    result;
  const roundsLabel = [
    remainingRaces > 0 ? `${remainingRaces} race${remainingRaces === 1 ? "" : "s"}` : null,
    remainingSprints > 0
      ? `${remainingSprints} sprint${remainingSprints === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(" + ");

  return (
    <div>
      <div className="flex justify-between mb-[7px]">
        <span className="font-semibold text-[11px] tracking-[0.04em] uppercase text-warm-400 truncate">
          {label}
        </span>
        <span className="font-bold text-[11px] tabular-nums text-warm-300">
          {gap} pt{gap === 1 ? "" : "s"} clear
        </span>
      </div>
      <div className="text-[13px] font-bold text-[#f6f1ea] truncate">{leader.name}</div>
      {result.clinched ? (
        <p className="mt-1 text-xs font-medium text-[#FFAE6A]">
          Title mathematically clinched — {runnerUp.name} cannot close a {gap}-point
          gap over the {maxRemainingPoints} points left in play
          {roundsLabel ? ` across ${roundsLabel}` : ""}.
        </p>
      ) : (
        <p className="mt-1 text-xs font-medium text-warm-400">
          Still open — {maxRemainingPoints} points still available
          {roundsLabel ? ` across ${roundsLabel}` : ""}; {leader.name} needs{" "}
          {result.pointsToClinch} more (or a {runnerUp.name} slip) to clinch.
        </p>
      )}
    </div>
  );
}
