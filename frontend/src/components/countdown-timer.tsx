"use client";

import { useEffect, useState } from "react";
import type { Race } from "@/lib/api";
import LocalDateTime from "./local-datetime";

interface CountdownTimerProps {
  targetRace?: Race;
}

function getTargetDate(race?: Race) {
  if (!race || !race.date) return null;

  const baseTime = race.time ?? "12:00:00Z";
  const iso = baseTime.endsWith("Z")
    ? `${race.date}T${baseTime}`
    : `${race.date}T${baseTime}Z`;
  const parsed = new Date(iso);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

export default function CountdownTimer({ targetRace }: CountdownTimerProps) {
  const targetDate = getTargetDate(targetRace);
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!targetDate) {
    return (
      <div className="font-[family-name:var(--font-headline)] text-3xl font-bold text-warm-400">
        Awaiting schedule
      </div>
    );
  }

  const diff = Math.max(targetDate.getTime() - now.getTime(), 0);
  const pad = (n: number) => String(n).padStart(2, "0");

  const segments = [
    { label: "Days", value: pad(Math.floor(diff / 86400000)), hot: false },
    { label: "Hours", value: pad(Math.floor(diff / 3600000) % 24), hot: false },
    { label: "Minutes", value: pad(Math.floor(diff / 60000) % 60), hot: false },
    { label: "Seconds", value: pad(Math.floor(diff / 1000) % 60), hot: true },
  ];

  return (
    <div>
      <div className="flex items-stretch">
        {segments.map((seg, i) => (
          <div key={seg.label} className="flex items-stretch">
            <div
              className={`${i === 0 ? "pr-3 sm:pr-6" : "px-3 sm:px-6"} ${
                i === segments.length - 1 ? "pr-0" : ""
              }`}
            >
              <div
                /* A countdown cannot agree with itself across a network hop.
                   `useState(() => new Date())` runs once on the server and
                   again on the client's hydration pass, seconds apart, so the
                   seconds digit differed on essentially every load — measured
                   as 38 against 39 — and React threw the whole hero away and
                   re-rendered it.

                   `suppressHydrationWarning` is the right tool *here* and the
                   wrong one in `local-datetime.tsx`, for one reason: it tells
                   React to keep the server's text, and this text is replaced by
                   the interval within 1000ms anyway. A stale-by-one-second
                   countdown for a single tick is invisible. A timezone that
                   never corrects itself, which is what suppressing would have
                   bought there, is a wrong number shown forever. */
                suppressHydrationWarning
                className={`font-extrabold text-4xl sm:text-5xl md:text-[52px] leading-none tabular-nums ${
                  seg.hot ? "text-flame" : "text-on-background"
                }`}
              >
                {seg.value}
              </div>
              <div
                className={`mt-[6px] text-[10px] sm:text-[11px] font-semibold tracking-[0.12em] sm:tracking-[0.16em] uppercase ${
                  seg.hot ? "text-[#8a6a52]" : "text-warm-500"
                }`}
              >
                {seg.label}
              </div>
            </div>
            {i < segments.length - 1 && (
              <div className="w-px bg-[rgba(245,235,222,0.1)]" />
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 text-xs sm:text-sm font-semibold text-warm-400">
        <LocalDateTime
          timestampMs={targetDate.getTime()}
          options={{
            weekday: "short",
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }}
        />{" "}
        · your local time
      </div>
    </div>
  );
}
