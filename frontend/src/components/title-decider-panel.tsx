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

  /* Both championships state the same rounds-remaining, so it is hoisted into
     the band's own header rather than repeated in each column. */
  const roundsSummary = driverResult ? roundsLabel(driverResult) : null;

  return (
    // A full-width band above the table rather than the third card down a
    // sidebar. It reports on both championships and it answers the question
    // most readers open this page with -- "is this still a contest?" -- so it
    // sits where that answer is read first, and stays visible on the
    // Constructors tab, which previously could not see it at all.
    <section
      className="apex-glass apex-sheen rounded-card p-5 md:p-6 mb-7 overflow-hidden"
      aria-label="Title decider"
    >
      <div className="relative flex flex-col lg:flex-row lg:items-start gap-5 lg:gap-9">
        <div className="lg:w-[196px] flex-none">
          <span className="font-bold text-xs tracking-[0.12em] uppercase text-flame">
            Title decider
          </span>
          {roundsSummary && !seasonOver && (
            <p className="font-medium text-[11px] text-warm-400 mt-1.5 leading-relaxed">
              {roundsSummary} left to run
            </p>
          )}
        </div>

        {loading ? (
          <div className="flex-1 grid md:grid-cols-2 gap-5 lg:gap-9 animate-pulse">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="h-[64px] rounded-xl bg-[rgba(245,235,222,0.05)]" />
            ))}
          </div>
        ) : failed || !races || !driverResult ? (
          <p className="flex-1 text-xs text-warm-400 font-medium">
            Title-decider math unavailable right now.
          </p>
        ) : seasonOver ? (
          <p className="flex-1 text-xs text-warm-400 font-medium">
            Season complete — no rounds remain to decide the title.
          </p>
        ) : (
          <div className="flex-1 min-w-0 grid md:grid-cols-2 gap-5 lg:gap-9">
            <TitleDeciderRow label="Drivers" result={driverResult} />
            {constructorResult && (
              <TitleDeciderRow label="Constructors" result={constructorResult} />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** `3 races + 1 sprint`. Empty when nothing is left. */
function roundsLabel(result: TitleDeciderResult): string {
  const { remainingRaces, remainingSprints } = result;
  return [
    remainingRaces > 0 ? `${remainingRaces} race${remainingRaces === 1 ? "" : "s"}` : null,
    remainingSprints > 0
      ? `${remainingSprints} sprint${remainingSprints === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(" + ");
}

function TitleDeciderRow({
  label,
  result,
}: {
  label: string;
  result: TitleDeciderResult;
}) {
  const { leader, runnerUp, gap, maxRemainingPoints } = result;
  const rounds = roundsLabel(result);

  return (
    <div className="min-w-0">
      <div className="flex justify-between gap-3 mb-[7px]">
        <span className="font-semibold text-[11px] tracking-[0.04em] uppercase text-warm-400 truncate">
          {label}
        </span>
        <span className="font-bold text-[11px] tabular-nums text-warm-300 whitespace-nowrap">
          {gap} pt{gap === 1 ? "" : "s"} clear
        </span>
      </div>
      <div className="text-[13px] font-bold text-warm-100 truncate">{leader.name}</div>
      {result.clinched ? (
        <p className="mt-1 text-xs font-medium text-primary">
          Title mathematically clinched — {runnerUp.name} cannot close a {gap}-point
          gap over the {maxRemainingPoints} points left in play
          {rounds ? ` across ${rounds}` : ""}.
        </p>
      ) : (
        <p className="mt-1 text-xs font-medium text-warm-400">
          Still open — {maxRemainingPoints} points still available
          {rounds ? ` across ${rounds}` : ""}; {leader.name} needs{" "}
          {result.pointsToClinch} more (or a {runnerUp.name} slip) to clinch.
        </p>
      )}
    </div>
  );
}
