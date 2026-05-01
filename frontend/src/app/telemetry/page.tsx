"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  getActiveSeasonYear,
  getLiveTimingData,
  getSeasonRaces,
  type LiveTimingLine,
  type Race,
} from "@/lib/api";
import {
  buildSeasonSessionTimeline,
  getCurrentLiveSession,
  getNextSession,
} from "@/lib/sessions";

function getTyreDotColor(compound?: string) {
  const normalized = (compound ?? "").toUpperCase();
  if (normalized === "SOFT") return "bg-red-500";
  if (normalized === "MEDIUM") return "bg-yellow-400";
  if (normalized === "HARD") return "bg-white";
  if (normalized === "INTERMEDIATE") return "bg-green-500";
  if (normalized === "WET") return "bg-blue-500";
  return "bg-neutral-500";
}

function getSectorColor(
  sector: NonNullable<LiveTimingLine["Sectors"]>[number] | undefined
) {
  if (!sector) return "bg-neutral-700";
  if (sector.OverallFastest) return "bg-secondary-container";
  if (sector.PersonalFastest) return "bg-primary-container";
  return "bg-tertiary-container/70";
}

export default function TelemetryPage() {
  const [races, setRaces] = useState<Race[]>([]);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [timingRows, setTimingRows] = useState<LiveTimingLine[]>([]);
  const [isLoadingTiming, setIsLoadingTiming] = useState(false);
  const [timingError, setTimingError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    const loadRaces = async () => {
      try {
        const seasonYear = getActiveSeasonYear();
        const response = await getSeasonRaces(seasonYear);
        if (isMounted) {
          setRaces(response.races ?? []);
        }
      } catch {
        if (isMounted) {
          setRaces([]);
        }
      }
    };

    loadRaces();
    const refreshRacesId = setInterval(loadRaces, 60_000);
    const clockId = setInterval(() => setNowMs(Date.now()), 1_000);

    return () => {
      isMounted = false;
      clearInterval(refreshRacesId);
      clearInterval(clockId);
    };
  }, []);

  const sessions = useMemo(() => buildSeasonSessionTimeline(races), [races]);
  const liveSession = useMemo(
    () => getCurrentLiveSession(sessions, nowMs),
    [sessions, nowMs]
  );
  const nextSession = useMemo(() => getNextSession(sessions, nowMs), [sessions, nowMs]);

  useEffect(() => {
    if (!liveSession) {
      setTimingRows([]);
      setTimingError(null);
      setIsLoadingTiming(false);
      return;
    }

    let isMounted = true;

    const fetchTiming = async () => {
      if (!isMounted) return;
      setIsLoadingTiming(true);
      try {
        const response = await getLiveTimingData();
        if (!isMounted) return;
        const sortedRows = (response.lines ?? []).slice().sort((a, b) => {
          const aPos = Number.parseInt(a.position ?? "999", 10);
          const bPos = Number.parseInt(b.position ?? "999", 10);
          return aPos - bPos;
        });
        setTimingRows(sortedRows);
        setTimingError(null);
      } catch (error) {
        if (!isMounted) return;
        setTimingError(error instanceof Error ? error.message : "Failed to load live timing");
      } finally {
        if (isMounted) {
          setIsLoadingTiming(false);
        }
      }
    };

    fetchTiming();
    const intervalId = setInterval(fetchTiming, 10_000);
    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [liveSession]);

  return (
    <div className="max-w-[1600px] mx-auto px-6 space-y-6">
      <header className="glass-card p-6 flex flex-wrap items-center justify-between gap-4 border-t-2 border-t-primary-container">
        <div>
          <p className="font-[family-name:var(--font-label)] text-[10px] tracking-[0.24em] uppercase text-on-surface-variant">
            Kinetic Velocity
          </p>
          <h1 className="text-3xl md:text-4xl font-black italic skew-x-[-12deg] tracking-tighter font-[family-name:var(--font-headline)]">
            Live Timing
          </h1>
          <p className="mt-2 text-xs uppercase tracking-[0.2em] text-on-surface-variant font-[family-name:var(--font-label)]">
            {liveSession
              ? `${liveSession.raceName} · ${liveSession.sessionLabel}`
              : "No session currently live"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {liveSession ? (
            <span className="inline-flex items-center gap-2 bg-tertiary-container/20 border border-tertiary-container/40 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.22em] text-tertiary-container">
              <span className="h-2 w-2 rounded-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.9)] animate-pulse" />
              Live
            </span>
          ) : (
            <span className="inline-flex items-center gap-2 bg-surface-container-low border border-outline-variant/40 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.22em] text-on-surface-variant">
              Standby
            </span>
          )}
          <Link
            href="/schedule"
            className="px-4 py-2 text-[10px] uppercase tracking-[0.2em] border border-outline-variant/40 text-on-surface-variant hover:text-on-surface hover:border-primary-container/40"
          >
            Schedule
          </Link>
        </div>
      </header>

      {!liveSession && (
        <section className="bg-surface-container-low border border-outline-variant/30 p-6">
          <p className="text-sm text-on-surface-variant">
            Live timing API polling is paused because no session is currently active.
          </p>
          {nextSession && (
            <p className="mt-3 text-xs uppercase tracking-[0.2em] text-primary-container font-[family-name:var(--font-label)]">
              Next Session: {nextSession.raceName} · {nextSession.sessionLabel} ·{" "}
              {new Date(nextSession.startTimeMs).toLocaleString("en-US", {
                month: "short",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
                timeZone: "UTC",
              })}{" "}
              UTC
            </p>
          )}
        </section>
      )}

      {liveSession && (
        <section className="bg-surface-container-low border border-outline-variant/30 overflow-hidden">
          <div className="grid grid-cols-[42px_44px_90px_1fr_1fr_110px_140px_90px_74px] gap-2 px-4 py-3 bg-surface-container text-[10px] tracking-[0.2em] uppercase font-[family-name:var(--font-label)] text-on-surface-variant">
            <div className="text-center">Pos</div>
            <div className="text-center">No</div>
            <div>Driver</div>
            <div className="text-right">Gap</div>
            <div className="text-right">Interval</div>
            <div className="text-right">Last Lap</div>
            <div className="text-center">Sectors</div>
            <div className="text-center">Tyre</div>
            <div className="text-center">Status</div>
          </div>

          <div className="max-h-[70vh] overflow-y-auto p-2 space-y-[2px]">
            {isLoadingTiming && timingRows.length === 0 && (
              <div className="p-4 text-sm text-on-surface-variant">Loading live timing feed...</div>
            )}
            {timingError && (
              <div className="p-4 text-sm text-red-400">
                {timingError}
              </div>
            )}
            {!isLoadingTiming && !timingError && timingRows.length === 0 && (
              <div className="p-4 text-sm text-on-surface-variant">No timing rows available yet.</div>
            )}
            {timingRows.map((line, index) => (
              <div
                key={`${line.racingNumber ?? index}-${line.position ?? index}`}
                className="grid grid-cols-[42px_44px_90px_1fr_1fr_110px_140px_90px_74px] gap-2 px-3 py-2 bg-surface-container-high items-center"
              >
                <div className="text-center font-bold italic font-[family-name:var(--font-headline)]">
                  {line.position ?? "—"}
                </div>
                <div className="text-center text-on-surface-variant">
                  {line.racingNumber ?? line.driver?.RacingNumber ?? "—"}
                </div>
                <div
                  className="font-bold uppercase"
                  style={{
                    color: line.driver?.TeamColour
                      ? `#${line.driver.TeamColour}`
                      : undefined,
                  }}
                >
                  {line.driver?.Tla ?? line.driver?.BroadcastName ?? "—"}
                </div>
                <div className="text-right text-on-surface-variant tabular-nums">
                  {line.gapToLeader || line.timeDiffToFastest || "LEADER"}
                </div>
                <div className="text-right text-on-surface-variant tabular-nums">
                  {line.intervalToPositionAhead || line.timeDiffToPositionAhead || "—"}
                </div>
                <div className="text-right tabular-nums text-on-surface">
                  {line.lastLapTime || "—"}
                </div>
                <div className="flex justify-center gap-1">
                  {[0, 1, 2].map((sectorIdx) => (
                    <span
                      key={sectorIdx}
                      className={`h-2 w-9 ${getSectorColor(line.Sectors?.[sectorIdx])}`}
                    />
                  ))}
                </div>
                <div className="flex items-center justify-center gap-2 text-xs">
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${getTyreDotColor(line.compound)}`}
                  />
                  <span>{line.tyreAge ?? "—"}</span>
                </div>
                <div className="text-center text-[11px]">
                  {line.inPit ? "PIT" : line.drs === "active" ? "DRS" : "RUN"}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

