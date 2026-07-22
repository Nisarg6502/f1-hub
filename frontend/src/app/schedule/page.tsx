import { getActiveSeasonYear, getSeasonRaces } from "@/lib/api";
import { getCountryFlagPath } from "@/lib/flags";
import ScheduleBoard, { type ScheduleRow } from "@/components/schedule-board";

// Rendered per request: this page splits the calendar into past and upcoming
// against the current time, which a prerender cannot keep correct.
export const dynamic = "force-dynamic";

export default async function SchedulePage() {
  const year = getActiveSeasonYear();
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
      dateLabel: r.ms
        ? new Date(r.ms)
            .toLocaleDateString(undefined, { day: "2-digit", month: "short" })
            .toUpperCase()
        : "TBC",
      name: r.race.raceName,
      circuit: r.race.Circuit?.circuitName ?? "",
      locality: r.race.Circuit?.Location?.locality ?? "",
      country,
      flagSrc: getCountryFlagPath(country),
      status: r.isPast ? "completed" : i === nextIdx ? "next" : "upcoming",
      isSprint: r.isSprint,
    };
  });

  return (
    <ScheduleBoard
      year={year}
      rows={rows}
      nextTargetMs={next?.ms ?? null}
      nextName={next?.race.raceName ?? null}
      nextCircuit={next?.race.Circuit?.circuitName ?? null}
      nextLocality={next?.race.Circuit?.Location?.locality ?? null}
    />
  );
}
