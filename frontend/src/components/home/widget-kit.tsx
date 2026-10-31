"use client";

import Image from "next/image";
import { useEffect, useState, type ReactNode } from "react";
import type { WidgetSize } from "@/lib/home-layout";
import { getDriverImagePath, hasDriverImage } from "@/lib/driver-images";
import type { HomeData } from "./home-data";

/**
 * What every widget renderer receives.
 *
 * `size` is the whole design brief: a widget draws a different composition per
 * size (bigger shows *more*, not the same thing stretched), so most renderers
 * are a switch on it. `preview` is true inside the Add-widget gallery, where
 * the widget is a non-interactive picture of itself.
 */
export interface WidgetProps {
  data: HomeData;
  size: WidgetSize;
  preview?: boolean;
  /** True while the home is in edit mode. Only widgets that render nothing
   * in some states (race week) need it, to show a placeholder instead. */
  editing?: boolean;
  /** Server-rendered nodes the client grid places but cannot itself render
   * (the race-week strip is an async server component). */
  slots: { raceWeek: ReactNode };
}

/** The small all-caps label every card leads with. */
export function Kicker({
  children,
  tone = "flame",
  className = "",
}: {
  children: ReactNode;
  tone?: "flame" | "muted";
  className?: string;
}) {
  return (
    <span
      className={`relative block font-bold text-[11px] tracking-[0.14em] uppercase truncate ${
        tone === "flame" ? "text-flame" : "text-warm-300"
      } ${className}`}
    >
      {children}
    </span>
  );
}

/** A loading row for client-fetched widgets. Same height as the row it
 * stands in for, so the swap to real data moves nothing. */
export function SkeletonRows({ count }: { count: number }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col justify-between gap-1.5 animate-pulse" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex-1 max-h-9 min-h-5 rounded-control bg-veil/5" />
      ))}
    </div>
  );
}

/**
 * Right-side driver artwork inside a bento card — the real cutout when we have
 * one, otherwise the APEX hatch placeholder. `accent` tints the placeholder
 * flame-orange to mark the championship leader. Moved verbatim from the old
 * fixed home page; `compact` is new, for the small size, where the cutout
 * sits behind the text as a faded backdrop because there is no column for it.
 */
export function BentoDriverArt({
  given,
  family,
  accent = false,
  compact = false,
}: {
  given?: string;
  family?: string;
  accent?: boolean;
  compact?: boolean;
}) {
  const hasImg = given && family && hasDriverImage(given, family);
  const imgPath = hasImg ? getDriverImagePath(given!, family!) : null;

  if (imgPath) {
    return (
      <div
        className={`absolute top-0 right-0 bottom-0 pointer-events-none ${
          compact ? "w-[58%] opacity-45 [mask-image:linear-gradient(90deg,transparent,black_55%)]" : "w-[46%]"
        }`}
      >
        <Image
          src={imgPath}
          alt={compact ? "" : `${given} ${family}`}
          fill
          sizes="200px"
          className="object-contain object-bottom drop-shadow-[0_10px_30px_rgba(0,0,0,0.7)]"
        />
      </div>
    );
  }

  if (compact) return null;

  return (
    <div
      className={`absolute top-6 right-6 bottom-6 w-[98px] rounded-tile flex items-end justify-center pb-[10px] ${
        accent ? "apex-hatch-flame" : "apex-hatch"
      }`}
    >
      <span
        className={`font-semibold text-[8px] tracking-[0.08em] text-center leading-tight ${
          accent ? "text-[#7a5a45]" : "text-warm-500"
        }`}
      >
        {"// DRIVER"}
        <br />
        CUTOUT
      </span>
    </div>
  );
}

/** Same parsing as `CountdownTimer`: a race with no time is assumed noon UTC. */
export function raceStartMs(date?: string, time?: string): number | null {
  if (!date) return null;
  const baseTime = time ?? "12:00:00Z";
  const iso = baseTime.endsWith("Z") ? `${date}T${baseTime}` : `${date}T${baseTime}Z`;
  const ts = new Date(iso).getTime();
  return Number.isNaN(ts) ? null : ts;
}

/**
 * A ticking "time until" split into parts, for the countdown's smaller sizes
 * (the hero size keeps the original `CountdownTimer`). Server and client
 * disagree by however long the network took, so callers render the digits
 * with `suppressHydrationWarning` for the reason documented in
 * `countdown-timer.tsx`: the interval replaces them within a second.
 */
export function useCountdown(targetMs: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (targetMs === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [targetMs]);
  if (targetMs === null) return null;
  const diff = Math.max(targetMs - now, 0);
  return {
    days: Math.floor(diff / 86400000),
    hours: Math.floor(diff / 3600000) % 24,
    minutes: Math.floor(diff / 60000) % 60,
    seconds: Math.floor(diff / 1000) % 60,
  };
}

export const pad2 = (n: number) => String(n).padStart(2, "0");
