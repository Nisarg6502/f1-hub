"use client";

import { useState } from "react";
import Image from "next/image";
import { AnimatePresence, motion } from "motion/react";
import type { DriverStanding, ConstructorStanding } from "@/lib/api";
import { getTeamColor } from "@/lib/team-colors";
import { getDriverImagePath, hasDriverImage } from "@/lib/driver-images";
import { getFlagPath } from "@/lib/flags";
import { driverPortraitFrameStyle, driverPortraitSizes } from "@/lib/driver-portrait";
import type { TeammateBattle } from "@/lib/season-results";
import { Stagger, StaggerItem } from "@/components/motion-primitives";
import { AnimatedNumber } from "@/components/animated-number";
import DriverModal from "@/components/driver-modal";
import SeasonSelector from "@/components/season-selector";
import TeammateBattlePanel from "@/components/teammate-battle-panel";
import TitleDeciderPanel from "@/components/title-decider-panel";

interface StandingsViewProps {
  drivers: DriverStanding[];
  constructors: ConstructorStanding[];
  /** Derived on the server — see standings/page.tsx for why. */
  teammateBattles: TeammateBattle[];
  year: number;
  maxYear: number;
}

export default function StandingsView({
  drivers,
  constructors,
  teammateBattles,
  year,
  maxYear,
}: StandingsViewProps) {
  const [tab, setTab] = useState<"drivers" | "cons">("drivers");
  // The same card-opens-a-profile behaviour `/drivers` has had all along. A
  // reader who has opened a driver from the grid learns the rows are the same
  // object, and on the championship table -- the one screen where a name is
  // most likely to be unfamiliar -- clicking it did nothing at all.
  const [selected, setSelected] = useState<DriverStanding | null>(null);

  const selectedId = selected?.Driver.driverId ?? null;
  const selectedColor = selected
    ? getTeamColor(selected.Constructors?.[0]?.name ?? "—")
    : null;
  const selectedImgPath =
    selected && hasDriverImage(selected.Driver.givenName, selected.Driver.familyName)
      ? getDriverImagePath(selected.Driver.givenName, selected.Driver.familyName)
      : null;
  const selectedFlagSrc = selected ? getFlagPath(selected.Driver.nationality) : null;

  const maxConsPts = constructors.length ? Number(constructors[0].points) || 1 : 1;

  return (
    <div className="px-6 md:px-10 pt-11 pb-16">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6 mb-7">
        <div>
          <span className="font-bold text-xs tracking-[0.18em] uppercase text-[#FF7A3D]">
            Season {year} · Championship
          </span>
          {/* An `h1`, not a styled div — the last two routes without one.
              Classes unchanged, so nothing moves. */}
          <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-4xl md:text-[52px] tracking-[-1.5px] mt-2">
            Championship
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-1.5 apex-glass-soft rounded-xl p-[5px] w-fit">
            {(
              [
                ["drivers", "Drivers"],
                ["cons", "Constructors"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`relative text-xs px-5 py-[9px] rounded-lg transition-[color,transform] duration-150 active:scale-[0.97] ${
                  tab === key
                    ? "font-bold text-[#FFAE6A]"
                    : "font-semibold text-warm-300 hover:text-on-background"
                }`}
              >
                {tab === key && (
                  <motion.span
                    layoutId="standings-tab-pill"
                    className="absolute inset-0 rounded-lg bg-[rgba(255,90,31,0.18)]"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  />
                )}
                <span className="relative z-10">{label}</span>
              </button>
            ))}
          </div>
          <SeasonSelector currentYear={year} maxYear={maxYear} />
        </div>
      </div>

      {/* DRIVERS */}
      {tab === "drivers" && (
        // Two independent scroll panes from `lg` up. The sidebar used to be
        // `sticky top-[88px]` inside a page-scrolled grid, which pins it to the
        // top and makes anything past the fold of its own column unreachable --
        // you could only ever scroll the page, i.e. the left column. Now the
        // grid itself is the sticky element (the page still scrolls its header
        // and footer past it) and each column owns its own overflow, so the two
        // scroll disjointly. `overscroll-contain` stops a column that has hit
        // its end from handing the wheel back to the page mid-gesture.
        //
        // 88px = the 76px sticky nav plus 12px of air; the 116px subtracted
        // from the viewport height is that plus a matching gap at the bottom.
        // Both are literals because Tailwind cannot see a computed class name.
        <div
          data-standings-grid
          className="grid lg:grid-cols-[1fr_340px] gap-6 items-start lg:sticky lg:top-[88px] lg:h-[calc(100vh-116px)]"
        >
          <div
            data-standings-pane="drivers"
            className="lg:h-full lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:pr-2"
          >
            <Stagger className="flex flex-col gap-2" gap={0.035}>
            {drivers.length === 0 && <EmptyRow label="No driver standings yet" />}
            {drivers.map((d, i) => {
              const name = `${d.Driver.givenName ?? ""} ${
                d.Driver.familyName ?? ""
              }`.trim();
              const team = d.Constructors?.[0]?.name ?? "—";
              const color = getTeamColor(team);
              const leader = i === 0;
              const hasImg = hasDriverImage(d.Driver.givenName, d.Driver.familyName);
              const imgPath = hasImg
                ? getDriverImagePath(d.Driver.givenName, d.Driver.familyName)
                : null;
              return (
                <StaggerItem
                  key={name || i}
                  // `role="button"` on the row rather than a real `<button>`
                  // wrapping it: the row IS a four-column grid, and nesting
                  // that inside a button would fight the layout for no gain.
                  // Matches how `tilt-card.tsx` makes the `/drivers` cards
                  // activate, keyboard handler included.
                  role="button"
                  tabIndex={0}
                  aria-label={`View ${name || "driver"}'s profile`}
                  onClick={() => setSelected(d)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelected(d);
                    }
                  }}
                  className="grid grid-cols-[40px_1fr_auto] sm:grid-cols-[44px_1fr_70px_90px] gap-3 sm:gap-4 items-center px-4 sm:px-5 py-[14px] rounded-[14px] border transition-colors cursor-pointer hover:border-[rgba(255,138,61,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(255,138,61,0.6)]"
                  style={{
                    background: leader
                      ? "rgba(255,90,31,0.12)"
                      : "rgba(40,32,26,0.32)",
                    borderColor: leader
                      ? "rgba(255,90,31,0.4)"
                      : "rgba(255,255,255,0.07)",
                  }}
                >
                  <span
                    className="font-extrabold text-lg tabular-nums"
                    style={{ color: leader ? "#FFAE6A" : "#8f867a" }}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div className="flex items-center gap-[14px] min-w-0">
                    <span
                      className="w-1 h-[34px] rounded-[3px] flex-none"
                      style={{
                        background: color.hex,
                        boxShadow: `0 0 10px ${color.glow}`,
                      }}
                    />
                    <div className="relative w-9 h-9 rounded-[9px] overflow-hidden flex-none bg-[rgba(245,235,222,0.06)]">
                      {imgPath ? (
                        <div style={driverPortraitFrameStyle("face")}>
                          <Image
                            src={imgPath}
                            alt={name}
                            fill
                            sizes={driverPortraitSizes(36, "face")}
                            className="object-cover"
                          />
                        </div>
                      ) : (
                        <div className="absolute inset-0 apex-hatch" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="font-bold text-base truncate">
                        {name || "—"}
                      </div>
                      <div className="font-semibold text-[11px] tracking-[0.04em] uppercase text-warm-400 truncate">
                        {team}
                      </div>
                    </div>
                  </div>
                  <div className="hidden sm:block text-center">
                    <div className="font-bold text-[15px] tabular-nums">
                      {d.wins}
                    </div>
                    <div className="font-semibold text-[9px] tracking-[0.1em] uppercase text-warm-500">
                      wins
                    </div>
                  </div>
                  <div className="text-right flex items-baseline gap-[5px] justify-end">
                    <AnimatedNumber
                      value={Number(d.points) || 0}
                      className={`font-extrabold text-2xl tabular-nums ${
                        leader ? "text-[#FFAE6A]" : "text-[#f6f1ea]"
                      }`}
                    />
                    <span className="font-semibold text-[9px] text-warm-500">
                      PTS
                    </span>
                  </div>
                </StaggerItem>
              );
            })}
            </Stagger>
          </div>

          {/* Sidebar: constructor battle + teammate battle */}
          {/* `space-y`, not `flex flex-col gap`: a flex column with a fixed
              height shrinks its children to fit instead of overflowing, so the
              cards silently compressed (and clipped their own contents, each
              being `overflow-hidden`) and the pane never became scrollable at
              all -- scrollHeight came back exactly equal to clientHeight. */}
          <div
            data-standings-pane="sidebar"
            className="space-y-6 lg:h-full lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:pr-1"
          >
            <div className="apex-glass apex-sheen rounded-[20px] p-6 overflow-hidden">
              <div className="relative">
                <span className="font-bold text-xs tracking-[0.12em] uppercase text-[#FF7A3D]">
                  Constructor battle
                </span>
                <div className="mt-5 flex flex-col gap-[18px]">
                  {constructors.slice(0, 5).map((c) => {
                    const name = c.Constructor.name ?? "—";
                    const color = getTeamColor(name);
                    const pct = (Number(c.points) / maxConsPts) * 100;
                    return (
                      <div key={name}>
                        <div className="flex justify-between mb-[7px]">
                          <span className="font-bold text-[13px]">{name}</span>
                          <span className="font-bold text-sm tabular-nums">
                            {c.points}
                          </span>
                        </div>
                        <div className="h-[7px] bg-white/[0.06] rounded overflow-hidden">
                          <div
                            className="h-full rounded anim-bar"
                            style={{ width: `${pct}%`, background: color.hex }}
                          />
                        </div>
                      </div>
                    );
                  })}
                  {constructors.length === 0 && (
                    <span className="font-medium text-xs text-warm-400">
                      No constructor data yet
                    </span>
                  )}
                </div>
              </div>
            </div>

            <TeammateBattlePanel battles={teammateBattles} />

            {drivers.length >= 2 && (
              <TitleDeciderPanel
                drivers={drivers}
                constructors={constructors}
                year={year}
              />
            )}
          </div>
        </div>
      )}

      <AnimatePresence>
        {selected && selectedColor && (
          <DriverModal
            key={selectedId}
            driver={selected}
            imgPath={selectedImgPath}
            flagSrc={selectedFlagSrc}
            color={selectedColor}
            onClose={() => setSelected(null)}
          />
        )}
      </AnimatePresence>

      {/* CONSTRUCTORS */}
      {tab === "cons" && (
        <Stagger className="flex flex-col gap-2.5" gap={0.04}>
          {constructors.length === 0 && (
            <EmptyRow label="No constructor standings yet" />
          )}
          {constructors.map((c, i) => {
            const name = c.Constructor.name ?? "—";
            const color = getTeamColor(name);
            const leader = i === 0;
            const pct = (Number(c.points) / maxConsPts) * 100;
            return (
              <StaggerItem
                key={name || i}
                className="relative px-5 sm:px-6 py-5 rounded-2xl overflow-hidden border"
                style={{
                  background: leader
                    ? "rgba(255,90,31,0.1)"
                    : "rgba(40,32,26,0.3)",
                  borderColor: leader
                    ? "rgba(255,90,31,0.35)"
                    : "rgba(255,255,255,0.07)",
                }}
              >
                <div className="grid grid-cols-[40px_1fr_auto] sm:grid-cols-[44px_1fr_80px_100px] gap-3 sm:gap-4 items-center">
                  <span
                    className="font-extrabold text-lg tabular-nums"
                    style={{ color: leader ? "#FFAE6A" : "#8f867a" }}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div className="flex items-center gap-[14px] min-w-0">
                    <span
                      className="w-1.5 h-8 rounded-[3px] flex-none"
                      style={{
                        background: color.hex,
                        boxShadow: `0 0 10px ${color.glow}`,
                      }}
                    />
                    <div className="min-w-0">
                      <div className="font-bold text-[17px] truncate">{name}</div>
                      <div className="font-semibold text-[11px] tracking-[0.04em] uppercase text-warm-400 truncate">
                        {c.Constructor.nationality}
                      </div>
                    </div>
                  </div>
                  <div className="hidden sm:block text-center">
                    <div className="font-bold text-[15px] tabular-nums">
                      {c.wins}
                    </div>
                    <div className="font-semibold text-[9px] tracking-[0.1em] uppercase text-warm-500">
                      wins
                    </div>
                  </div>
                  <div className="text-right flex items-baseline gap-[5px] justify-end">
                    <AnimatedNumber
                      value={Number(c.points) || 0}
                      className={`font-extrabold text-2xl tabular-nums ${
                        leader ? "text-[#FFAE6A]" : "text-[#f6f1ea]"
                      }`}
                    />
                    <span className="font-semibold text-[9px] text-warm-500">
                      PTS
                    </span>
                  </div>
                </div>
                <div className="mt-[14px] h-1.5 bg-white/[0.05] rounded overflow-hidden">
                  <div
                    className="h-full rounded anim-bar"
                    style={{
                      width: `${pct}%`,
                      background: `linear-gradient(90deg, ${color.hex}, ${color.hex}88)`,
                    }}
                  />
                </div>
              </StaggerItem>
            );
          })}
        </Stagger>
      )}
    </div>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <div className="apex-glass-soft rounded-[14px] px-5 py-8 text-center font-medium text-sm text-warm-400">
      {label}
    </div>
  );
}
