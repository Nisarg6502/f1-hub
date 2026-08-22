import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getPitStops,
  getRaceLaps,
  getRaceReplay,
  getRaceResults,
  getRaceStints,
  getSeasonRaces,
} from "@/lib/api";
import { getRaceControl, getSessionKeyByDate } from "@/lib/openf1";
import { getTeamColor } from "@/lib/team-colors";
import TireStintsChart from "@/components/tire-stints-chart";
import PitStopsChart from "@/components/pit-stops-chart";
import LapPositionChart from "@/components/lap-position-chart";
import RaceControlPanel from "@/components/race-control-panel";
import RaceReplayView from "@/components/race-replay";
import PitwallModules from "@/components/pitwall-modules";
import StrategyCommentaryCard from "@/components/strategy-commentary-card";

export const metadata: Metadata = {
  title: "Pitwall | APEX",
  description:
    "Strategy view for a single Grand Prix: tyre stints, pit stops, lap positions and pace, session by session.",
};

interface PageProps {
  params: Promise<{
    season: string;
    round: string;
  }>;
  // Populated by a `[RC L66]`-style recap citation linking to
  // `?module=race-replay&lap=66`, or typed in directly. Both are optional —
  // this page must render the same without them.
  searchParams: Promise<{
    module?: string;
    lap?: string;
  }>;
}

/** Shared "we don't have this yet" panel.
 *
 * A module with no data is an expected state, not a failure: stints wait on
 * the local FastF1 sync and pit stops wait on the race actually being run.
 * Both say so plainly rather than surfacing an error.
 */
function ModuleEmptyState({
  title,
  children,
  season,
  round,
}: {
  title: string;
  children: React.ReactNode;
  season: string;
  round: string;
}) {
  return (
    <div className="apex-glass-soft rounded-2xl p-12 flex flex-col items-center justify-center text-center min-h-[500px]">
      <div className="w-14 h-14 rounded-tile bg-[rgba(255,90,31,0.1)] border border-[rgba(255,90,31,0.25)] flex items-center justify-center mb-5">
        <span className="material-symbols-outlined text-flame text-2xl">
          hourglass_empty
        </span>
      </div>
      <h3 className="font-[family-name:var(--font-headline)] font-bold text-2xl mb-2">
        {title}
      </h3>
      <p className="font-medium text-sm text-warm-400 max-w-md mx-auto">
        {children}
      </p>
      <div className="mt-7 flex gap-3">
        <Link
          href={`/schedule/${season}/${round}`}
          className="font-bold text-xs uppercase tracking-[0.1em] px-6 py-2.5 rounded-control apex-glass-soft hover:border-[rgba(255,138,61,0.5)] transition-colors"
        >
          Race results
        </Link>
        <Link
          href="/schedule"
          className="font-bold text-xs uppercase tracking-[0.1em] px-6 py-2.5 rounded-control bg-[rgba(255,90,31,0.16)] text-primary hover:bg-[rgba(255,90,31,0.24)] transition-colors"
        >
          View schedule
        </Link>
      </div>
    </div>
  );
}

export default async function PitwallPage({ params, searchParams }: PageProps) {
  const { season, round } = await params;
  const { module: moduleParam, lap: lapParam } = await searchParams;
  const seasonYear = Number(season);
  const roundNumber = Number(round);

  if (!Number.isFinite(seasonYear) || !Number.isFinite(roundNumber)) {
    notFound();
  }

  // None of these depend on each other's result, so fire them together rather
  // than serially. Stints come from the backend's FastF1-backed cache — they
  // were re-sourced from OpenF1 to FastF1 back when OpenF1 returned 401 for the
  // whole current season (that paywall has since lifted, verified 2026-07-29).
  // Pit stops come from Ergast, which unlike FastF1 answers from Cloud Run.
  const [racesRes, resultsRes, stintsRes, pitStopsRes, lapsRes, replayRes] = await Promise.all([
    getSeasonRaces(seasonYear),
    getRaceResults(seasonYear, roundNumber),
    getRaceStints(seasonYear, roundNumber).catch(() => null),
    getPitStops(seasonYear, roundNumber).catch(() => null),
    getRaceLaps(seasonYear, roundNumber).catch(() => null),
    getRaceReplay(seasonYear, roundNumber).catch(() => null),
  ]);
  const race = (racesRes.races ?? []).find((r) => r.round === String(roundNumber));

  if (!race || !race.date) {
    notFound();
  }

  // Race control goes straight to OpenF1 (unlike the calls above, which go
  // through the backend), so it needs its own session_key lookup by date.
  // OpenF1 used to return 401 for the entire current season; as of 2026-07-29
  // it serves current-season race control fine, so this normally populates.
  // `getSessionKeyByDate`/`getRaceControl` still fail soft to `null`/`[]` on
  // any error, so this never throws; an empty result here just means the
  // session has no messages yet, handled below like every other module's
  // empty state.
  const raceControlMessages = await getSessionKeyByDate(seasonYear, race.date, "Race")
    .then((sessionKey) => (sessionKey ? getRaceControl(sessionKey) : []))
    .catch(() => []);

  const results = resultsRes.results ?? [];

  const drivers = results
    .filter((r) => r.Driver && r.number)
    .map((r) => ({
      driverId: r.Driver!.driverId ?? "",
      number: r.number ?? "",
      code: r.Driver!.code ?? "",
      givenName: r.Driver!.givenName ?? "",
      familyName: r.Driver!.familyName ?? "",
      teamColor: getTeamColor(r.Constructor?.name).hex,
    }));

  const stints = stintsRes?.stints ?? [];
  const stops = pitStopsRes?.stops ?? [];
  const laps = lapsRes?.laps ?? [];

  const lapNumber = lapParam ? Number(lapParam) : undefined;
  const initialLap = Number.isFinite(lapNumber) ? lapNumber : undefined;

  return (
    <div className="px-6 md:px-10 pt-8 pb-16">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-8 gap-6">
        <div>
          <span className="font-bold text-xs tracking-[0.18em] uppercase text-flame">
            Telemetry lab
          </span>
          <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-4xl md:text-[56px] tracking-[-1.5px] leading-none mt-2">
            Pitwall <span className="apex-flame-text">Strategy</span>
          </h1>
          <p className="font-semibold text-[13px] text-warm-400 mt-2">
            {race.raceName} · Round {race.round}
          </p>
        </div>
        <Link
          href={`/schedule/${season}/${round}`}
          className="font-bold text-xs px-5 h-[46px] rounded-control apex-glass-soft flex items-center justify-center hover:border-[rgba(255,138,61,0.5)] transition-[border-color,transform] duration-150 active:scale-95"
        >
          ← Back to race
        </Link>
      </div>

      <PitwallModules
        // A `?lap=` link implies the reader wants the replay open even if
        // `?module=` wasn't set explicitly (typed URLs, older citation links).
        initialModuleId={moduleParam ?? (initialLap !== undefined ? "race-replay" : undefined)}
        modules={[
          {
            id: "stints",
            label: "Tire Stints",
            panel: stints.length ? (
              <TireStintsChart drivers={drivers} initialStints={stints} />
            ) : (
              <ModuleEmptyState
                title="Stint data not available yet"
                season={season}
                round={round}
              >
                Tyre strategy for {race.raceName} hasn&apos;t been processed
                yet. Stints are derived from timing data once the race has
                finished and its data has been archived — check back after the
                weekend.
              </ModuleEmptyState>
            ),
          },
          {
            id: "pit-stops",
            label: "Pit Stops",
            panel: stops.length ? (
              <PitStopsChart drivers={drivers} stops={stops} />
            ) : (
              <ModuleEmptyState
                title="Pit-stop data not available yet"
                season={season}
                round={round}
              >
                No pit stops have been published for {race.raceName}. Stop
                times appear alongside the official classification once the
                race has run — check back after the weekend.
              </ModuleEmptyState>
            ),
          },
          {
            id: "strategy-commentary",
            label: "Strategy Commentary",
            // StrategyCommentaryCard self-fetches/streams (like SessionRecapCard)
            // and renders null once it's clear there's nothing to show, but that
            // reads as a blank panel below the sidebar for a module a reader might
            // click before the backing data exists — an explicit empty state,
            // gated on the same stints/laps data this endpoint requires, reads
            // better here than a silently blank card.
            panel: stints.length && laps.length ? (
              <StrategyCommentaryCard year={seasonYear} round={roundNumber} />
            ) : (
              <ModuleEmptyState
                title="Strategy commentary not available yet"
                season={season}
                round={round}
              >
                Strategy commentary for {race.raceName} needs tyre stint and
                lap-position data that hasn&apos;t been processed yet — check
                back after the weekend.
              </ModuleEmptyState>
            ),
          },
          {
            id: "laps",
            label: "Lap Telemetry",
            panel: laps.length ? (
              <LapPositionChart drivers={drivers} initialLaps={laps} />
            ) : (
              <ModuleEmptyState
                title="Lap data not available yet"
                season={season}
                round={round}
              >
                Track position for {race.raceName} hasn&apos;t been processed
                yet. Positions are derived from timing data once the race has
                finished and its data has been archived — check back after
                the weekend.
              </ModuleEmptyState>
            ),
          },
          {
            id: "race-replay",
            label: "Race Replay",
            // RaceReplayView renders its own "not available yet" state for an
            // unsynced round, so — unlike the other modules — this doesn't
            // need a ModuleEmptyState wrapper here.
            panel: (
              <RaceReplayView
                replay={
                  replayRes ?? {
                    year: seasonYear,
                    round: roundNumber,
                    total_laps: 0,
                    drivers: {},
                    laps: [],
                    synced: false,
                  }
                }
                initialLap={initialLap}
              />
            ),
          },
          {
            id: "race-control",
            label: "Race Control",
            panel: raceControlMessages.length ? (
              <RaceControlPanel drivers={drivers} messages={raceControlMessages} />
            ) : (
              <ModuleEmptyState
                title="Race control data not available yet"
                season={season}
                round={round}
              >
                No flag, safety-car, or investigation messages have been
                published for {race.raceName} yet. Race control appears once
                the session has run and its timing feed has been archived —
                check back after the weekend.
              </ModuleEmptyState>
            ),
          },
        ]}
      />
    </div>
  );
}
