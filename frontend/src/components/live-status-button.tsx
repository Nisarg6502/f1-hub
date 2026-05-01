"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getActiveSeasonYear, getSeasonRaces, type Race } from "@/lib/api";
import { buildSeasonSessionTimeline, getCurrentLiveSession } from "@/lib/sessions";

export default function LiveStatusButton() {
  const [races, setRaces] = useState<Race[]>([]);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    let isMounted = true;

    const loadRaces = async () => {
      try {
        const seasonYear = getActiveSeasonYear();
        const response = await getSeasonRaces(seasonYear);
        if (isMounted) {
          setRaces(response.races ?? []);
        }
      } catch {
        if (isMounted) {
          setRaces([]);
        }
      }
    };

    loadRaces();
    const raceRefreshId = setInterval(loadRaces, 60_000);
    const clockId = setInterval(() => setNowMs(Date.now()), 1_000);

    return () => {
      isMounted = false;
      clearInterval(raceRefreshId);
      clearInterval(clockId);
    };
  }, []);

  const liveSession = useMemo(() => {
    const sessions = buildSeasonSessionTimeline(races);
    return getCurrentLiveSession(sessions, nowMs);
  }, [races, nowMs]);

  return (
    <Link
      href="/telemetry"
      className={`inline-flex items-center gap-2 px-6 py-2 font-black italic skew-x-[-12deg] text-xs tracking-tighter transition-all active:scale-95 font-[family-name:var(--font-headline)] ${
        liveSession
          ? "bg-primary-container text-on-primary shadow-[0_0_20px_rgba(0,242,255,0.5)]"
          : "bg-primary-container text-on-primary hover:shadow-[0_0_20px_rgba(0,242,255,0.4)]"
      }`}
    >
      {liveSession && (
        <span className="h-2 w-2 rounded-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.9)] animate-pulse" />
      )}
      LIVE STATUS
    </Link>
  );
}
