"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion, type Variants } from "motion/react";
import { EASE_OUT, Stagger } from "./motion-primitives";
import FlagImg from "./flag-img";

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
  dateLabel: string;
  name: string;
  circuit: string;
  locality: string;
  country: string;
  flagSrc: string | null;
  status: "completed" | "next" | "upcoming";
  isSprint: boolean;
}

interface ScheduleBoardProps {
  year: number;
  rows: ScheduleRow[];
  nextTargetMs: number | null;
  nextName: string | null;
  nextCircuit: string | null;
  nextLocality: string | null;
}

function badgeFor(row: ScheduleRow) {
  if (row.status === "next")
    return { label: "Next race", bg: "rgba(255,90,31,0.2)", color: "#FFAE6A" };
  if (row.status === "completed")
    return { label: "Completed", bg: "rgba(245,235,222,0.06)", color: "#8f867a" };
  if (row.isSprint)
    return { label: "Sprint", bg: "rgba(255,138,61,0.16)", color: "#FFAE6A" };
  return { label: "Upcoming", bg: "rgba(245,235,222,0.06)", color: "#c9c0b4" };
}

export default function ScheduleBoard({
  year,
  rows,
  nextTargetMs,
  nextName,
  nextCircuit,
  nextLocality,
}: ScheduleBoardProps) {
  const [phase, setPhase] = useState<"upcoming" | "completed">("upcoming");
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
      <div className="mb-8">
        <span className="font-bold text-xs tracking-[0.18em] uppercase text-[#FF7A3D]">
          {year} FIA Formula One World Championship
        </span>
        <div className="font-[family-name:var(--font-headline)] font-extrabold text-4xl md:text-[52px] tracking-[-1.5px] mt-2">
          Race Calendar
        </div>
      </div>

      <div className="grid lg:grid-cols-[280px_1fr] gap-7 items-start">
        {/* Sidebar */}
        <div className="lg:sticky lg:top-[88px] flex flex-col gap-4">
          <div className="flex gap-1.5 apex-glass-soft rounded-[14px] p-1.5">
            {(
              [
                ["upcoming", "Upcoming"],
                ["completed", "Completed"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setPhase(key)}
                className={`relative flex-1 text-center text-xs py-2.5 rounded-[9px] transition-[color,transform] duration-150 active:scale-[0.97] ${
                  phase === key
                    ? "font-bold text-[#FFAE6A]"
                    : "font-semibold text-warm-300 hover:text-on-background"
                }`}
              >
                {phase === key && (
                  <motion.span
                    layoutId="sched-phase-pill"
                    className="absolute inset-0 rounded-[9px] bg-[rgba(255,90,31,0.18)]"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  />
                )}
                <span className="relative z-10">{label}</span>
              </button>
            ))}
          </div>

          {nextTargetMs !== null && nextName && (
            <div className="apex-glass apex-sheen rounded-[18px] p-[22px] overflow-hidden">
              <div className="relative">
                <span className="font-bold text-[11px] tracking-[0.12em] uppercase text-[#FF7A3D]">
                  Next event
                </span>
                <div className="font-[family-name:var(--font-headline)] font-bold text-xl mt-2.5 mb-1">
                  {nextName.replace(" Grand Prix", " GP")}
                </div>
                <div className="font-semibold text-xs text-warm-400 mb-4">
                  {[nextCircuit, nextLocality].filter(Boolean).join(" · ")}
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="font-extrabold text-[40px] tabular-nums text-[#FFAE6A]">
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
                    {r.dateLabel}
                  </div>
                </div>
                <div className="hidden sm:flex w-[38px] h-[26px] rounded-[5px] overflow-hidden items-center justify-center bg-[rgba(245,235,222,0.08)]">
                  <FlagImg
                    src={r.flagSrc}
                    alt={r.country}
                    width={38}
                    height={26}
                    className="object-cover w-full h-full"
                  />
                </div>
                <div className="min-w-0">
                  <div className="font-bold text-[15px] sm:text-[17px] truncate">
                    {r.name}
                  </div>
                  <div className="font-medium text-xs text-warm-400 mt-0.5 truncate">
                    {[r.circuit, r.locality].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <div className="justify-self-end">
                  <span
                    className="font-bold text-[10px] tracking-[0.08em] uppercase px-3 py-1.5 rounded-lg whitespace-nowrap"
                    style={{ background: badge.bg, color: badge.color }}
                  >
                    {badge.label}
                  </span>
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
