"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Race, RaceResult } from "@/lib/api";
import { getDriverImagePath, hasDriverImage } from "@/lib/driver-images";

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

const SESSION_ICONS: Record<SessionKey, string> = {
  Race: "flag",
  Qualifying: "timer",
  Sprint: "bolt",
  SprintQualifying: "speed",
  ThirdPractice: "construction",
  SecondPractice: "build",
  FirstPractice: "tune",
};

type RaceSessionData = { date?: string; time?: string };

const teamColorMap: Record<string, string> = {
  "red bull": "bg-blue-600",
  mclaren: "bg-orange-500",
  ferrari: "bg-red-600",
  mercedes: "bg-teal-500",
  "aston martin": "bg-green-600",
  alpine: "bg-pink-500",
  williams: "bg-blue-400",
  rb: "bg-blue-500",
  sauber: "bg-green-500",
  haas: "bg-neutral-400",
};

function getTeamBarColor(teamName?: string) {
  if (!teamName) return "bg-neutral-500";
  const lower = teamName.toLowerCase();
  const match = Object.keys(teamColorMap).find((k) => lower.includes(k));
  return match ? teamColorMap[match] : "bg-neutral-500";
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
  // Figure out which sessions exist
  const availableSessions: SessionKey[] = [];

  // Always add Race first
  availableSessions.push("Race");

  // Check for other sessions based on race data
  const sessionKeys: SessionKey[] = [
    "Qualifying",
    "Sprint",
    "SprintQualifying",
    "ThirdPractice",
    "SecondPractice",
    "FirstPractice",
  ];

  const raceSessions = race as Race & Partial<Record<SessionKey, RaceSessionData>>;
  for (const key of sessionKeys) {
    const sessionData = raceSessions[key];
    if (sessionData?.date) {
      availableSessions.push(key);
    }
  }

  const [activeSession, setActiveSession] = useState<SessionKey>("Race");

  const winner = results[0];
  const p2 = results[1];
  const p3 = results[2];
  const fastestLapResult = results.find((r) => r.FastestLap?.rank === "1");

  return (
    <div>
      {/* Session Tabs */}
      <div className="flex flex-wrap gap-2 mb-8 border-b border-outline-variant/20 pb-4">
        {availableSessions.map((key) => {
          const isActive = activeSession === key;
          const icon = SESSION_ICONS[key];
          const label = SESSION_LABELS[key];

          return (
            <button
              key={key}
              onClick={() => setActiveSession(key)}
              className={`flex items-center gap-2 px-5 py-3 skew-x-[-10deg] transition-all text-sm font-[family-name:var(--font-headline)] font-bold uppercase tracking-tight ${
                isActive
                  ? key === "Race"
                    ? "bg-primary-container text-on-primary"
                    : "bg-surface-container-highest text-primary-container border-b-2 border-primary-container"
                  : "text-neutral-500 hover:text-neutral-200 hover:bg-surface-container-low"
              }`}
            >
              <span className="skew-x-[10deg] flex items-center gap-2">
                <span className="material-symbols-outlined text-base">
                  {icon}
                </span>
                {label}
              </span>
            </button>
          );
        })}
      </div>

      {/* Race Session Content */}
      {activeSession === "Race" && (
        <>
          {isPast && results.length > 0 ? (
            <>
              {/* Podium Highlights */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-4 mb-12">
                {winner && (
                  <div className="md:col-span-6 lg:col-span-4 glass-panel p-6 relative overflow-hidden group">
                    {/* Background number */}
                    <span className="absolute -right-2 -bottom-4 font-[family-name:var(--font-headline)] font-black text-[160px] italic text-white/[0.03] select-none pointer-events-none leading-none">
                      {winner.number ?? ""}
                    </span>

                    <div className="border-l-4 border-primary-container pl-4 relative z-10">
                      <span className="text-[10px] uppercase tracking-widest font-bold text-primary-container">
                        Race Winner
                      </span>
                      <h2 className="text-3xl font-[family-name:var(--font-headline)] font-black italic skew-x-[-12deg] mt-1">
                        {`${winner.Driver?.givenName ?? ""} ${winner.Driver?.familyName ?? ""}`.trim().toUpperCase()}
                      </h2>
                      <p className="text-neutral-400 text-sm font-[family-name:var(--font-label)] uppercase tracking-wider mt-1">
                        {winner.Constructor?.name}
                      </p>
                    </div>
                    <div className="mt-8 flex justify-between items-end relative z-10">
                      <div>
                        <span className="block text-[10px] uppercase text-neutral-500">
                          Total Time
                        </span>
                        <span className="text-xl font-[family-name:var(--font-headline)] font-bold">
                          {winner.Time?.time ?? "—"}
                        </span>
                      </div>
                    </div>

                    {/* Driver image overlay */}
                    {hasDriverImage(winner.Driver?.givenName, winner.Driver?.familyName) && (
                      <div className="absolute bottom-0 right-0 w-[45%] h-full pointer-events-none z-[5]">
                        <Image
                          src={getDriverImagePath(winner.Driver?.givenName, winner.Driver?.familyName)!}
                          alt={`${winner.Driver?.givenName} ${winner.Driver?.familyName}`}
                          fill
                          className="object-contain object-bottom opacity-50 group-hover:opacity-80 group-hover:scale-105 transition-all duration-700 drop-shadow-[0_0_20px_rgba(0,0,0,0.8)]"
                        />
                      </div>
                    )}
                  </div>
                )}

                <div className="md:col-span-6 lg:col-span-4 flex flex-col gap-4">
                  {p2 && (
                    <div className="glass-panel p-5 flex items-center gap-4 border-l-2 border-neutral-400 overflow-hidden relative">
                      <div className="text-2xl font-[family-name:var(--font-headline)] font-black italic skew-x-[-12deg] text-neutral-400">
                        P2
                      </div>
                      {hasDriverImage(p2.Driver?.givenName, p2.Driver?.familyName) && (
                        <div className="w-10 h-10 overflow-hidden bg-neutral-800/50 flex-shrink-0 relative">
                          <Image
                            src={getDriverImagePath(p2.Driver?.givenName, p2.Driver?.familyName)!}
                            alt={`${p2.Driver?.givenName} ${p2.Driver?.familyName}`}
                            width={40}
                            height={40}
                            className="object-cover object-top scale-125 translate-y-1 w-full h-full"
                          />
                        </div>
                      )}
                      <div>
                        <h3 className="font-[family-name:var(--font-headline)] font-bold text-lg leading-tight uppercase">
                          {`${p2.Driver?.givenName ?? ""} ${p2.Driver?.familyName ?? ""}`.trim()}
                        </h3>
                        <p className="text-[10px] text-neutral-500 uppercase tracking-widest">
                          {p2.Constructor?.name}
                        </p>
                      </div>
                      <div className="ml-auto text-sm font-[family-name:var(--font-headline)]">
                        {p2.Time?.time ? (p2.Time.time.startsWith("+") ? p2.Time.time : `+${p2.Time.time}`) : p2.status ?? "—"}
                      </div>
                    </div>
                  )}
                  {p3 && (
                    <div className="glass-panel p-5 flex items-center gap-4 border-l-2 border-orange-500/50 overflow-hidden relative">
                      <div className="text-2xl font-[family-name:var(--font-headline)] font-black italic skew-x-[-12deg] text-orange-500/70">
                        P3
                      </div>
                      {hasDriverImage(p3.Driver?.givenName, p3.Driver?.familyName) && (
                        <div className="w-10 h-10 overflow-hidden bg-neutral-800/50 flex-shrink-0 relative">
                          <Image
                            src={getDriverImagePath(p3.Driver?.givenName, p3.Driver?.familyName)!}
                            alt={`${p3.Driver?.givenName} ${p3.Driver?.familyName}`}
                            width={40}
                            height={40}
                            className="object-cover object-top scale-125 translate-y-1 w-full h-full"
                          />
                        </div>
                      )}
                      <div>
                        <h3 className="font-[family-name:var(--font-headline)] font-bold text-lg leading-tight uppercase">
                          {`${p3.Driver?.givenName ?? ""} ${p3.Driver?.familyName ?? ""}`.trim()}
                        </h3>
                        <p className="text-[10px] text-neutral-500 uppercase tracking-widest">
                          {p3.Constructor?.name}
                        </p>
                      </div>
                      <div className="ml-auto text-sm font-[family-name:var(--font-headline)]">
                        {p3.Time?.time ? (p3.Time.time.startsWith("+") ? p3.Time.time : `+${p3.Time.time}`) : p3.status ?? "—"}
                      </div>
                    </div>
                  )}
                </div>

                {fastestLapResult && (
                  <div className="md:col-span-12 lg:col-span-4 glass-panel p-6 border-t-2 border-secondary-container relative overflow-hidden bg-gradient-to-br from-surface-container-low to-secondary-container/5">
                    <div className="flex justify-between items-start">
                      <div>
                        <span className="inline-flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold text-secondary-container mb-2">
                          <span className="material-symbols-outlined text-sm">
                            speed
                          </span>
                          Fastest Lap
                        </span>
                        <h2 className="text-3xl font-[family-name:var(--font-headline)] font-black italic skew-x-[-12deg]">
                          {`${fastestLapResult.Driver?.givenName ?? ""} ${fastestLapResult.Driver?.familyName ?? ""}`.trim().toUpperCase()}
                        </h2>
                        <p className="text-neutral-400 text-sm font-[family-name:var(--font-label)] uppercase tracking-wider mt-1">
                          {fastestLapResult.Constructor?.name}
                        </p>
                      </div>
                      <div className="text-right">
                        <span className="block text-4xl font-[family-name:var(--font-headline)] font-black text-secondary-container italic">
                          {fastestLapResult.FastestLap?.Time?.time ?? "—"}
                        </span>
                        <span className="text-[10px] uppercase text-neutral-500 font-bold">
                          Lap {fastestLapResult.FastestLap?.lap ?? "—"}/
                          {fastestLapResult.laps ?? "—"}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Full Results Table */}
              <FullResultsTable results={results} />
            </>
          ) : isPast ? (
            <div className="glass-panel p-12 text-center">
              <span className="material-symbols-outlined text-5xl text-neutral-600 mb-4">
                hourglass_empty
              </span>
              <h3 className="text-2xl font-[family-name:var(--font-headline)] font-bold italic uppercase text-neutral-400 mt-4">
                Results Pending
              </h3>
              <p className="text-neutral-500 text-sm mt-3 max-w-md mx-auto">
                This race has been completed but results are not yet available in the data feed.
                Results are typically synced within a few hours after the race ends.
              </p>
            </div>
          ) : (
            <UpcomingSessionTimings race={race} nowMs={nowMs} />
          )}
        </>
      )}

      {/* Non-Race Session Content */}
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

function FullResultsTable({ results }: { results: RaceResult[] }) {
  const params = useParams();
  const season = params?.season as string | undefined;
  const round = params?.round as string | undefined;

  return (
    <div className="overflow-x-auto">
      <div className="flex items-center justify-between mb-6 px-4">
        <h3 className="text-sm font-[family-name:var(--font-label)] uppercase tracking-[0.3em] font-bold text-neutral-500">
          Full Classification
        </h3>
        {season && round && (
          <Link
            href={`/schedule/${season}/${round}/pitwall`}
            className="flex items-center gap-2 bg-primary-container text-on-primary font-[family-name:var(--font-label)] text-xs uppercase tracking-widest font-bold px-4 py-2 hover:bg-primary-container/80 transition-colors active:scale-95 shadow-[0_0_15px_rgba(0,242,255,0.3)]"
          >
            <span className="material-symbols-outlined text-sm">analytics</span>
            View Pitwall Analysis
          </Link>
        )}
      </div>
      <table className="w-full text-left border-separate border-spacing-y-2">
        <thead>
          <tr className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-bold">
            <th className="px-6 py-4">Pos</th>
            <th className="px-6 py-4">Driver</th>
            <th className="px-6 py-4">Team</th>
            <th className="px-6 py-4">Interval / Gap</th>
            <th className="px-6 py-4 text-right">Points</th>
          </tr>
        </thead>
        <tbody className="font-[family-name:var(--font-label)]">
          {results.map((r, idx) => {
            const givenName = r.Driver?.givenName ?? "";
            const familyName = r.Driver?.familyName ?? "";
            const driverName = `${givenName} ${familyName}`.trim();
            const teamBar = getTeamBarColor(r.Constructor?.name);
            const isP1 = idx === 0;
            const hasImg = hasDriverImage(givenName, familyName);
            const imgPath = getDriverImagePath(givenName, familyName);

            return (
              <tr
                key={`${r.position}-${driverName}`}
                className="glass-panel group hover:bg-surface-container-highest/60 transition-colors"
              >
                <td
                  className={`px-6 py-5 font-[family-name:var(--font-headline)] font-black italic skew-x-[-12deg] text-xl ${
                    isP1 ? "text-primary-container" : "text-neutral-500"
                  }`}
                >
                  {String(r.position ?? idx + 1).padStart(2, "0")}
                </td>
                <td className="px-6 py-5">
                  <div className="flex items-center gap-3">
                    <div className={`w-1 h-8 ${teamBar}`} />
                    {hasImg && imgPath ? (
                      <div className="w-8 h-8 rounded-full overflow-hidden bg-neutral-800/50 flex-shrink-0 relative">
                        <Image
                          src={imgPath}
                          alt={driverName}
                          width={48}
                          height={48}
                          className="object-cover object-top w-full h-full scale-125 translate-y-1"
                        />
                      </div>
                    ) : null}
                    <div>
                      <div className="text-sm font-bold uppercase tracking-wide">
                        {r.Driver?.code
                          ? `${r.Driver.code.charAt(0)}. ${r.Driver.familyName}`
                          : driverName}
                      </div>
                      <div className="text-[10px] text-neutral-500 uppercase">
                        {r.Driver?.nationality}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-5 text-xs text-neutral-300 font-bold uppercase tracking-widest">
                  {r.Constructor?.name}
                </td>
                <td className="px-6 py-5 text-sm font-[family-name:var(--font-headline)] text-neutral-400">
                  {isP1
                    ? r.Time?.time ?? r.status ?? "—"
                    : r.Time?.time
                    ? (r.Time.time.startsWith("+") ? r.Time.time : `+${r.Time.time}`)
                    : r.status ?? "—"}
                </td>
                <td className="px-6 py-5 text-right font-[family-name:var(--font-headline)] font-bold text-lg">
                  {isP1 ? (
                    <span className="text-primary-container">{r.points}</span>
                  ) : (
                    r.points
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

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
  const raceSessions = race as Race & Partial<Record<SessionKey, RaceSessionData>>;
  const sessionData = raceSessions[sessionKey];
  const label = SESSION_LABELS[sessionKey];

  if (!sessionData?.date) {
    return (
      <div className="glass-panel p-12 text-center">
        <span className="material-symbols-outlined text-4xl text-neutral-700 mb-4">
          event_busy
        </span>
        <h3 className="text-xl font-[family-name:var(--font-headline)] font-bold italic uppercase text-neutral-500">
          {label} Not Scheduled
        </h3>
        <p className="text-neutral-600 text-sm mt-2">
          This session is not part of this event&apos;s weekend format.
        </p>
      </div>
    );
  }

  const dt = new Date(
    sessionData.time && sessionData.time.endsWith("Z")
      ? `${sessionData.date}T${sessionData.time}`
      : `${sessionData.date}T${sessionData.time ?? "12:00:00Z"}`
  );

  const sessionPast = dt.getTime() < nowMs;

  return (
    <div className="glass-panel p-8">
      <div className="flex items-center gap-4 mb-6">
        <span className="material-symbols-outlined text-primary-container text-3xl">
          {SESSION_ICONS[sessionKey]}
        </span>
        <div>
          <h3 className="text-2xl font-[family-name:var(--font-headline)] font-bold italic uppercase tracking-tight">
            {label}
          </h3>
          <p className="text-neutral-500 font-[family-name:var(--font-label)] text-xs uppercase tracking-widest">
            {race.raceName}
          </p>
        </div>
        <span
          className={`ml-auto px-4 py-1 text-[10px] font-bold uppercase tracking-widest ${
            sessionPast
              ? "bg-neutral-800 text-neutral-500"
              : "bg-primary-container/20 text-primary-container border border-primary-container/30"
          }`}
        >
          {sessionPast ? "Completed" : "Upcoming"}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-surface-container p-5">
          <p className="text-[10px] text-neutral-500 uppercase tracking-widest mb-2">
            Date
          </p>
          <p className="font-[family-name:var(--font-headline)] font-bold text-xl italic">
            {dt.toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "2-digit",
            })}
          </p>
        </div>
        <div className="bg-surface-container p-5">
          <p className="text-[10px] text-neutral-500 uppercase tracking-widest mb-2">
            Local Start Time
          </p>
          <p className="font-[family-name:var(--font-headline)] font-bold text-xl italic text-primary-container">
            {dt.toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              timeZoneName: "short",
            })}
          </p>
        </div>
        <div className="bg-surface-container p-5">
          <p className="text-[10px] text-neutral-500 uppercase tracking-widest mb-2">
            Circuit
          </p>
          <p className="font-[family-name:var(--font-headline)] font-bold text-xl italic">
            {race.Circuit?.circuitName ?? "TBC"}
          </p>
        </div>
      </div>

      {sessionPast && sessionResults.length > 0 ? (
        <div className="mt-8 space-y-8">
          <SessionPodiumCards
            sessionKey={sessionKey}
            results={sessionResults}
          />
          <h4 className="text-sm font-label uppercase tracking-[0.24em] text-neutral-500 mb-4">
            {label} Classification
          </h4>
          <SessionResultsTable
            sessionKey={sessionKey}
            results={sessionResults}
          />
        </div>
      ) : null}

      {sessionPast && sessionResults.length === 0 && (
        <div className="mt-6 p-4 bg-surface-container-low border-l-2 border-neutral-600">
          <p className="text-neutral-500 text-sm">
            Detailed classification for {label} is not available in the current
            backend data feed.
          </p>
        </div>
      )}
    </div>
  );
}

function SessionPodiumCards({
  sessionKey,
  results,
}: {
  sessionKey: SessionKey;
  results: RaceResult[];
}) {
  const winner = results[0];
  const p2 = results[1];
  const p3 = results[2];
  const heading =
    sessionKey === "Qualifying" || sessionKey === "SprintQualifying"
      ? "Pole Position"
      : sessionKey === "Sprint"
      ? "Sprint Winner"
      : `${SESSION_LABELS[sessionKey]} Leader`;

  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
      {winner && (
        <div className="md:col-span-6 lg:col-span-4 glass-panel p-6 relative overflow-hidden group">
          <span className="absolute -right-2 -bottom-4 font-headline font-black text-[160px] italic text-white/3 select-none pointer-events-none leading-none">
            {winner.Driver?.permanentNumber ?? ""}
          </span>
          <div className="border-l-4 border-primary-container pl-4 relative z-10">
            <span className="text-[10px] uppercase tracking-widest font-bold text-primary-container">
              {heading}
            </span>
            <h2 className="text-3xl font-headline font-black italic -skew-x-12 mt-1">
              {`${winner.Driver?.givenName ?? ""} ${winner.Driver?.familyName ?? ""}`
                .trim()
                .toUpperCase()}
            </h2>
            <p className="text-neutral-400 text-sm font-label uppercase tracking-wider mt-1">
              {winner.Constructor?.name}
            </p>
          </div>
          <div className="mt-8 flex justify-between items-end relative z-10">
            <div>
              <span className="block text-[10px] uppercase text-neutral-500">
                {sessionKey === "Qualifying" || sessionKey === "SprintQualifying"
                  ? "Best Time"
                  : "Result"}
              </span>
              <span className="text-xl font-headline font-bold">
                {winner.Q3 || winner.Q2 || winner.Q1 || winner.Time?.time || winner.status || "—"}
              </span>
            </div>
          </div>
          {hasDriverImage(winner.Driver?.givenName, winner.Driver?.familyName) && (
            <div className="absolute bottom-0 right-0 w-[45%] h-full pointer-events-none z-[5]">
              <Image
                src={getDriverImagePath(winner.Driver?.givenName, winner.Driver?.familyName)!}
                alt={`${winner.Driver?.givenName} ${winner.Driver?.familyName}`}
                fill
                className="object-contain object-bottom opacity-50 group-hover:opacity-80 group-hover:scale-105 transition-all duration-700 drop-shadow-[0_0_20px_rgba(0,0,0,0.8)]"
              />
            </div>
          )}
        </div>
      )}

      <div className="md:col-span-6 lg:col-span-8 grid grid-cols-1 gap-4">
        {[p2, p3].map((driver, index) =>
          driver ? (
            <div
              key={`${driver.position}-${index}`}
              className="glass-panel p-5 flex items-center gap-4 border-l-2 border-neutral-500/50 overflow-hidden relative"
            >
              <div className="text-2xl font-headline font-black italic -skew-x-12 text-neutral-400">
                {index === 0 ? "P2" : "P3"}
              </div>
              {hasDriverImage(driver.Driver?.givenName, driver.Driver?.familyName) && (
                <div className="w-10 h-10 overflow-hidden bg-neutral-800/50 flex-shrink-0 relative">
                  <Image
                    src={getDriverImagePath(driver.Driver?.givenName, driver.Driver?.familyName)!}
                    alt={`${driver.Driver?.givenName} ${driver.Driver?.familyName}`}
                    width={40}
                    height={40}
                    className="object-cover object-top scale-125 translate-y-1 w-full h-full"
                  />
                </div>
              )}
              <div>
                <h3 className="font-headline font-bold text-lg leading-tight uppercase">
                  {`${driver.Driver?.givenName ?? ""} ${driver.Driver?.familyName ?? ""}`.trim()}
                </h3>
                <p className="text-[10px] text-neutral-500 uppercase tracking-widest">
                  {driver.Constructor?.name}
                </p>
              </div>
              <div className="ml-auto text-sm font-headline">
                {driver.Q3 || driver.Q2 || driver.Q1 || driver.Time?.time || driver.status || "—"}
              </div>
            </div>
          ) : null
        )}
      </div>
    </div>
  );
}

function SessionResultsTable({
  sessionKey,
  results,
}: {
  sessionKey: SessionKey;
  results: RaceResult[];
}) {
  const isQualifying =
    sessionKey === "Qualifying" || sessionKey === "SprintQualifying";

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-separate border-spacing-y-2">
        <thead>
          <tr className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-bold">
            <th className="px-6 py-4">Pos</th>
            <th className="px-6 py-4">Driver</th>
            <th className="px-6 py-4">Team</th>
            {isQualifying ? (
              <>
                <th className="px-6 py-4">Q1</th>
                <th className="px-6 py-4">Q2</th>
                <th className="px-6 py-4">Q3</th>
              </>
            ) : (
              <>
                <th className="px-6 py-4">Status</th>
                <th className="px-6 py-4 text-right">Points</th>
              </>
            )}
          </tr>
        </thead>
        <tbody className="font-label">
          {results.map((r, idx) => {
            const givenName = r.Driver?.givenName ?? "";
            const familyName = r.Driver?.familyName ?? "";
            const driverName = `${givenName} ${familyName}`.trim();
            const teamBar = getTeamBarColor(r.Constructor?.name);
            const isP1 = idx === 0;
            return (
              <tr
                key={`${sessionKey}-${r.position}-${driverName}-${idx}`}
                className="glass-panel"
              >
                <td
                  className={`px-6 py-4 font-headline font-black italic -skew-x-12 text-xl ${
                    isP1 ? "text-primary-container" : "text-neutral-500"
                  }`}
                >
                  {String(r.position ?? idx + 1).padStart(2, "0")}
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className={`w-1 h-8 ${teamBar}`} />
                    {hasDriverImage(givenName, familyName) && (
                      <div className="w-8 h-8 rounded-full overflow-hidden bg-neutral-800/50 flex-shrink-0 relative">
                        <Image
                          src={getDriverImagePath(givenName, familyName)!}
                          alt={driverName}
                          width={40}
                          height={40}
                          className="object-cover object-top w-full h-full scale-125 translate-y-1"
                        />
                      </div>
                    )}
                    <div className="text-sm font-bold uppercase tracking-wide">
                      {r.Driver?.code
                        ? `${r.Driver.code.charAt(0)}. ${r.Driver.familyName}`
                        : driverName}
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4 text-xs text-neutral-300 font-bold uppercase tracking-widest">
                  {r.Constructor?.name}
                </td>
                {isQualifying ? (
                  <>
                    <td className="px-6 py-4 text-sm font-headline text-neutral-300">
                      {r.Q1 ?? "—"}
                    </td>
                    <td className="px-6 py-4 text-sm font-headline text-neutral-300">
                      {r.Q2 ?? "—"}
                    </td>
                    <td className="px-6 py-4 text-sm font-headline text-neutral-300">
                      {r.Q3 ?? "—"}
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-6 py-4 text-sm font-headline text-neutral-300">
                      {r.Time?.time ?? r.status ?? "—"}
                    </td>
                    <td className="px-6 py-4 text-right font-headline font-bold text-lg">
                      {r.points ?? "—"}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
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
  const sessions: { key: string; label: string; icon: string }[] = [
    { key: "FirstPractice", label: "Free Practice 1", icon: "tune" },
    { key: "SecondPractice", label: "Free Practice 2", icon: "build" },
    { key: "ThirdPractice", label: "Free Practice 3", icon: "construction" },
    { key: "SprintQualifying", label: "Sprint Qualifying", icon: "speed" },
    { key: "Sprint", label: "Sprint Race", icon: "bolt" },
    { key: "Qualifying", label: "Qualifying", icon: "timer" },
  ];

  const raceSessions = race as Race & Partial<Record<SessionKey, RaceSessionData>>;

  // Build the race session as well
  const raceDate = race.date
    ? new Date(
        race.time && race.time.endsWith("Z")
          ? `${race.date}T${race.time}`
          : `${race.date}T${race.time ?? "12:00:00Z"}`
      )
    : null;

  return (
    <div className="space-y-4">
      <h3 className="text-xl font-[family-name:var(--font-headline)] font-bold italic uppercase tracking-tight mb-6">
        Weekend Schedule
      </h3>

      <div className="grid gap-3">
        {sessions.map(({ key, label, icon }) => {
          const sessionData = raceSessions[key as SessionKey];
          if (!sessionData?.date) return null;

          const dt = new Date(
            sessionData.time && sessionData.time.endsWith("Z")
              ? `${sessionData.date}T${sessionData.time}`
              : `${sessionData.date}T${sessionData.time ?? "12:00:00Z"}`
          );
          const sessionPast = dt.getTime() < nowMs;

          return (
            <div
              key={key}
              className={`flex items-center justify-between p-5 transition-all ${
                sessionPast
                  ? "bg-surface-container-lowest/50 opacity-50"
                  : "glass-panel border-l-4 border-primary-container"
              }`}
            >
              <div className="flex items-center gap-4">
                <span
                  className={`material-symbols-outlined text-xl ${
                    sessionPast ? "text-neutral-600" : "text-primary-container"
                  }`}
                >
                  {icon}
                </span>
                <div>
                  <h4 className="font-[family-name:var(--font-headline)] font-bold text-lg uppercase tracking-tight">
                    {label}
                  </h4>
                  <p className="text-neutral-500 text-xs">
                    {dt.toLocaleDateString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "2-digit",
                    })}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p
                  className={`font-[family-name:var(--font-headline)] font-bold text-xl italic ${
                    sessionPast ? "text-neutral-600" : "text-primary-container"
                  }`}
                >
                  {dt.toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
                <p className="text-[10px] text-neutral-500 uppercase tracking-widest">
                  {sessionPast ? "Completed" : "Local Time"}
                </p>
              </div>
            </div>
          );
        })}

        {/* Race session itself */}
        {raceDate && (
          <div className="flex items-center justify-between p-5 bg-primary-container/10 border-l-4 border-primary-container glass-panel">
            <div className="flex items-center gap-4">
              <span className="material-symbols-outlined text-xl text-primary-container">
                flag
              </span>
              <div>
                <h4 className="font-[family-name:var(--font-headline)] font-bold text-lg uppercase tracking-tight">
                  Race
                </h4>
                <p className="text-neutral-500 text-xs">
                  {raceDate.toLocaleDateString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "2-digit",
                  })}
                </p>
              </div>
            </div>
            <div className="text-right">
              <p className="font-[family-name:var(--font-headline)] font-bold text-2xl italic text-primary-container">
                {raceDate.toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
              <p className="text-[10px] text-primary-container uppercase tracking-widest font-bold">
                Lights Out
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
