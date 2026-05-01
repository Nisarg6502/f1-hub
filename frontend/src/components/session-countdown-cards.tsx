"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { SessionTimelineItem } from "@/lib/sessions";

interface SessionCountdownCardsProps {
  sessions: SessionTimelineItem[];
}

function formatCountdown(targetMs: number, nowMs: number): string {
  const diff = Math.max(0, targetMs - nowMs);
  const totalSeconds = Math.floor(diff / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(days).padStart(2, "0")}d ${String(hours).padStart(
    2,
    "0"
  )}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

export default function SessionCountdownCards({
  sessions,
}: SessionCountdownCardsProps) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (sessions.length === 0) {
    return null;
  }

  return (
    <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-3 max-w-4xl mx-auto">
      {sessions.map((session) => {
        const isLive =
          session.startTimeMs <= nowMs && nowMs < session.endTimeMs;
        const isUpcoming = session.startTimeMs > nowMs;

        return (
          <div
            key={session.id}
            className={`px-4 py-3 text-left border ${
              isLive
                ? "bg-primary-container/10 border-primary-container/50"
                : "bg-surface-container-low/70 border-outline-variant/30"
            }`}
          >
            <p className="font-label text-[10px] tracking-[0.2em] uppercase text-primary-container">
              {session.sessionLabel}
            </p>
            <p className="font-headline font-bold italic text-lg leading-tight">
              {session.raceName}
            </p>
            <p className="mt-1 text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-label">
              {new Date(session.startTimeMs).toLocaleString(undefined, {
                month: "short",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })}
            </p>
            <p className="mt-2 text-xs font-headline text-primary-container">
              {isLive
                ? "LIVE NOW"
                : isUpcoming
                ? formatCountdown(session.startTimeMs, nowMs)
                : "COMPLETED"}
            </p>
            {isLive && (
              <Link
                href="/telemetry"
                className="mt-3 inline-flex items-center gap-2 px-3 py-1 bg-primary-container text-on-primary text-[10px] font-bold tracking-widest uppercase"
              >
                <span className="h-2 w-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)] animate-pulse" />
                Live Status
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}
