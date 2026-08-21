"use client";

import { useState } from "react";
import Image from "next/image";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronRight } from "lucide-react";
import type { DriverStanding, ConstructorStanding } from "@/lib/api";
import { getTeamColor } from "@/lib/team-colors";
import { getDriverImagePath, hasDriverImage } from "@/lib/driver-images";
import { getFlagPath } from "@/lib/flags";
import { driverPortraitFrameStyle, driverPortraitSizes } from "@/lib/driver-portrait";
import type { DriverSeasonLog, TeammateBattle } from "@/lib/season-results";
import { Stagger, StaggerItem } from "@/components/motion-primitives";
import { AnimatedNumber } from "@/components/animated-number";
import DriverModal from "@/components/driver-modal";
import DriverSeasonLogPanel from "@/components/driver-season-log";
import SeasonSelector from "@/components/season-selector";
import TeammateBattlePanel from "@/components/teammate-battle-panel";
import TitleDeciderPanel from "@/components/title-decider-panel";
import TeamCar from "@/components/team-car";

interface StandingsViewProps {
  drivers: DriverStanding[];
  constructors: ConstructorStanding[];
  /** Derived on the server — see standings/page.tsx for why. */
  teammateBattles: TeammateBattle[];
  /** Round-by-round points, keyed by `driverId`. Also server-derived. */
  seasonLogs: Record<string, DriverSeasonLog>;
  year: number;
  maxYear: number;
}

/** Shared by the row's expand animation and its chevron so the disclosure and
 * its affordance read as one movement. Matches `activity-accordion.tsx`. */
const ACCORDION_EASE = [0.23, 1, 0.32, 1] as const;

export default function StandingsView({
  drivers,
  constructors,
  teammateBattles,
  seasonLogs,
  year,
  maxYear,
}: StandingsViewProps) {
  const [tab, setTab] = useState<"drivers" | "cons">("drivers");
  // The same card-opens-a-profile behaviour `/drivers` has had all along. A
  // reader who has opened a driver from the grid learns the rows are the same
  // object, and on the championship table -- the one screen where a name is
  // most likely to be unfamiliar -- clicking it did nothing at all.
  const [selected, setSelected] = useState<DriverStanding | null>(null);
  /**
   * Which row's season log is open, by `driverId`. One at a time: twenty
   * expanded rows is a page nobody can navigate, and the comparison people
   * actually make is between a row and the table, not between two logs.
   *
   * The row *itself* is now the disclosure and the profile moved inside it,
   * rather than the row opening the modal with a separate chevron beside it.
   * A row that does two different things depending on which pixel you hit is
   * the kind of control that teaches people not to click rows at all.
   */
  const [expanded, setExpanded] = useState<string | null>(null);

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
  const reduce = useReducedMotion();

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

      {/* Title decider. Moved out of the drivers sidebar and up to full width:
          it is a statement about *both* championships, so a home that only
          exists on the drivers tab was the wrong one — the constructors tab,
          where half of what it says applies, could not see it at all. It also
          answers the question the page is being opened to answer ("is this
          still a contest?"), which belongs above the table rather than below
          two other cards at the bottom of a column. */}
      {drivers.length >= 2 && (
        <TitleDeciderPanel
          drivers={drivers}
          constructors={constructors}
          year={year}
        />
      )}

      {/* DRIVERS */}
      {tab === "drivers" && (
        // One scroll: the page's own.
        //
        // This grid has now been through three layouts. It was a page-scrolled
        // grid with a `sticky top-[88px]` sidebar, which pinned the sidebar to
        // the top and made anything past the fold of its own column
        // unreachable. The fix for that made the grid itself sticky and gave
        // each column its own `overflow-y-auto`, which traded one hidden region
        // for two: a nested scroller advertises nothing about its own length,
        // so the sidebar's lower cards and the tail of the driver list were
        // both invisible unless you happened to put the pointer in the right
        // column and scroll.
        //
        // Nested scrollers were never load-bearing here — they existed to keep
        // the sidebar in view, and the sidebar is now one card. So: no nesting,
        // no sticky, no fixed heights. The page scrolls, everything is
        // reachable by the scrollbar the reader already has, and the rows can
        // grow when one expands.
        <div
          data-standings-grid
          className="grid lg:grid-cols-[1fr_340px] gap-6 items-start"
        >
          <div data-standings-pane="drivers" className="min-w-0">
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
              const driverId = d.Driver.driverId ?? "";
              const log = seasonLogs[driverId];
              const isOpen = Boolean(driverId) && expanded === driverId;
              const panelId = `season-log-${driverId || i}`;
              const toggle = () => {
                if (!driverId) return;
                setExpanded((current) => (current === driverId ? null : driverId));
              };
              return (
                <StaggerItem
                  key={name || i}
                  className="rounded-[14px] border transition-colors"
                  style={{
                    background: leader
                      ? "rgba(255,90,31,0.12)"
                      : "rgba(40,32,26,0.32)",
                    borderColor: isOpen
                      ? "rgba(255,138,61,0.5)"
                      : leader
                        ? "rgba(255,90,31,0.4)"
                        : "rgba(255,255,255,0.07)",
                  }}
                >
                  <div
                    // `role="button"` on the row rather than a real `<button>`
                    // wrapping it: the row IS a four-column grid, and nesting
                    // that inside a button would fight the layout for no gain.
                    // Matches how `tilt-card.tsx` makes the `/drivers` cards
                    // activate, keyboard handler included.
                    role="button"
                    tabIndex={0}
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    aria-label={`${name || "Driver"} — show race-by-race season`}
                    onClick={toggle}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggle();
                      }
                    }}
                    // Tighter gaps and a smaller points figure below `sm`. The
                    // disclosure adds a column, and on a 390px phone that
                    // column comes straight out of the name — which is the one
                    // thing in the row that must stay readable. Reclaiming it
                    // from the gutters and from two points digits costs
                    // nothing.
                    className="grid grid-cols-[36px_1fr_auto_auto] sm:grid-cols-[44px_1fr_70px_90px_auto] gap-2.5 sm:gap-4 items-center px-3.5 sm:px-5 py-[14px] rounded-[14px] cursor-pointer hover:bg-white/[0.03] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(255,138,61,0.6)]"
                  >
                    <span
                      className="font-extrabold text-lg tabular-nums"
                      style={{ color: leader ? "#FFAE6A" : "#8f867a" }}
                    >
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <div className="flex items-center gap-2.5 sm:gap-[14px] min-w-0">
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
                        className={`font-extrabold text-xl sm:text-2xl tabular-nums ${
                          leader ? "text-[#FFAE6A]" : "text-[#f6f1ea]"
                        }`}
                      />
                      <span className="font-semibold text-[9px] text-warm-500">
                        PTS
                      </span>
                    </div>
                    {/* The disclosure affordance. A bare chevron on its own was
                        not enough of a promise -- it could mean "expand" or
                        "navigate" -- so from `sm` up it is labelled with the
                        round count, which is both what is behind it and a
                        reason to look. Below `sm` the label is dropped and the
                        chevron carries it, because at that width the row is
                        already down to three visible columns.

                        `aria-hidden`: the whole row is one control and already
                        announces its expanded state, so this must not be read
                        out as a second thing to press. */}
                    <div
                      aria-hidden
                      className="flex items-center gap-1.5 justify-end text-warm-500"
                    >
                      {log && log.entries.length > 0 && (
                        <span className="hidden md:inline font-semibold text-[9px] tracking-[0.1em] uppercase whitespace-nowrap">
                          {log.entries.length} rounds
                        </span>
                      )}
                      <motion.span
                        className="flex items-center justify-center w-5 h-5 sm:w-6 sm:h-6 rounded-md bg-white/[0.05]"
                        animate={{ rotate: isOpen ? 90 : 0 }}
                        transition={{ duration: reduce ? 0 : 0.22, ease: ACCORDION_EASE }}
                        style={{ color: isOpen ? "#FFAE6A" : undefined }}
                      >
                        <ChevronRight size={15} />
                      </motion.span>
                    </div>
                  </div>

                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div
                        id={panelId}
                        key="log"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{
                          height: 0,
                          opacity: 0,
                          // On the variant, not the shared `transition` prop:
                          // an exiting element keeps the props it had while
                          // visible, so a ternary up there resolves to the
                          // enter duration. Same trap as activity-accordion.
                          transition: {
                            height: { duration: reduce ? 0 : 0.18, ease: ACCORDION_EASE },
                            opacity: { duration: reduce ? 0 : 0.1, ease: ACCORDION_EASE },
                          },
                        }}
                        transition={{
                          height: { duration: reduce ? 0 : 0.26, ease: ACCORDION_EASE },
                          opacity: { duration: reduce ? 0 : 0.16, ease: ACCORDION_EASE },
                        }}
                        className="overflow-hidden"
                      >
                        <div className="px-4 sm:px-5 pb-3 border-t border-white/[0.07]">
                          <DriverSeasonLogPanel
                            log={log}
                            color={color}
                            championshipPoints={Number(d.points) || 0}
                            onOpenProfile={() => setSelected(d)}
                          />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </StaggerItem>
              );
            })}
            </Stagger>
          </div>

          {/* Sidebar. The constructor-battle card that used to head this column
              is gone: it was the top five of the Constructors tab, drawn as
              bars instead of rows, one click away on the same page. Two
              renderings of one dataset side by side is not redundancy the
              reader benefits from — it is a second thing to check against the
              first. The tab is the canonical view and now the only one.

              `space-y`, not `flex flex-col gap`: this column has been a fixed
              height before, and a flex column with one shrinks its children to
              fit rather than overflowing, silently clipping each card's own
              `overflow-hidden` contents. */}
          <div data-standings-pane="sidebar" className="space-y-6 min-w-0">
            <TeammateBattlePanel battles={teammateBattles} />
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
                className="relative px-5 sm:px-6 py-5 rounded-2xl overflow-hidden border isolate"
                style={{
                  background: leader
                    ? "rgba(255,90,31,0.1)"
                    : "rgba(40,32,26,0.3)",
                  borderColor: leader
                    ? "rgba(255,90,31,0.35)"
                    : "rgba(255,255,255,0.07)",
                }}
              >
                {/* The car, dissolving in from the right.
                    This tab was the plainest surface in the app — eleven
                    near-identical bars whose only distinguishing feature was a
                    colour. The livery is what people actually recognise a team
                    by, so it now does that job, from the right where the row
                    has nothing but a points figure.

                    Hidden below `sm`: at phone width the car would run under
                    the points, which is the one number the row exists to
                    state.

                    `right-[212px]` for the same reason at desktop width. The
                    wins and points columns are 80px + 100px with a 16px gutter
                    and 24px of padding beyond them; anchored flush right the
                    car's rear wing sat directly behind the win count. Stopping
                    it short of that band keeps every figure on plain
                    background and leaves the car in the dead space the row
                    always had between the team name and its numbers. */}
                <TeamCar
                  team={name}
                  variant="ghost-right"
                  opacity={0.22}
                  sizes="(min-width: 1024px) 460px, 50vw"
                  className="hidden sm:block absolute -z-10 right-[232px] top-1 bottom-1 w-[40%]"
                />
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
