"use client";

import { useEffect, useState } from "react";
import type { Race } from "@/lib/api";

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
      <div className="text-4xl font-bold font-[family-name:var(--font-headline)] italic tracking-tighter text-on-surface-variant">
        Awaiting schedule
      </div>
    );
  }

  const diff = targetDate.getTime() - now.getTime();
  const clamped = Math.max(diff, 0);

  const totalSeconds = Math.floor(clamped / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const segments = [
    { label: "DAYS", value: days, highlight: false },
    { label: "HRS", value: hours, highlight: false },
    { label: "MIN", value: minutes, highlight: false },
    { label: "SEC", value: seconds, highlight: true },
  ];

  return (
    <div className="flex gap-4 md:gap-8 justify-center items-center font-[family-name:var(--font-headline)]">
      {segments.map((seg, i) => (
        <div key={seg.label} className="flex items-center gap-4 md:gap-8">
          <div className="flex flex-col items-center">
            <span
              className={`text-5xl md:text-7xl font-bold tabular-nums ${
                seg.highlight
                  ? "text-secondary-container"
                  : "text-on-background"
              }`}
            >
              {String(seg.value).padStart(2, "0")}
            </span>
            <span
              className={`text-xs font-[family-name:var(--font-label)] tracking-widest ${
                seg.highlight
                  ? "text-secondary-container"
                  : "text-primary-container"
              }`}
            >
              {seg.label}
            </span>
          </div>
          {i < segments.length - 1 && (
            <span className="text-4xl font-light opacity-30 animate-pulse">
              :
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
