"use client";

import { useEffect, useState } from "react";
import type { SessionTimelineItem } from "@/lib/sessions";

interface CountdownTimerProps {
  nextSession?: SessionTimelineItem | null;
  liveSession?: SessionTimelineItem | null;
}

export default function CountdownTimer({
  nextSession,
  liveSession,
}: CountdownTimerProps) {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  if (liveSession) {
    return (
      <div className="space-y-3">
        <div className="inline-flex items-center gap-2 rounded-sm bg-tertiary-container/20 px-3 py-1 font-[family-name:var(--font-label)] text-xs uppercase tracking-[0.24em] text-tertiary-container border border-tertiary-container/40">
          <span className="h-2 w-2 rounded-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.9)] animate-pulse" />
          Session Live
        </div>
        <div className="text-4xl md:text-6xl font-black font-[family-name:var(--font-headline)] italic tracking-tighter text-primary-container drop-shadow-[0_0_15px_#00f2ff]">
          {liveSession.sessionLabel.toUpperCase()}
        </div>
        <div className="text-xs md:text-sm font-[family-name:var(--font-label)] tracking-[0.24em] uppercase text-on-surface-variant">
          {liveSession.raceName}
        </div>
      </div>
    );
  }

  if (!nextSession) {
    return (
      <div className="text-4xl font-bold font-[family-name:var(--font-headline)] italic tracking-tighter text-on-surface-variant">
        Awaiting schedule
      </div>
    );
  }

  const diff = nextSession.startTimeMs - now.getTime();
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
