"use client";

import { useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Flag, AlertTriangle, Siren, Radio } from "lucide-react";
import type { RaceControlMessage } from "@/lib/openf1";

interface RaceControlPanelProps {
  drivers: {
    driverId: string;
    number: string;
    code: string;
    givenName: string;
    familyName: string;
    teamColor: string;
  }[];
  messages: RaceControlMessage[];
}

/** Strong ease-out shared with the rest of the app's `motion/react` usage. */
const EASE_OUT = [0.23, 1, 0.32, 1] as const;

type Tone = "red" | "amber" | "yellow" | "green" | "blue" | "neutral";

const TONE_STYLES: Record<Tone, { text: string; bg: string; border: string }> = {
  red: {
    text: "#FF6B6B",
    bg: "rgba(255,68,68,0.12)",
    border: "rgba(255,68,68,0.3)",
  },
  amber: {
    text: "#FFAE6A",
    bg: "rgba(255,90,31,0.12)",
    border: "rgba(255,90,31,0.3)",
  },
  yellow: {
    text: "#F5D547",
    bg: "rgba(245,213,71,0.12)",
    border: "rgba(245,213,71,0.3)",
  },
  green: {
    text: "#5ED88F",
    bg: "rgba(94,216,143,0.12)",
    border: "rgba(94,216,143,0.3)",
  },
  blue: {
    text: "#6AB6FF",
    bg: "rgba(106,182,255,0.12)",
    border: "rgba(106,182,255,0.3)",
  },
  neutral: {
    text: "#B8AE9E",
    bg: "rgba(245,235,222,0.06)",
    border: "rgba(245,235,222,0.14)",
  },
};

/** Flag/category text from OpenF1 -> a visual tone + icon. Safety-car and red
 * flags get the loudest treatment since they're the highest-signal events in
 * this feed; everything else (investigations, DRS, sector notes) stays neutral
 * so the timeline doesn't turn into a wall of color. */
function classify(msg: RaceControlMessage): { tone: Tone; icon: typeof Flag } {
  const flag = msg.flag?.toUpperCase() ?? "";
  const category = msg.category?.toUpperCase() ?? "";
  const message = msg.message?.toUpperCase() ?? "";

  if (flag === "RED") return { tone: "red", icon: Flag };
  if (
    category === "SAFETYCAR" ||
    message.includes("SAFETY CAR") ||
    message.includes("VIRTUAL SAFETY CAR")
  ) {
    return { tone: "amber", icon: Siren };
  }
  if (flag === "YELLOW" || flag === "DOUBLE YELLOW") {
    return { tone: "yellow", icon: AlertTriangle };
  }
  if (flag === "GREEN" || flag === "CLEAR") return { tone: "green", icon: Flag };
  if (flag === "BLUE") return { tone: "blue", icon: Flag };
  if (flag === "CHEQUERED") return { tone: "neutral", icon: Flag };
  return { tone: "neutral", icon: Radio };
}

function formatClock(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("en-GB", { timeZone: "UTC", hour12: false });
}

function StatTile({ label, value, tone }: { label: string; value: number; tone: Tone }) {
  const style = TONE_STYLES[tone];
  return (
    <div className="apex-glass-soft rounded-2xl px-5 py-4">
      <div className="font-bold text-[10px] tracking-[0.16em] uppercase text-warm-500">
        {label}
      </div>
      <div
        className="font-[family-name:var(--font-headline)] font-extrabold text-2xl tabular-nums mt-1.5"
        style={{ color: value > 0 ? style.text : undefined }}
      >
        {value}
      </div>
    </div>
  );
}

const FILTERS = [
  { id: "all", label: "All" },
  { id: "flags", label: "Flags" },
  { id: "safetycar", label: "Safety Car" },
  { id: "other", label: "Other" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

export default function RaceControlPanel({ drivers, messages }: RaceControlPanelProps) {
  const [filter, setFilter] = useState<FilterId>("all");
  const reduce = useReducedMotion();

  const driverByNumber = useMemo(
    () => new Map(drivers.map((d) => [Number(d.number), d])),
    [drivers]
  );

  const ordered = useMemo(
    () =>
      [...messages].sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
      ),
    [messages]
  );

  const counts = useMemo(() => {
    let flags = 0;
    let safetyCar = 0;
    let other = 0;
    for (const msg of ordered) {
      const { tone } = classify(msg);
      if (tone === "amber") safetyCar += 1;
      else if (tone === "red" || tone === "yellow" || tone === "green" || tone === "blue")
        flags += 1;
      else other += 1;
    }
    return { total: ordered.length, flags, safetyCar, other };
  }, [ordered]);

  const filtered = useMemo(() => {
    if (filter === "all") return ordered;
    return ordered.filter((msg) => {
      const { tone } = classify(msg);
      if (filter === "safetycar") return tone === "amber";
      if (filter === "flags")
        return tone === "red" || tone === "yellow" || tone === "green" || tone === "blue";
      return tone === "neutral";
    });
  }, [ordered, filter]);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Messages" value={counts.total} tone="neutral" />
        <StatTile label="Flag changes" value={counts.flags} tone="yellow" />
        <StatTile label="Safety car / VSC" value={counts.safetyCar} tone="amber" />
        <StatTile label="Other notes" value={counts.other} tone="neutral" />
      </div>

      <div className="apex-glass-soft rounded-2xl p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
          <h3 className="font-[family-name:var(--font-headline)] font-bold text-xl">
            Race control feed
          </h3>
          <div className="flex gap-1.5">
            {FILTERS.map((f) => {
              const isActive = f.id === filter;
              return (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className={`font-bold text-[11px] uppercase tracking-[0.08em] px-3 py-1.5 rounded-lg transition-colors duration-150 ${
                    isActive
                      ? "bg-[rgba(255,90,31,0.16)] text-[#FFAE6A]"
                      : "text-warm-500 hover:text-warm-300"
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>

        {filtered.length === 0 ? (
          <p className="font-medium text-sm text-warm-400 py-10 text-center">
            No messages in this category.
          </p>
        ) : (
          <div className="max-h-[520px] overflow-y-auto flex flex-col gap-2">
            {filtered.map((msg, idx) => {
              const { tone, icon: Icon } = classify(msg);
              const style = TONE_STYLES[tone];
              const driver =
                msg.driver_number != null ? driverByNumber.get(msg.driver_number) : undefined;

              return (
                <motion.div
                  key={`${msg.date}-${idx}`}
                  initial={reduce ? false : { opacity: 0, y: 8 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: "0px 0px -40px 0px" }}
                  transition={{
                    duration: 0.35,
                    delay: reduce ? 0 : Math.min(idx * 0.02, 0.3),
                    ease: EASE_OUT,
                  }}
                  className="flex items-start gap-3 rounded-xl px-4 py-3 border"
                  style={{ backgroundColor: style.bg, borderColor: style.border }}
                >
                  <div
                    className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                    style={{ backgroundColor: style.bg, border: `1px solid ${style.border}` }}
                  >
                    <Icon className="w-3.5 h-3.5" style={{ color: style.text }} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-sm text-warm-100 leading-snug">
                      {msg.message}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-[11px] font-bold uppercase tracking-[0.06em] text-warm-500">
                      <span className="tabular-nums">{formatClock(msg.date)}</span>
                      {msg.lap_number != null && <span>Lap {msg.lap_number}</span>}
                      {driver && (
                        <span
                          className="flex items-center gap-1"
                          style={{ color: driver.teamColor }}
                        >
                          <span
                            className="w-1.5 h-1.5 rounded-full"
                            style={{ backgroundColor: driver.teamColor }}
                          />
                          {driver.code || driver.familyName}
                        </span>
                      )}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
