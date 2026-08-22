"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Race, RaceResult, SessionWeather } from "@/lib/api";
import { getDriverImagePath, hasDriverImage } from "@/lib/driver-images";
import { getTeamColor } from "@/lib/team-colors";
import TeamCar from "@/components/team-car";
import { buildRaceSessionTimeline, type RaceSessionField } from "@/lib/sessions";
import SessionRecapCard from "@/components/session-recap-card";
import LocalDateTime from "@/components/local-datetime";
import ConditionsTile from "@/components/conditions-tile";

interface SessionTabsProps {
  race: Race;
  results: RaceResult[];
  qualifyingResults: RaceResult[];
  sprintResults: RaceResult[];
  sprintQualiResults: RaceResult[];
  fp1Results: RaceResult[];
  fp2Results: RaceResult[];
  fp3Results: RaceResult[];
  isPast: boolean;
  /**
   * The whole `weather_cache` document for this round: the race's own figures
   * at the top level plus, from schema 2 onward, a `sessions` map.
   *
   * Conditions are rendered HERE rather than above this component because the
   * figures belong to one session and the active session is this component's
   * state. Rendering them outside meant a race-only tile sat above a tab strip
   * covering practice, qualifying and the sprint, describing whichever tab
   * happened to be open.
   */
  weather?: (SessionWeather & { sessions?: Record<string, SessionWeather> }) | null;
}

type SessionKey =
  | "Race"
  | "Qualifying"
  | "Sprint"
  | "SprintQualifying"
  | "ThirdPractice"
  | "SecondPractice"
  | "FirstPractice";

const SESSION_LABELS: Record<SessionKey, string> = {
  Race: "Race",
  Qualifying: "Qualifying",
  Sprint: "Sprint Race",
  SprintQualifying: "Sprint Quali",
  ThirdPractice: "FP3",
  SecondPractice: "FP2",
  FirstPractice: "FP1",
};

type RaceSessionData = { date?: string; time?: string };

function fmtInterval(r: RaceResult, isLeader: boolean) {
  if (isLeader) return r.Time?.time ?? r.status ?? "—";
  if (r.Time?.time)
    return r.Time.time.startsWith("+") ? r.Time.time : `+${r.Time.time}`;
  return r.status ?? "—";
}

export default function SessionTabs({
  race,
  results,
  qualifyingResults,
  sprintResults,
  sprintQualiResults,
  fp1Results,
  fp2Results,
  fp3Results,
  isPast,
  weather,
}: SessionTabsProps) {
  const [nowMs] = useState<number>(() => Date.now());
  const params = useParams();
  const seasonYear = Number(params?.season);

  const availableSessions: SessionKey[] = ["Race"];
  const sessionKeys: SessionKey[] = [
    "Qualifying",
    "Sprint",
    "SprintQualifying",
    "ThirdPractice",
    "SecondPractice",
    "FirstPractice",
  ];
  const raceSessions = race as Race &
    Partial<Record<SessionKey, RaceSessionData>>;
  for (const key of sessionKeys) {
    if (raceSessions[key]?.date) availableSessions.push(key);
  }

  const [activeSession, setActiveSession] = useState<SessionKey>("Race");

  const winner = results[0];
  const p2 = results[1];
  const p3 = results[2];
  const fastestLapResult = results.find((r) => r.FastestLap?.rank === "1");

  return (
    <div>
      {/* Session Tabs */}
      <div className="flex flex-wrap gap-2 mb-5">
        {availableSessions.map((key) => {
          const active = activeSession === key;
          return (
            <button
              key={key}
              onClick={() => setActiveSession(key)}
              className={`text-xs px-[18px] py-2.5 rounded-[10px] transition-[background-color,color,transform] duration-150 active:scale-[0.97] ${
                active
                  ? "font-bold bg-[rgba(255,90,31,0.18)] text-primary"
                  : "font-semibold text-warm-300 hover:text-on-background"
              }`}
            >
              {SESSION_LABELS[key]}
            </button>
          );
        })}
      </div>

      {/* Conditions for the SELECTED session.
          `sessions` is absent on rounds cached before weather schema 2. Falling
          back to the top-level (race) figures for every tab is exactly the bug
          this replaced, so the fallback covers the Race tab only and other tabs
          simply show no tile until the hourly sync back-fills the round. */}
      <ConditionsTile
        weather={
          weather?.sessions
            ? weather.sessions[activeSession] ?? null
            : activeSession === "Race"
              ? weather ?? null
              : null
        }
        sessionLabel={SESSION_LABELS[activeSession]}
      />

      {/* Race Session Content */}
      {activeSession === "Race" && (
        <>
          {isPast && results.length > 0 ? (
            <>
              {/* Podium */}
              <div className="grid md:grid-cols-[1.3fr_1fr_1fr] gap-3.5 mb-6">
                {winner && <WinnerCard r={winner} />}
                <div className="flex flex-col gap-3.5">
                  {p2 && <RunnerRow r={p2} pos="P2" />}
                  {p3 && <RunnerRow r={p3} pos="P3" />}
                </div>
                {fastestLapResult ? (
                  <FastestLapCard r={fastestLapResult} />
                ) : (
                  <div className="apex-glass-soft rounded-2xl p-[22px] flex flex-col justify-center">
                    <span className="font-bold text-[11px] tracking-[0.12em] uppercase text-warm-400">
                      Fastest lap
                    </span>
                    <span className="font-medium text-sm text-warm-400 mt-2">
                      Not reported for this session.
                    </span>
                  </div>
                )}
              </div>
              {Number.isFinite(seasonYear) && (
                <SessionRecapCard year={seasonYear} round={Number(race.round)} />
              )}
              <FullResultsTable results={results} />
            </>
          ) : isPast ? (
            <EmptyState
              title="Results pending"
              body="This race has finished but results are not yet in the data feed. They usually sync within a few hours of the chequered flag."
            />
          ) : (
            <UpcomingSessionTimings race={race} nowMs={nowMs} />
          )}
        </>
      )}

      {/* Non-Race Sessions */}
      {activeSession !== "Race" && (
        <>
          {/* AI Recap only exists for Qualifying and Sprint (see
              session_recap.py's SESSION_FACT_BUILDERS) — Practice sessions
              aren't classified results in the same sense and have no recap. */}
          {Number.isFinite(seasonYear) &&
            (activeSession === "Qualifying" ? qualifyingResults.length > 0 : false) && (
              <SessionRecapCard
                year={seasonYear}
                round={Number(race.round)}
                session="qualifying"
              />
            )}
          {Number.isFinite(seasonYear) &&
            (activeSession === "Sprint" ? sprintResults.length > 0 : false) && (
              <SessionRecapCard year={seasonYear} round={Number(race.round)} session="sprint" />
            )}
          <SessionInfo
            race={race}
            sessionKey={activeSession}
            nowMs={nowMs}
            sessionResults={
              activeSession === "Qualifying"
                ? qualifyingResults
                : activeSession === "SprintQualifying"
                ? sprintQualiResults
                : activeSession === "Sprint"
                ? sprintResults
                : activeSession === "FirstPractice"
                ? fp1Results
                : activeSession === "SecondPractice"
                ? fp2Results
                : activeSession === "ThirdPractice"
                ? fp3Results
                : []
            }
          />
        </>
      )}
    </div>
  );
}

/* ---------------------------- podium pieces ---------------------------- */

function WinnerCard({ r }: { r: RaceResult }) {
  const given = r.Driver?.givenName;
  const family = r.Driver?.familyName;
  const color = getTeamColor(r.Constructor?.name);
  const hasImg = hasDriverImage(given, family);
  const img = hasImg ? getDriverImagePath(given, family) : null;

  return (
    <div className="apex-glass apex-sheen rounded-[18px] p-[22px] overflow-hidden relative isolate">
      <div
        className="absolute left-0 top-0 bottom-0 w-[5px]"
        style={{ background: color.hex, boxShadow: `0 0 16px ${color.glow}` }}
      />
      {/* The winning car, along the bottom edge, pulling away to the right.
          Low enough to be texture rather than an image — the driver's portrait
          already occupies the right third of this card, and two photographs
          competing for one card is how a result hero turns into a collage.
          Anchored bottom-left because that is the only region with nothing in
          it once the name, team and total time are placed. */}
      <TeamCar
        team={r.Constructor?.name}
        variant="ghost-left"
        opacity={0.17}
        sizes="(min-width: 768px) 420px, 80vw"
        className="absolute -z-10 left-0 bottom-0 h-[64px] w-[74%]"
      />
      {img ? (
        <div className="absolute top-5 right-4 bottom-5 w-[34%] pointer-events-none overflow-hidden rounded-lg">
          <Image
            src={img}
            alt={`${given} ${family}`}
            fill
            sizes="200px"
            className="object-cover object-[50%_10%] drop-shadow-[0_10px_28px_rgba(0,0,0,0.7)]"
          />
        </div>
      ) : (
        <div
          className="absolute top-5 right-5 bottom-5 w-[90px] rounded-xl flex items-end justify-center pb-2.5 apex-hatch"
          style={{ borderColor: color.hex }}
        >
          <span className="font-semibold text-[8px] text-warm-500">
            // WINNER
          </span>
        </div>
      )}
      <div className="relative max-w-[62%]">
        <span className="font-bold text-[11px] tracking-[0.12em] uppercase text-flame">
          Race winner
        </span>
        <div className="font-[family-name:var(--font-headline)] font-bold text-2xl mt-3 mb-0.5">
          {`${given ?? ""} ${family ?? ""}`.trim() || "—"}
        </div>
        <div className="font-semibold text-xs text-warm-400">
          {r.Constructor?.name}
        </div>
        <div className="mt-5">
          <div className="font-semibold text-[10px] tracking-[0.1em] uppercase text-warm-500">
            Total time
          </div>
          <div className="font-extrabold text-[22px] tabular-nums mt-0.5">
            {r.Time?.time ?? r.status ?? "—"}
          </div>
        </div>
      </div>
    </div>
  );
}

function RunnerRow({ r, pos }: { r: RaceResult; pos: string }) {
  const color = getTeamColor(r.Constructor?.name);
  return (
    <div className="flex-1 apex-glass-soft rounded-2xl px-5 py-[18px] flex items-center gap-3.5">
      <span className="font-extrabold text-xl text-warm-200">{pos}</span>
      <span
        className="w-1 h-[30px] rounded-[3px]"
        style={{ background: color.hex }}
      />
      <div className="flex-1 min-w-0">
        <div className="font-bold text-[15px] truncate">
          {`${r.Driver?.givenName ?? ""} ${r.Driver?.familyName ?? ""}`.trim()}
        </div>
        <div className="font-semibold text-[11px] uppercase text-warm-400 truncate">
          {r.Constructor?.name}
        </div>
      </div>
      <span className="font-bold text-sm tabular-nums text-warm-300">
        {fmtInterval(r, false)}
      </span>
    </div>
  );
}

function FastestLapCard({ r }: { r: RaceResult }) {
  return (
    <div className="apex-glass-soft rounded-2xl p-[22px]">
      <span className="font-bold text-[11px] tracking-[0.12em] uppercase text-flame">
        Fastest lap
      </span>
      <div className="font-extrabold text-3xl tabular-nums my-3.5 mb-1 text-primary">
        {r.FastestLap?.Time?.time ?? "—"}
      </div>
      <div className="font-bold text-[15px]">
        {`${r.Driver?.givenName ?? ""} ${r.Driver?.familyName ?? ""}`.trim()}
      </div>
      <div className="font-semibold text-[11px] text-warm-400 mt-0.5">
        {r.Constructor?.name} · Lap {r.FastestLap?.lap ?? "—"} /{" "}
        {r.laps ?? "—"}
      </div>
    </div>
  );
}

/* --------------------------- results tables --------------------------- */

function ResultRow({
  children,
  cols,
}: {
  children: React.ReactNode;
  cols: string;
}) {
  return (
    <div
      className={`grid ${cols} gap-3 px-4 sm:px-[22px] py-[13px] items-center border-b border-white/[0.04] transition-colors hover:bg-white/[0.03]`}
    >
      {children}
    </div>
  );
}

function FullResultsTable({ results }: { results: RaceResult[] }) {
  const params = useParams();
  const season = params?.season as string | undefined;
  const round = params?.round as string | undefined;
  const cols =
    "grid-cols-[44px_1fr_90px] sm:grid-cols-[60px_1fr_140px_120px_60px]";

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-bold text-[11px] tracking-[0.18em] uppercase text-warm-400">
          Full classification
        </h3>
        {season && round && (
          <Link
            href={`/schedule/${season}/${round}/pitwall`}
            className="group inline-flex items-center gap-2 font-bold text-xs tracking-[0.08em] uppercase text-[#1a1210] px-5 py-2.5 rounded-[12px] shadow-[0_6px_20px_rgba(255,90,31,0.35)] hover:shadow-[0_8px_26px_rgba(255,90,31,0.5)] transition-[box-shadow,transform] duration-150 active:scale-95"
            style={{ background: "linear-gradient(90deg,var(--color-primary),var(--color-primary-container))" }}
          >
            <span className="material-symbols-outlined text-[17px] leading-none">
              query_stats
            </span>
            Pitwall analysis
            <span className="material-symbols-outlined text-[16px] leading-none transition-transform duration-150 group-hover:translate-x-0.5">
              arrow_forward
            </span>
          </Link>
        )}
      </div>
      <div className="apex-glass-soft rounded-2xl overflow-hidden">
        <div
          className={`grid ${cols} gap-3 px-4 sm:px-[22px] py-3.5 font-bold text-[10px] tracking-[0.12em] uppercase text-warm-500 border-b border-white/[0.07]`}
        >
          <span>Pos</span>
          <span>Driver</span>
          <span className="hidden sm:block">Team</span>
          <span className="text-right sm:text-left">Interval</span>
          <span className="hidden sm:block text-right">Pts</span>
        </div>
        {results.map((r, idx) => {
          const given = r.Driver?.givenName ?? "";
          const family = r.Driver?.familyName ?? "";
          const color = getTeamColor(r.Constructor?.name);
          const isP1 = idx === 0;
          const gap = fmtInterval(r, isP1);
          const dnf = /dnf|dns|dsq|ret/i.test(gap);
          return (
            <ResultRow key={`${r.position}-${given}${family}-${idx}`} cols={cols}>
              <span
                className="font-extrabold text-[15px] tabular-nums"
                style={{ color: isP1 ? "var(--color-primary)" : "var(--color-warm-400)" }}
              >
                {String(r.position ?? idx + 1).padStart(2, "0")}
              </span>
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className="w-[3px] h-6 rounded-[2px] flex-none"
                  style={{ background: color.hex }}
                />
                <span className="font-bold text-sm truncate">
                  {given && family ? `${given} ${family}` : "—"}
                </span>
              </div>
              <span className="hidden sm:block font-semibold text-xs uppercase text-warm-300 truncate">
                {r.Constructor?.name}
              </span>
              <span
                className="font-semibold text-[13px] tabular-nums text-right sm:text-left"
                style={{ color: dnf ? "#c98a8a" : "#c9c0b4" }}
              >
                {gap}
              </span>
              <span
                className="hidden sm:block text-right font-extrabold text-[15px] tabular-nums"
                style={{ color: Number(r.points) > 0 ? "var(--color-warm-100)" : "#6f665b" }}
              >
                {r.points ?? "0"}
              </span>
            </ResultRow>
          );
        })}
      </div>
    </div>
  );
}

const LAP_TIMED_SESSIONS: SessionKey[] = [
  "FirstPractice",
  "SecondPractice",
  "ThirdPractice",
  "SprintQualifying",
];

function SessionResultsTable({
  sessionKey,
  results,
}: {
  sessionKey: SessionKey;
  results: RaceResult[];
}) {
  const hasSegmentTimes = results.some((r) => r.Q1 || r.Q2 || r.Q3);
  const showSegments =
    (sessionKey === "Qualifying" || sessionKey === "SprintQualifying") &&
    hasSegmentTimes;
  const showBestLap = !showSegments && LAP_TIMED_SESSIONS.includes(sessionKey);

  const cols = showSegments
    ? "grid-cols-[44px_1fr_80px_80px_80px] sm:grid-cols-[60px_1fr_140px_90px_90px_90px]"
    : "grid-cols-[44px_1fr_100px] sm:grid-cols-[60px_1fr_140px_120px]";

  return (
    <div className="apex-glass-soft rounded-2xl overflow-hidden">
      <div
        className={`grid ${cols} gap-3 px-4 sm:px-[22px] py-3.5 font-bold text-[10px] tracking-[0.12em] uppercase text-warm-500 border-b border-white/[0.07]`}
      >
        <span>Pos</span>
        <span>Driver</span>
        <span className="hidden sm:block">Team</span>
        {showSegments ? (
          <>
            <span className="text-right sm:text-left">Q1</span>
            <span className="text-right sm:text-left">Q2</span>
            <span className="text-right sm:text-left">Q3</span>
          </>
        ) : showBestLap ? (
          <span className="text-right sm:text-left">Best lap</span>
        ) : (
          <span className="text-right sm:text-left">Time / status</span>
        )}
      </div>
      {results.map((r, idx) => {
        const given = r.Driver?.givenName ?? "";
        const family = r.Driver?.familyName ?? "";
        const color = getTeamColor(r.Constructor?.name);
        const isP1 = idx === 0;
        return (
          <ResultRow
            key={`${sessionKey}-${r.position}-${given}${family}-${idx}`}
            cols={cols}
          >
            <span
              className="font-extrabold text-[15px] tabular-nums"
              style={{ color: isP1 ? "var(--color-primary)" : "var(--color-warm-400)" }}
            >
              {String(r.position ?? idx + 1).padStart(2, "0")}
            </span>
            <div className="flex items-center gap-3 min-w-0">
              <span
                className="w-[3px] h-6 rounded-[2px] flex-none"
                style={{ background: color.hex }}
              />
              <span className="font-bold text-sm truncate">
                {given && family ? `${given} ${family}` : "—"}
              </span>
            </div>
            <span className="hidden sm:block font-semibold text-xs uppercase text-warm-300 truncate">
              {r.Constructor?.name}
            </span>
            {showSegments ? (
              <>
                <span className="font-semibold text-[13px] tabular-nums text-right sm:text-left text-warm-200">
                  {r.Q1 || "—"}
                </span>
                <span className="font-semibold text-[13px] tabular-nums text-right sm:text-left text-warm-200">
                  {r.Q2 || "—"}
                </span>
                <span className="font-semibold text-[13px] tabular-nums text-right sm:text-left text-primary">
                  {r.Q3 || "—"}
                </span>
              </>
            ) : showBestLap ? (
              <span className="font-semibold text-[13px] tabular-nums text-right sm:text-left text-primary">
                {r.Time?.time || "—"}
              </span>
            ) : (
              <span className="font-semibold text-[13px] tabular-nums text-right sm:text-left text-warm-200">
                {r.Time?.time || r.status || "—"}
              </span>
            )}
          </ResultRow>
        );
      })}
    </div>
  );
}

/* --------------------------- session detail --------------------------- */

function SessionInfo({
  race,
  sessionKey,
  nowMs,
  sessionResults,
}: {
  race: Race;
  sessionKey: SessionKey;
  nowMs: number;
  sessionResults: RaceResult[];
}) {
  const raceSessions = race as Race &
    Partial<Record<SessionKey, RaceSessionData>>;
  const sessionData = raceSessions[sessionKey];
  const label = SESSION_LABELS[sessionKey];

  if (!sessionData?.date) {
    return (
      <EmptyState
        title={`${label} not scheduled`}
        body="This session is not part of this event's weekend format."
      />
    );
  }

  const dt = new Date(
    sessionData.time && sessionData.time.endsWith("Z")
      ? `${sessionData.date}T${sessionData.time}`
      : `${sessionData.date}T${sessionData.time ?? "12:00:00Z"}`
  );
  const sessionPast = dt.getTime() < nowMs;

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <h3 className="font-[family-name:var(--font-headline)] font-bold text-2xl">
          {label}
        </h3>
        <span
          className="ml-auto font-bold text-[10px] tracking-[0.1em] uppercase px-3 py-1.5 rounded-lg"
          style={
            sessionPast
              ? { background: "rgba(245,235,222,0.06)", color: "var(--color-warm-400)" }
              : { background: "rgba(255,90,31,0.16)", color: "var(--color-primary)" }
          }
        >
          {sessionPast ? "Completed" : "Upcoming"}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 mb-6">
        <InfoTile
          label="Date"
          value={dt.toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "2-digit",
          })}
        />
        <InfoTile
          label="Local start time"
          value={dt.toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
            timeZoneName: "short",
          })}
          accent
        />
        <InfoTile label="Circuit" value={race.Circuit?.circuitName ?? "TBC"} />
      </div>

      {sessionPast && sessionResults.length > 0 ? (
        <div className="space-y-4">
          <h4 className="font-bold text-[11px] tracking-[0.18em] uppercase text-warm-400">
            {label} classification
          </h4>
          <SessionResultsTable sessionKey={sessionKey} results={sessionResults} />
        </div>
      ) : sessionPast ? (
        <div className="apex-glass-soft rounded-xl px-5 py-4 border-l-2 border-warm-600">
          <p className="font-medium text-sm text-warm-400">
            Detailed classification for {label} is not available in the data
            feed.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function InfoTile({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="apex-glass-soft rounded-[14px] px-[22px] py-[18px]">
      <p className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500">
        {label}
      </p>
      <p
        className={`font-[family-name:var(--font-headline)] font-bold text-lg mt-1 ${
          accent ? "text-primary" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}

const WEEKEND_SCHEDULE_LABELS: Record<RaceSessionField, string> = {
  FirstPractice: "Free Practice 1",
  SecondPractice: "Free Practice 2",
  ThirdPractice: "Free Practice 3",
  SprintQualifying: "Sprint Qualifying",
  Sprint: "Sprint Race",
  Qualifying: "Qualifying",
  Race: "Race",
};

function UpcomingSessionTimings({
  race,
  nowMs,
}: {
  race: Race;
  nowMs: number;
}) {
  // Reuse the shared session-timeline helper so start/end times (and
  // therefore calendar durations) always agree with the rest of the app,
  // instead of re-deriving dates from the raw race payload here.
  const timeline = buildRaceSessionTimeline(race);

  const rows = timeline.map((item) => ({
    label: WEEKEND_SCHEDULE_LABELS[item.sessionField] ?? item.sessionLabel,
    dt: new Date(item.startTimeMs),
    startMs: item.startTimeMs,
    endMs: item.endTimeMs,
    past: item.startTimeMs < nowMs,
    isRace: item.sessionField === "Race",
    raceName: item.raceName,
    circuitName: item.circuitName,
  }));

  return (
    <div>
      <h3 className="font-[family-name:var(--font-headline)] font-bold text-xl mb-4">
        Weekend schedule
      </h3>
      <div className="flex flex-col gap-3">
        {rows.map((s) => (
          <div
            key={s.label}
            className="flex items-center justify-between px-5 py-4 rounded-2xl border"
            style={{
              background: s.isRace
                ? "rgba(255,90,31,0.1)"
                : "rgba(40,32,26,0.3)",
              borderColor: s.isRace
                ? "rgba(255,90,31,0.4)"
                : "rgba(255,255,255,0.07)",
              opacity: s.past ? 0.55 : 1,
            }}
          >
            <div>
              <h4 className="font-bold text-[15px]">{s.label}</h4>
              {/* `LocalDateTime`, not a bare `toLocaleDateString(undefined,
                  ...)`. This component is `"use client"` but Next still renders
                  it on the SERVER first, where `undefined` resolves to the
                  container's timezone (UTC on Cloud Run) rather than the
                  reader's -- the exact React #418 hydration mismatch
                  `local-datetime.tsx` was written to eliminate. */}
              <p className="font-medium text-xs text-warm-500 mt-0.5">
                <LocalDateTime
                  timestampMs={s.dt.getTime()}
                  options={{ weekday: "short", month: "short", day: "2-digit" }}
                />
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <p
                  className={`font-[family-name:var(--font-headline)] font-bold text-xl tabular-nums ${
                    s.isRace ? "text-primary" : ""
                  }`}
                >
                  <LocalDateTime
                    timestampMs={s.dt.getTime()}
                    options={{ hour: "2-digit", minute: "2-digit", hour12: false }}
                  />
                </p>
                {/* Every state names the timezone, and it says WHOSE.
                    Two of the three previously carried no timezone information
                    at all -- "Completed" and "Lights out" -- and the third said
                    "Local time", which is ambiguous between track-local and
                    viewer-local in a sport where those routinely differ by
                    eight hours. It is the viewer's. A reader planning to watch
                    is making a decision from this number, so it has to say so
                    on every row rather than only on the ones that happen to be
                    upcoming and non-race. */}
                <p className="font-semibold text-[10px] tracking-[0.1em] uppercase text-warm-500">
                  {s.past ? "Completed · your time" : s.isRace ? "Lights out · your time" : "Your local time"}
                </p>
              </div>
              <AddToCalendarButton
                raceName={s.raceName}
                circuitName={s.circuitName}
                sessionLabel={s.label}
                startMs={s.startMs}
                endMs={s.endMs}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------- add-to-calendar action ------------------------ */

function toCalendarUtc(ms: number): string {
  // RFC 5545 / Google Calendar "basic format" UTC timestamp: YYYYMMDDTHHmmssZ
  return new Date(ms).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function buildIcsContent({
  uid,
  title,
  location,
  details,
  startMs,
  endMs,
}: {
  uid: string;
  title: string;
  location: string;
  details: string;
  startMs: number;
  endMs: number;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//APEX F1 Hub//Session Reminders//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${toCalendarUtc(Date.now())}`,
    `DTSTART:${toCalendarUtc(startMs)}`,
    `DTEND:${toCalendarUtc(endMs)}`,
    `SUMMARY:${escapeIcsText(title)}`,
    `LOCATION:${escapeIcsText(location)}`,
    `DESCRIPTION:${escapeIcsText(details)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}

function downloadIcsFile(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function AddToCalendarButton({
  raceName,
  circuitName,
  sessionLabel,
  startMs,
  endMs,
}: {
  raceName: string;
  circuitName?: string;
  sessionLabel: string;
  startMs: number;
  endMs: number;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const title = `${raceName} · ${sessionLabel}`;
  const location = circuitName ?? "";
  const details = "Added from APEX — F1 Hub.";

  const googleUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(
    title
  )}&dates=${toCalendarUtc(startMs)}/${toCalendarUtc(
    endMs
  )}&details=${encodeURIComponent(details)}&location=${encodeURIComponent(
    location
  )}`;

  const handleIcsDownload = () => {
    const uid = `${startMs}-${sessionLabel.replace(/\s+/g, "")}@apex.f1hub`;
    const ics = buildIcsContent({
      uid,
      title,
      location,
      details,
      startMs,
      endMs,
    });
    const filename = `${title.replace(/[^\w\- ]+/g, "")}.ics`;
    downloadIcsFile(filename, ics);
    setOpen(false);
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Add ${sessionLabel} to calendar`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center justify-center w-9 h-9 rounded-[10px] bg-[rgba(245,235,222,0.06)] border border-white/10 text-warm-300 hover:text-primary hover:border-[rgba(255,138,61,0.5)] transition-[border-color,color,transform] duration-150 active:scale-[0.97]"
      >
        <span className="material-symbols-outlined text-[18px] leading-none">
          event_upcoming
        </span>
      </button>
      <div
        role="menu"
        className={`absolute right-0 top-full mt-2 w-48 origin-top-right rounded-xl bg-[rgba(26,22,19,0.98)] border border-white/10 shadow-2xl z-50 overflow-hidden transition-[transform,opacity] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] ${
          open
            ? "opacity-100 scale-100 pointer-events-auto"
            : "opacity-0 scale-95 pointer-events-none"
        }`}
      >
        <a
          href={googleUrl}
          target="_blank"
          rel="noopener noreferrer"
          role="menuitem"
          onClick={() => setOpen(false)}
          className="flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-warm-200 hover:bg-white/[0.06] hover:text-primary transition-colors duration-150"
        >
          <span className="material-symbols-outlined text-[16px] leading-none">
            open_in_new
          </span>
          Google Calendar
        </a>
        <button
          type="button"
          role="menuitem"
          onClick={handleIcsDownload}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-warm-200 hover:bg-white/[0.06] hover:text-primary transition-colors duration-150"
        >
          <span className="material-symbols-outlined text-[16px] leading-none">
            download
          </span>
          Download .ics
        </button>
      </div>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="apex-glass-soft rounded-2xl px-6 py-14 text-center">
      <div className="font-[family-name:var(--font-headline)] font-bold text-xl">
        {title}
      </div>
      <p className="font-medium text-sm text-warm-400 mt-2 max-w-md mx-auto">
        {body}
      </p>
    </div>
  );
}
