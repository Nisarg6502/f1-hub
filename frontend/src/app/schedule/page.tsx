import type { Metadata } from "next";
import { getActiveSeasonYear, getSeasonRaces, resolveSeasonYear } from "@/lib/api";
import { getCountryFlagPath } from "@/lib/flags";
import ScheduleBoard, { type ScheduleRow } from "@/components/schedule-board";

// Rendered per request: this page splits the calendar into past and upcoming
// against the current time, which a prerender cannot keep correct.
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ season?: string }>;
}

// Mirrors the ?season= resolution the page itself uses, so the <title> and
// description reflect whichever season is actually being viewed instead of
// the root layout's hardcoded fallback.
export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const { season } = await searchParams;
  const year = resolveSeasonYear(season);
  return {
    title: `APEX | ${year} F1 Season Hub`,
    description: `APEX — a warm, high-clarity home for the ${year} Formula 1 season: schedule, standings, drivers, teams and circuits.`,
  };
}

export default async function SchedulePage({ searchParams }: PageProps) {
  const { season } = await searchParams;
  const year = resolveSeasonYear(season);
  let races: Awaited<ReturnType<typeof getSeasonRaces>>["races"] = [];
  try {
    const racesRes = await getSeasonRaces(year);
    races = racesRes.races ?? [];
  } catch {
    // Backend offline
  }

  const nowMs = Date.now();

  const enriched = races.map((race) => {
    let ms: number | null = null;
    if (race.date) {
      const baseTime = race.time ?? "12:00:00Z";
      const iso = baseTime.endsWith("Z")
        ? `${race.date}T${baseTime}`
        : `${race.date}T${baseTime}Z`;
      const parsed = new Date(iso).getTime();
      if (!Number.isNaN(parsed)) ms = parsed;
    }
    const isPast = ms !== null ? ms < nowMs : false;
    const isSprint = !!(race.Sprint?.date || race.SprintQualifying?.date);
    return { race, ms, isPast, isSprint };
  });

  const nextIdx = enriched.findIndex((r) => !r.isPast);
  const next = nextIdx >= 0 ? enriched[nextIdx] : null;

  const rows: ScheduleRow[] = enriched.map((r, i) => {
    const country = r.race.Circuit?.Location?.country ?? "";
    return {
      round: r.race.round,
      season: r.race.season ?? String(year),
      // Formatted here only as the pre-hydration fallback, and pinned to UTC
      // so the server and the client's first pass agree. The real, reader-local
      // date is rendered from `dateMs` by `LocalDateTime` in the board itself;
      // formatting it here with `undefined` gave every reader the CONTAINER's
      // timezone, which on Cloud Run is UTC.
      dateLabel: r.ms
        ? new Date(r.ms)
            .toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
              timeZone: "UTC",
            })
            .toUpperCase()
        : "TBC",
      dateMs: r.ms ?? null,
      name: r.race.raceName,
      circuit: r.race.Circuit?.circuitName ?? "",
      locality: r.race.Circuit?.Location?.locality ?? "",
      country,
      flagSrc: getCountryFlagPath(country),
      status: r.isPast ? "completed" : i === nextIdx ? "next" : "upcoming",
      isSprint: r.isSprint,
      winner: r.race.winner,
    };
  });

  // A fully historical season has no upcoming race — default straight to the
  // completed list rather than opening on an empty "Upcoming" tab.
  const initialPhase = next === null && rows.length > 0 ? "completed" : "upcoming";

  return (
    <ScheduleBoard
      year={year}
      maxYear={getActiveSeasonYear()}
      initialPhase={initialPhase}
      rows={rows}
      nextTargetMs={next?.ms ?? null}
      nextName={next?.race.raceName ?? null}
      nextCircuit={next?.race.Circuit?.circuitName ?? null}
      nextLocality={next?.race.Circuit?.Location?.locality ?? null}
    />
  );
}
