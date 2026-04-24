"use client";

import { useState } from "react";
import Image from "next/image";
import type { DriverStanding, ConstructorStanding } from "@/lib/api";
import { getDriverImagePath, hasDriverImage } from "@/lib/driver-images";
import { getFlagPath } from "@/lib/flags";

const teamColors: Record<string, string> = {
  "Red Bull": "bg-blue-600",
  McLaren: "bg-orange-500",
  Ferrari: "bg-red-600",
  Mercedes: "bg-teal-500",
  "Aston Martin": "bg-green-600",
  "Alpine F1 Team": "bg-pink-500",
  Williams: "bg-blue-400",
  "RB F1 Team": "bg-blue-500",
  "Kick Sauber": "bg-green-500",
  "Haas F1 Team": "bg-neutral-400",
};

const teamGradients: Record<string, string> = {
  "Red Bull": "from-blue-900 to-blue-700",
  McLaren: "from-orange-600 to-orange-400",
  Ferrari: "from-red-900 to-red-600",
  Mercedes: "from-cyan-900 to-cyan-500",
  "Aston Martin": "from-green-900 to-green-500",
  "Alpine F1 Team": "from-pink-900 to-pink-500",
  Williams: "from-blue-800 to-blue-400",
  "RB F1 Team": "from-blue-800 to-blue-500",
  "Kick Sauber": "from-green-800 to-green-400",
  "Haas F1 Team": "from-neutral-700 to-neutral-400",
};

function getTeamColor(name?: string) {
  if (!name) return "bg-neutral-500";
  const key = Object.keys(teamColors).find((k) =>
    name.toLowerCase().includes(k.toLowerCase())
  );
  return key ? teamColors[key] : "bg-neutral-500";
}

function getTeamGradient(name?: string) {
  if (!name) return "from-neutral-700 to-neutral-500";
  const key = Object.keys(teamGradients).find((k) =>
    name.toLowerCase().includes(k.toLowerCase())
  );
  return key ? teamGradients[key] : "from-neutral-700 to-neutral-500";
}

interface StandingsViewProps {
  drivers: DriverStanding[];
  constructors: ConstructorStanding[];
  year: number;
}

export default function StandingsView({
  drivers,
  constructors,
  year,
}: StandingsViewProps) {
  const [activeTab, setActiveTab] = useState<"drivers" | "constructors">(
    "drivers"
  );

  const maxDriverPts = drivers.length ? Number(drivers[0].points) : 1;
  const maxConstructorPts = constructors.length
    ? Number(constructors[0].points)
    : 1;

  return (
    <div className="px-4 md:px-12 max-w-[1600px] mx-auto pt-4 pb-20">
      {/* Header */}
      <header className="mb-12 relative">
        <div className="absolute -left-12 top-0 w-1 h-24 bg-primary-container shadow-[0_0_15px_#00f2ff]" />
        <h1 className="text-6xl md:text-8xl font-black font-[family-name:var(--font-headline)] italic skew-x-[-12deg] tracking-tighter uppercase leading-none">
          World{" "}
          <span className="text-primary-container">Championship</span>
          <br />
          <span className="text-neutral-700">Standings</span>
        </h1>
        <div className="flex items-center mt-6 gap-4">
          <span className="flex items-center bg-tertiary-container/10 border border-tertiary-container/30 px-3 py-1 text-[10px] font-[family-name:var(--font-label)] font-bold text-tertiary-container tracking-widest uppercase">
            <span className="w-2 h-2 bg-tertiary-container rounded-full animate-pulse mr-2" />
            LIVE DATA FEEDS
          </span>
          <span className="text-neutral-500 font-[family-name:var(--font-label)] text-[10px] tracking-widest uppercase">
            Season {year}
          </span>
        </div>
      </header>

      {/* Tab Navigation */}
      <div className="flex space-x-1 mb-8 bg-surface-container-lowest p-1 w-fit">
        <button
          onClick={() => setActiveTab("drivers")}
          className={`px-8 py-3 font-[family-name:var(--font-headline)] font-bold text-lg skew-x-[-12deg] transition-all ${
            activeTab === "drivers"
              ? "bg-surface-container-highest text-primary-container"
              : "text-neutral-500 hover:text-neutral-200"
          }`}
        >
          <span className="inline-block skew-x-[12deg]">DRIVERS</span>
        </button>
        <button
          onClick={() => setActiveTab("constructors")}
          className={`px-8 py-3 font-[family-name:var(--font-headline)] font-bold text-lg skew-x-[-12deg] transition-all ${
            activeTab === "constructors"
              ? "bg-surface-container-highest text-secondary-container"
              : "text-neutral-500 hover:text-neutral-200"
          }`}
        >
          <span className="inline-block skew-x-[12deg]">CONSTRUCTORS</span>
        </button>
      </div>

      {/* DRIVERS TAB */}
      {activeTab === "drivers" && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div className="lg:col-span-8 space-y-4">
            {/* Table Header */}
            <div className="grid grid-cols-12 px-6 py-2 text-[10px] font-[family-name:var(--font-label)] font-bold text-neutral-500 tracking-widest uppercase">
              <div className="col-span-1">RK</div>
              <div className="col-span-5">DRIVER / TEAM</div>
              <div className="col-span-2 text-center">WINS</div>
              <div className="col-span-4 text-right">PTS</div>
            </div>

            <div className="space-y-3">
              {drivers.map((row, idx) => {
                const givenName = row.Driver.givenName ?? "";
                const familyName = row.Driver.familyName ?? "";
                const driverName = `${givenName} ${familyName}`.trim();
                const teamName = row.Constructors?.[0]?.name ?? "—";
                const teamColor = getTeamColor(teamName);
                const isLeader = idx === 0;
                const imgPath = getDriverImagePath(givenName, familyName);
                const hasImg = hasDriverImage(givenName, familyName);
                const driverNum = row.Driver.permanentNumber ?? "";

                return (
                  <div
                    key={driverName || idx}
                    className={`group relative grid grid-cols-12 items-center px-6 py-4 glass-panel transition-all hover:bg-surface-container-highest hover:translate-x-2 overflow-hidden ${
                      isLeader
                        ? "border-l-4 border-primary-container"
                        : `border-l-4 ${teamColor.replace("bg-", "border-")}`
                    }`}
                  >
                    {/* Background number */}
                    <span className="absolute right-6 top-1/2 -translate-y-1/2 font-[family-name:var(--font-headline)] font-black text-6xl italic text-white/[0.03] select-none pointer-events-none group-hover:text-white/[0.06] transition-all">
                      {driverNum}
                    </span>

                    <div
                      className={`col-span-1 font-[family-name:var(--font-headline)] font-black text-2xl italic ${
                        isLeader ? "text-primary-container" : "text-neutral-400"
                      }`}
                    >
                      {String(idx + 1).padStart(2, "0")}
                    </div>
                    <div className="col-span-5 flex items-center gap-4">
                      <div className="w-12 h-12 rounded-full overflow-hidden bg-neutral-800/60 flex items-center justify-center relative flex-shrink-0">
                        {hasImg && imgPath ? (
                          <Image
                            src={imgPath}
                            alt={driverName}
                            width={80}
                            height={80}
                            className="object-cover object-[center_15%] w-full h-full"
                          />
                        ) : (
                          <span className="material-symbols-outlined text-neutral-600">
                            person
                          </span>
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-[family-name:var(--font-headline)] font-bold text-xl uppercase leading-tight tracking-tight">
                            {driverName || "—"}
                          </h3>
                          {(() => {
                            const flagSrc = getFlagPath(row.Driver.nationality);
                            return flagSrc ? (
                              <Image
                                src={flagSrc}
                                alt={row.Driver.nationality ?? ""}
                                width={20}
                                height={14}
                                className="object-contain opacity-70"
                              />
                            ) : null;
                          })()}
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="w-24 h-1 bg-neutral-700 mt-1 overflow-hidden">
                            <div
                              className={`h-full ${teamColor} w-full`}
                            />
                          </div>
                          <span className="text-[9px] font-[family-name:var(--font-label)] font-bold text-neutral-400">
                            {teamName.toUpperCase()}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="col-span-2 text-center font-[family-name:var(--font-headline)] font-bold text-xl text-neutral-300">
                      {row.wins}
                    </div>
                    <div className="col-span-4 text-right">
                      <span
                        className={`font-[family-name:var(--font-headline)] font-black text-3xl italic skew-x-[-12deg] ${
                          isLeader
                            ? "text-primary-container drop-shadow-[0_0_10px_#00f2ff]"
                            : "text-neutral-200"
                        }`}
                      >
                        {row.points}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Quick Constructor Summary on Driver Tab */}
          <div className="lg:col-span-4 space-y-6">
            <div className="bg-surface-container-low p-6 border-t-2 border-secondary-container neon-glow-pink">
              <h2 className="font-[family-name:var(--font-headline)] font-black italic skew-x-[-10deg] text-2xl text-secondary-container mb-6 tracking-tighter uppercase">
                Team Dominance
              </h2>
              <div className="space-y-6">
                {constructors.slice(0, 5).map((row, idx) => {
                  const name = row.Constructor.name ?? "—";
                  const pts = Number(row.points);
                  const widthPct = (pts / maxConstructorPts) * 100;
                  const gradient = getTeamGradient(name);
                  const diff = pts - maxConstructorPts;

                  return (
                    <div key={name} className="space-y-2">
                      <div className="flex justify-between items-end">
                        <span className="font-[family-name:var(--font-headline)] font-bold text-lg uppercase tracking-tighter">
                          {name}
                        </span>
                        <span
                          className={`font-[family-name:var(--font-headline)] font-black text-xl ${
                            idx === 0
                              ? "text-secondary-container"
                              : "text-neutral-400"
                          }`}
                        >
                          {row.points}
                        </span>
                      </div>
                      <div className="h-4 bg-surface-container-highest skew-x-[-12deg] overflow-hidden">
                        <div
                          className={`h-full bg-gradient-to-r ${gradient} relative`}
                          style={{ width: `${widthPct}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-[10px] font-[family-name:var(--font-label)] font-bold text-neutral-500 tracking-widest">
                        <span>
                          {row.Constructor.nationality?.toUpperCase()}
                        </span>
                        {idx === 0 ? (
                          <span>LEADER</span>
                        ) : (
                          <span className="text-secondary-container">
                            {diff} PTS
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* CONSTRUCTORS TAB */}
      {activeTab === "constructors" && (
        <div className="space-y-4">
          {/* Table Header */}
          <div className="grid grid-cols-12 px-6 py-2 text-[10px] font-[family-name:var(--font-label)] font-bold text-neutral-500 tracking-widest uppercase">
            <div className="col-span-1">RK</div>
            <div className="col-span-5">CONSTRUCTOR</div>
            <div className="col-span-2 text-center">WINS</div>
            <div className="col-span-4 text-right">PTS</div>
          </div>

          <div className="space-y-3">
            {constructors.map((row, idx) => {
              const name = row.Constructor.name ?? "—";
              const teamColor = getTeamColor(name);
              const gradient = getTeamGradient(name);
              const isLeader = idx === 0;
              const pts = Number(row.points);
              const barWidth =
                maxConstructorPts > 0 ? (pts / maxConstructorPts) * 100 : 0;

              return (
                <div
                  key={name || idx}
                  className={`group relative overflow-hidden glass-panel transition-all hover:bg-surface-container-highest hover:translate-x-2 ${
                    isLeader
                      ? "border-l-4 border-secondary-container"
                      : `border-l-4 ${teamColor.replace("bg-", "border-")}`
                  }`}
                >
                  <div className="grid grid-cols-12 items-center px-6 py-5">
                    <div
                      className={`col-span-1 font-[family-name:var(--font-headline)] font-black text-2xl italic ${
                        isLeader
                          ? "text-secondary-container"
                          : "text-neutral-400"
                      }`}
                    >
                      {String(idx + 1).padStart(2, "0")}
                    </div>
                    <div className="col-span-5">
                      <h3 className="font-[family-name:var(--font-headline)] font-bold text-xl uppercase leading-tight tracking-tight">
                        {name}
                      </h3>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[9px] font-[family-name:var(--font-label)] font-bold text-neutral-500 uppercase tracking-widest">
                          {row.Constructor.nationality}
                        </span>
                      </div>
                    </div>
                    <div className="col-span-2 text-center font-[family-name:var(--font-headline)] font-bold text-xl text-neutral-300">
                      {row.wins}
                    </div>
                    <div className="col-span-4 text-right">
                      <span
                        className={`font-[family-name:var(--font-headline)] font-black text-3xl italic skew-x-[-12deg] ${
                          isLeader
                            ? "text-secondary-container drop-shadow-[0_0_10px_#b600f8]"
                            : "text-neutral-200"
                        }`}
                      >
                        {row.points}
                      </span>
                    </div>
                  </div>
                  {/* Progress bar across bottom */}
                  <div className="h-1 bg-surface-container-highest">
                    <div
                      className={`h-full bg-gradient-to-r ${gradient}`}
                      style={{ width: `${barWidth}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
