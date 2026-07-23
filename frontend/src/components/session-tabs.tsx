"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Race, RaceResult } from "@/lib/api";
import { getDriverImagePath, hasDriverImage } from "@/lib/driver-images";
import { getTeamColor } from "@/lib/team-colors";

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
}: SessionTabsProps) {
  const [nowMs] = useState<number>(() => Date.now());

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
                  ? "font-bold bg-[rgba(255,90,31,0.18)] text-[#FFAE6A]"
                  : "font-semibold text-warm-300 hover:text-on-background"
              }`}
            >
              {SESSION_LABELS[key]}
            </button>
          );
        })}
      </div>

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
    <div className="apex-glass apex-sheen rounded-[18px] p-[22px] overflow-hidden relative">
      <div
        className="absolute left-0 top-0 bottom-0 w-[5px]"
        style={{ background: color.hex, boxShadow: `0 0 16px ${color.glow}` }}
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
        <span className="font-bold text-[11px] tracking-[0.12em] uppercase text-[#FF7A3D]">
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
      <span className="font-bold text-[11px] tracking-[0.12em] uppercase text-[#FF7A3D]">
        Fastest lap
      </span>
      <div className="font-extrabold text-3xl tabular-nums my-3.5 mb-1 text-[#FFAE6A]">
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
            className="font-bold text-[11px] tracking-[0.08em] uppercase px-4 py-2 rounded-[10px] bg-[rgba(255,90,31,0.16)] text-[#FFAE6A] hover:bg-[rgba(255,90,31,0.24)] transition-[background-color,transform] duration-150 active:scale-95"
          >
            Pitwall analysis
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
                style={{ color: isP1 ? "#FFAE6A" : "#8f867a" }}
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
                style={{ color: Number(r.points) > 0 ? "#f6f1ea" : "#6f665b" }}
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
              style={{ color: isP1 ? "#FFAE6A" : "#8f867a" }}
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
                <span className="font-semibold text-[13px] tabular-nums text-right sm:text-left text-[#FFAE6A]">
                  {r.Q3 || "—"}
                </span>
              </>
            ) : showBestLap ? (
              <span className="font-semibold text-[13px] tabular-nums text-right sm:text-left text-[#FFAE6A]">
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
              ? { background: "rgba(245,235,222,0.06)", color: "#8f867a" }
              : { background: "rgba(255,90,31,0.16)", color: "#FFAE6A" }
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
          accent ? "text-[#FFAE6A]" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function UpcomingSessionTimings({
  race,
  nowMs,
}: {
  race: Race;
  nowMs: number;
}) {
  const sessions: { key: string; label: string }[] = [
    { key: "FirstPractice", label: "Free Practice 1" },
    { key: "SecondPractice", label: "Free Practice 2" },
    { key: "ThirdPractice", label: "Free Practice 3" },
    { key: "SprintQualifying", label: "Sprint Qualifying" },
    { key: "Sprint", label: "Sprint Race" },
    { key: "Qualifying", label: "Qualifying" },
  ];

  const raceSessions = race as Race &
    Partial<Record<SessionKey, RaceSessionData>>;

  const raceDate = race.date
    ? new Date(
        race.time && race.time.endsWith("Z")
          ? `${race.date}T${race.time}`
          : `${race.date}T${race.time ?? "12:00:00Z"}`
      )
    : null;

  const rows: {
    label: string;
    dt: Date;
    past: boolean;
    isRace?: boolean;
  }[] = [];
  for (const { key, label } of sessions) {
    const sd = raceSessions[key as SessionKey];
    if (!sd?.date) continue;
    const dt = new Date(
      sd.time && sd.time.endsWith("Z")
        ? `${sd.date}T${sd.time}`
        : `${sd.date}T${sd.time ?? "12:00:00Z"}`
    );
    rows.push({ label, dt, past: dt.getTime() < nowMs });
  }
  if (raceDate)
    rows.push({
      label: "Race",
      dt: raceDate,
      past: raceDate.getTime() < nowMs,
      isRace: true,
    });

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
              <p className="font-medium text-xs text-warm-500 mt-0.5">
                {s.dt.toLocaleDateString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "2-digit",
                })}
              </p>
            </div>
            <div className="text-right">
              <p
                className={`font-[family-name:var(--font-headline)] font-bold text-xl tabular-nums ${
                  s.isRace ? "text-[#FFAE6A]" : ""
                }`}
              >
                {s.dt.toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
              <p className="font-semibold text-[10px] tracking-[0.1em] uppercase text-warm-500">
                {s.past ? "Completed" : s.isRace ? "Lights out" : "Local time"}
              </p>
            </div>
          </div>
        ))}
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
