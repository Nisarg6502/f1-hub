"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  getActiveSeasonYear,
  getLiveTimingData,
  getSeasonRaces,
  LiveTimingError,
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
  return "bg-warm-500";
}

// F1 timing convention: purple = overall fastest, green = personal best.
function getSectorColor(
  sector: NonNullable<LiveTimingLine["Sectors"]>[number] | undefined
) {
  if (!sector) return "bg-[#2a231d]";
  if (sector.OverallFastest) return "bg-[#b14fff]";
  if (sector.PersonalFastest) return "bg-[#4ade80]";
  return "bg-flame/70";
}

export default function TelemetryPage() {
  const [races, setRaces] = useState<Race[]>([]);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [timingRows, setTimingRows] = useState<LiveTimingLine[]>([]);
  const [isLoadingTiming, setIsLoadingTiming] = useState(false);
  const [timingError, setTimingError] = useState<string | null>(null);
  const [isConfigError, setIsConfigError] = useState(false);

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
      setIsConfigError(false);
      setIsLoadingTiming(false);
      return;
    }

    // Whether live timing is configured is now the SERVER's answer, not a
    // value read from the bundle. The key it used to be inferred from moved
    // behind `/api/live-timing` (it was a `NEXT_PUBLIC_` value on a client
    // page, i.e. readable in View Source), so the pre-flight check that used
    // to sit here is gone and the proxy's 503 sets `isConfigError` in the
    // catch below instead. The "not configured" internals still never reach
    // the DOM — the page renders its own settled copy for that state.
    setIsConfigError(false);
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
        console.error("Live timing fetch failed:", error);
        if (error instanceof LiveTimingError && error.unconfigured) {
          // Permanent for this deployment: stop promising a retry that will
          // never produce anything.
          setTimingRows([]);
          setTimingError(null);
          setIsConfigError(true);
          return;
        }
        setTimingError("Couldn't reach the live timing feed. Retrying…");
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
    <div className="px-6 md:px-10 pt-10 pb-16 space-y-5">
      <header className="apex-glass apex-sheen rounded-card p-6 flex flex-wrap items-center justify-between gap-4">
        <div className="relative">
          <p className="font-bold text-[11px] tracking-[0.18em] uppercase text-flame">
            APEX Live
          </p>
          <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-3xl md:text-4xl tracking-[-1px] mt-1">
            Live Timing
          </h1>
          <p className="mt-2 font-semibold text-xs text-warm-400">
            {liveSession
              ? `${liveSession.raceName} · ${liveSession.sessionLabel}`
              : "No session currently live"}
          </p>
        </div>
        <div className="relative flex items-center gap-3">
          {liveSession ? (
            <span className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] bg-primary-container/16 text-primary">
              <span className="h-2 w-2 rounded-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.9)] animate-pulse" />
              Live
            </span>
          ) : (
            <span className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] bg-veil/6 text-warm-300">
              Standby
            </span>
          )}
          <Link
            href="/schedule"
            className="font-bold text-[11px] uppercase tracking-[0.1em] px-4 py-2 rounded-control apex-glass-soft hover:border-flame-bright/50 transition-[border-color,transform] duration-150 active:scale-95"
          >
            Schedule
          </Link>
        </div>
      </header>

      {!liveSession && (
        <section className="apex-glass-soft rounded-2xl p-6">
          <p className="font-medium text-sm text-warm-300">
            Live timing polling is paused because no session is currently active.
          </p>
          {nextSession && (
            <p className="mt-3 font-semibold text-xs uppercase tracking-[0.12em] text-primary">
              Next session: {nextSession.raceName} · {nextSession.sessionLabel} ·{" "}
              {new Date(nextSession.startTimeMs).toLocaleString("en-US", {
                month: "short",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })}
            </p>
          )}
        </section>
      )}

      {liveSession && (
        <section className="apex-glass-soft rounded-2xl overflow-hidden">
          <div className="grid grid-cols-[42px_44px_90px_1fr_1fr_110px_140px_90px_74px] gap-2 px-4 py-3.5 text-[10px] tracking-[0.12em] uppercase font-bold text-warm-500 border-b border-white/[0.07]">
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

          <div className="max-h-[70vh] overflow-y-auto">
            {isConfigError && (
              <div className="p-4 font-medium text-sm text-[#ff9b8a]">
                Live timing isn&apos;t available in this environment yet.
              </div>
            )}
            {!isConfigError && isLoadingTiming && timingRows.length === 0 && (
              <div className="p-4 font-medium text-sm text-warm-400">
                Loading live timing feed…
              </div>
            )}
            {!isConfigError && timingError && (
              <div className="p-4 font-medium text-sm text-[#ff9b8a]">
                {timingError}
              </div>
            )}
            {!isConfigError && !isLoadingTiming && !timingError && timingRows.length === 0 && (
              <div className="p-4 font-medium text-sm text-warm-400">
                No timing rows available yet.
              </div>
            )}
            {timingRows.map((line, index) => (
              <div
                key={`${line.racingNumber ?? index}-${line.position ?? index}`}
                className="grid grid-cols-[42px_44px_90px_1fr_1fr_110px_140px_90px_74px] gap-2 px-4 py-2.5 items-center border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors"
              >
                <div className="text-center font-extrabold tabular-nums">
                  {line.position ?? "—"}
                </div>
                <div className="text-center text-warm-400 tabular-nums">
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
                <div className="text-right text-warm-300 tabular-nums">
                  {line.gapToLeader || line.timeDiffToFastest || "LEADER"}
                </div>
                <div className="text-right text-warm-300 tabular-nums">
                  {line.intervalToPositionAhead ||
                    line.timeDiffToPositionAhead ||
                    "—"}
                </div>
                <div className="text-right tabular-nums text-on-background">
                  {line.lastLapTime || "—"}
                </div>
                <div className="flex justify-center gap-1">
                  {[0, 1, 2].map((sectorIdx) => (
                    <span
                      key={sectorIdx}
                      className={`h-2 w-9 rounded-hairline ${getSectorColor(
                        line.Sectors?.[sectorIdx]
                      )}`}
                    />
                  ))}
                </div>
                <div className="flex items-center justify-center gap-2 text-xs tabular-nums">
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${getTyreDotColor(
                      line.compound
                    )}`}
                  />
                  <span>{line.tyreAge ?? "—"}</span>
                </div>
                <div className="text-center text-[11px] font-semibold text-warm-300">
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

