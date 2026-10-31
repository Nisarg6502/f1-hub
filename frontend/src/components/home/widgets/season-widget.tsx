"use client";

import { AnimatedRing } from "@/components/animated-ring";
import TiltCard from "@/components/tilt-card";
import Tooltip from "@/components/tooltip";
import type { HomeData } from "../home-data";
import type { WidgetProps } from "../widget-kit";

const RING = 276; // 2πr for r=44

function rings(season: HomeData["season"]) {
  return [
    {
      label: "Elapsed",
      center: `${Math.round(season.elapsedPct * 100)}%`,
      unit: undefined as string | undefined,
      offset: RING * (1 - season.elapsedPct),
      color: "var(--color-primary-container)",
      tooltip: "Share of this season's rounds that have been run so far.",
    },
    {
      label: "Title gap",
      center: `${season.ptsGap}`,
      unit: "pts",
      offset: RING * (1 - season.gapPct),
      color: "#c9c0b4",
      tooltip:
        "Points separating the championship leader from 2nd place — a smaller gap means a tighter title fight.",
    },
  ];
}

function Ring({ ring }: { ring: ReturnType<typeof rings>[number] }) {
  return (
    <div className="relative">
      <AnimatedRing center={ring.center} unit={ring.unit} label={ring.label} offset={ring.offset} color={ring.color} />
      <div className="absolute -top-1 -right-1">
        <Tooltip content={ring.tooltip}>
          <button
            type="button"
            aria-label={`What does ${ring.label} mean?`}
            /* Stays 20px to the eye and is 40px to a finger. The visual size
               is right — it sits in the corner of a progress ring and a
               larger disc would compete with the number it explains — but
               20px is far under a usable touch target, and this is the
               control that exists *for* the person who does not already know
               what the ring means. `before:` expands the hit area without
               moving a pixel: `-inset-2.5` is 10px a side, 20px → 40px. */
            className="relative w-5 h-5 rounded-full bg-veil/6 flex items-center justify-center text-warm-500 hover:text-warm-200 hover:bg-veil/12 transition-colors before:absolute before:-inset-2.5 before:content-['']"
          >
            {/* The ligature text IS the glyph, so without this the button
                announced itself as "info What does Elapsed mean?". */}
            <span className="material-symbols-outlined text-[13px] leading-none" aria-hidden="true">
              info
            </span>
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * The "This season" card: two progress rings and three facts. Rendered both
 * inside the countdown's hero size and as the season widget's large size, so
 * it is one component — and one place for spoiler mode to gate the title-gap
 * ring wherever it appears.
 */
export function SeasonCard({ data }: { data: HomeData }) {
  const { season } = data;
  return (
    <div className="relative">
      <div className="flex items-center justify-between gap-2 mb-6">
        <span className="font-bold text-[13px] truncate">This season</span>
        <span className="font-semibold text-[11px] tracking-[0.06em] text-warm-500 uppercase whitespace-nowrap flex-none">
          {season.done} / {season.total} rounds
        </span>
      </div>
      <div className="flex justify-around mb-6">
        {rings(season).map((ring) => (
          <Ring key={ring.label} ring={ring} />
        ))}
      </div>
      <div>
        {[
          { k: "Leader wins", v: season.leaderWins },
          { k: "Rounds completed", v: `${season.done} / ${season.total}` },
          { k: "Rounds remaining", v: season.roundsLeft },
        ].map((row) => (
          <div
            key={row.k}
            className="flex justify-between py-[11px] border-t border-veil/7 font-semibold text-[13px]"
          >
            <span className="text-warm-300">{row.k}</span>
            <span className="tabular-nums">{row.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Season progress on its own, for a visitor who wants it somewhere other than
 * beside the hero (or has shrunk the hero). `l` is the full card; `m` drops
 * the fact rows and keeps both rings; `s` is the one ring that answers "how
 * far through the year are we".
 */
export default function SeasonWidget({ data, size }: WidgetProps) {
  if (size === "l") {
    return (
      <TiltCard className="apex-glass apex-sheen rounded-panel p-7 overflow-hidden h-full block" strength={5}>
        <SeasonCard data={data} />
      </TiltCard>
    );
  }

  const all = rings(data.season);
  const shown = size === "s" ? all.slice(0, 1) : all;
  return (
    <div className="apex-glass apex-sheen rounded-panel overflow-hidden h-full p-5 flex flex-col">
      <div className="relative flex items-center justify-between gap-2">
        <span className="font-bold text-[13px] truncate">This season</span>
        <span className="font-semibold text-[11px] tracking-[0.06em] text-warm-500 uppercase whitespace-nowrap flex-none">
          {data.season.done} / {data.season.total}
          {size === "m" ? " rounds" : ""}
        </span>
      </div>
      <div className="relative flex-1 flex items-center justify-around">
        {shown.map((ring) => (
          <Ring key={ring.label} ring={ring} />
        ))}
      </div>
    </div>
  );
}
