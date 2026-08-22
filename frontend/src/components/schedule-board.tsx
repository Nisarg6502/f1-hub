"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion, type Variants } from "motion/react";
import { EASE_OUT, Stagger } from "./motion-primitives";
import FlagImg from "./flag-img";
import SeasonSelector from "./season-selector";
import LocalDateTime from "./local-datetime";

// Rows fade+rise in; completed rows settle at a dimmed rest opacity (the
// `custom` boolean drives it) so the cascade doesn't leave them fully lit.
const rowVariants: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: (dim: boolean) => ({
    opacity: dim ? 0.62 : 1,
    y: 0,
    transition: { duration: 0.45, ease: EASE_OUT },
  }),
};

export interface ScheduleRow {
  round: string;
  season: string;
  /**
   * Pre-formatted fallback, used only until the client can format the real
   * one. See `dateMs`.
   */
  dateLabel: string;
  /**
   * The race start as a timestamp, so the date can be formatted in the
   * READER's timezone rather than the server's.
   *
   * `dateLabel` was formatted on the server with
   * `toLocaleDateString(undefined, ...)`, where `undefined` resolves to the
   * container's locale -- UTC on Cloud Run -- and then passed down as a string.
   * That is the same bug `local-datetime.tsx` exists to prevent, reintroduced
   * by going through a prop instead of the component. It matters most at
   * exactly the races people ask about: Las Vegas starts on a Saturday
   * evening local time and a Sunday in UTC, so the schedule showed the wrong
   * DAY.
   *
   * Optional so a row without a known start time still renders its "TBC".
   */
  dateMs?: number | null;
  name: string;
  circuit: string;
  locality: string;
  country: string;
  flagSrc: string | null;
  status: "completed" | "next" | "upcoming";
  isSprint: boolean;
  winner?: {
    givenName: string;
    familyName: string;
    code: string;
  };
}

interface ScheduleBoardProps {
  year: number;
  maxYear: number;
  rows: ScheduleRow[];
  nextTargetMs: number | null;
  nextName: string | null;
  nextCircuit: string | null;
  nextLocality: string | null;
  initialPhase?: "upcoming" | "completed";
}

function badgeFor(row: ScheduleRow) {
  if (row.status === "next")
    return { label: "Next race", bg: "rgba(255,90,31,0.2)", color: "var(--color-primary)" };
  if (row.status === "completed")
    return { label: "Completed", bg: "rgba(245,235,222,0.06)", color: "var(--color-warm-400)" };
  if (row.isSprint)
    return { label: "Sprint", bg: "rgba(255,138,61,0.16)", color: "var(--color-primary)" };
  return { label: "Upcoming", bg: "rgba(245,235,222,0.06)", color: "#c9c0b4" };
}

export default function ScheduleBoard({
  year,
  maxYear,
  rows,
  nextTargetMs,
  nextName,
  nextCircuit,
  nextLocality,
  initialPhase = "upcoming",
}: ScheduleBoardProps) {
  const [phase, setPhase] = useState<"upcoming" | "completed">(initialPhase);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const shown = rows.filter((r) =>
    phase === "completed" ? r.status === "completed" : r.status !== "completed"
  );

  const diff = nextTargetMs ? Math.max(nextTargetMs - now, 0) : 0;
  const dd = String(Math.floor(diff / 86400000)).padStart(2, "0");
  const hh = String(Math.floor(diff / 3600000) % 24).padStart(2, "0");

  return (
    <div className="px-6 md:px-10 pt-11 pb-16">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-5 mb-8">
        <div>
          <span className="font-bold text-xs tracking-[0.18em] uppercase text-flame">
            {year} FIA Formula One World Championship
          </span>
          {/* An `h1`, not a styled div — see the note on the home page hero.
              Classes unchanged, so nothing moves. */}
          <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-4xl md:text-[52px] tracking-[-1.5px] mt-2">
            Race Calendar
          </h1>
        </div>
        <SeasonSelector currentYear={year} maxYear={maxYear} />
      </div>

      <div className="grid lg:grid-cols-[280px_1fr] gap-7 items-start">
        {/* Sidebar */}
        <div className="lg:sticky lg:top-[88px] flex flex-col gap-4">
          <div className="flex gap-1.5 apex-glass-soft rounded-tile p-1.5">
            {(
              [
                ["upcoming", "Upcoming"],
                ["completed", "Completed"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setPhase(key)}
                className={`relative flex-1 text-center text-xs py-2.5 rounded-control transition-[color,transform] duration-150 active:scale-[0.97] ${
                  phase === key
                    ? "font-bold text-primary"
                    : "font-semibold text-warm-300 hover:text-on-background"
                }`}
              >
                {phase === key && (
                  <motion.span
                    layoutId="sched-phase-pill"
                    className="absolute inset-0 rounded-control bg-[rgba(255,90,31,0.18)]"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  />
                )}
                <span className="relative z-10">{label}</span>
              </button>
            ))}
          </div>

          {nextTargetMs !== null && nextName && (
            <div className="apex-glass apex-sheen rounded-card p-[22px] overflow-hidden">
              <div className="relative">
                <span className="font-bold text-[11px] tracking-[0.12em] uppercase text-flame">
                  Next event
                </span>
                <div className="font-[family-name:var(--font-headline)] font-bold text-xl mt-2.5 mb-1">
                  {nextName.replace(" Grand Prix", " GP")}
                </div>
                <div className="font-semibold text-xs text-warm-400 mb-4">
                  {[nextCircuit, nextLocality].filter(Boolean).join(" · ")}
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="font-extrabold text-[40px] tabular-nums text-primary">
                    {dd}
                  </span>
                  <span className="font-semibold text-[11px] text-warm-500">
                    days
                  </span>
                  <span className="font-extrabold text-[40px] tabular-nums ml-2">
                    {hh}
                  </span>
                  <span className="font-semibold text-[11px] text-warm-500">
                    hrs
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Rounds list — keyed on phase so the cascade replays on each toggle */}
        <Stagger key={phase} className="flex flex-col gap-3" gap={0.045}>
          {shown.length === 0 && (
            <div className="apex-glass-soft rounded-2xl px-6 py-10 text-center font-medium text-warm-400">
              {phase === "completed"
                ? "No completed rounds yet."
                : "No upcoming rounds."}
            </div>
          )}
          {shown.map((r) => {
            const badge = badgeFor(r);
            return (
              <motion.div
                key={`${r.round}-${r.name}`}
                variants={rowVariants}
                custom={r.status === "completed"}
              >
              <Link
                href={`/schedule/${r.season}/${r.round}`}
                className="grid grid-cols-[84px_1fr_auto] sm:grid-cols-[96px_40px_1fr_auto] gap-3 sm:gap-5 items-center px-4 sm:px-[22px] py-5 rounded-2xl border transition-[border-color,background-color,transform] duration-150 hover:border-[rgba(255,138,61,0.4)] active:scale-[0.99]"
                style={{
                  background:
                    r.status === "next"
                      ? "rgba(255,90,31,0.1)"
                      : r.status === "completed"
                      ? "rgba(40,32,26,0.2)"
                      : "rgba(40,32,26,0.3)",
                  borderColor:
                    r.status === "next"
                      ? "rgba(255,90,31,0.45)"
                      : "rgba(255,255,255,0.07)",
                }}
              >
                <div>
                  <div className="font-semibold text-[10px] tracking-[0.08em] uppercase text-warm-500">
                    Round {r.round}
                  </div>
                  <div className="font-[family-name:var(--font-headline)] font-bold text-lg sm:text-xl mt-0.5">
                    {r.dateMs ? (
                      <LocalDateTime
                        timestampMs={r.dateMs}
                        options={{ day: "2-digit", month: "short" }}
                      />
                    ) : (
                      r.dateLabel
                    )}
                  </div>
                </div>
                <div className="hidden sm:flex w-[38px] h-[26px] rounded-chip overflow-hidden items-center justify-center bg-[rgba(245,235,222,0.08)]">
                  <FlagImg
                    src={r.flagSrc}
                    alt={r.country}
                    width={38}
                    height={26}
                    className="object-cover w-full h-full"
                  />
                </div>
                <div className="min-w-0">
                  <div className="font-bold text-[15px] sm:text-[18px] truncate">
                    {r.name}
                  </div>
                  <div className="font-medium text-xs text-warm-400 mt-0.5 truncate">
                    {[r.circuit, r.locality].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <div className="justify-self-end flex flex-col items-end gap-1.5">
                  {/* Material Symbol, not an emoji. This was the only
                      user-visible emoji left in an app that uses Material
                      Symbols everywhere else, and an emoji among icons renders
                      in the platform's own style -- a different shape, weight
                      and colour on every OS, on the row a reader looks at
                      most. */}
                  {r.winner && r.winner.familyName && (
                    <span className="flex items-center gap-1 font-bold text-[11px] sm:text-xs text-warm-100 whitespace-nowrap">
                      <span
                        className="material-symbols-outlined text-[15px] text-primary"
                        aria-hidden="true"
                      >
                        trophy
                      </span>
                      {r.winner.code || r.winner.familyName}
                    </span>
                  )}
                  <div className="flex items-center gap-1.5">
                    {r.status === "completed" && r.isSprint && (
                      <span
                        className="font-bold text-[9px] tracking-[0.08em] uppercase px-2 py-1 rounded-lg whitespace-nowrap"
                        style={{ background: "rgba(255,138,61,0.16)", color: "var(--color-primary)" }}
                      >
                        Sprint
                      </span>
                    )}
                    <span
                      className="font-bold text-[10px] tracking-[0.08em] uppercase px-3 py-1.5 rounded-lg whitespace-nowrap"
                      style={{ background: badge.bg, color: badge.color }}
                    >
                      {badge.label}
                    </span>
                  </div>
                </div>
              </Link>
              </motion.div>
            );
          })}
        </Stagger>
      </div>
    </div>
  );
}
