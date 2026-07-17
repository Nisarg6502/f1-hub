import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getCircuitInfo,
  getQualifyingResults,
  getRaceResults,
  getSessionClassification,
  getSeasonRaces,
  getSprintResults,
  type RaceResult,
} from "@/lib/api";
import SessionTabs from "@/components/session-tabs";
import RaceSelector from "@/components/race-selector";

interface PageProps {
  params: Promise<{
    season: string;
    round: string;
  }>;
}

// Rendered per request: whether a round counts as completed depends on the
// current time, and results land during the weekend itself.
export const dynamic = "force-dynamic";

export default async function RaceDetailPage({ params }: PageProps) {
  const { season, round } = await params;
  const seasonYear = Number(season);
  const roundNumber = Number(round);

  if (!Number.isFinite(seasonYear) || !Number.isFinite(roundNumber)) {
    notFound();
  }

  let races: Awaited<ReturnType<typeof getSeasonRaces>>["races"] = [];
  try {
    const racesRes = await getSeasonRaces(seasonYear);
    races = racesRes.races ?? [];
  } catch {
    // backend offline
  }

  const race = (races ?? []).find((r) => r.round === String(roundNumber));

  if (!race) {
    notFound();
  }

  // Determine if race is past
  const now = new Date();
  let isPast = false;
  if (race.date) {
    const baseTime = race.time ?? "12:00:00Z";
    const iso = baseTime.endsWith("Z")
      ? `${race.date}T${baseTime}`
      : `${race.date}T${baseTime}Z`;
    const parsed = new Date(iso);
    isPast = !Number.isNaN(parsed.getTime()) && parsed.getTime() < now.getTime();
  }

  const upcomingRace = races
    .map((r) => {
      if (!r.date) return null;
      const baseTime = r.time ?? "12:00:00Z";
      const iso = baseTime.endsWith("Z") ? `${r.date}T${baseTime}` : `${r.date}T${baseTime}Z`;
      const parsed = new Date(iso);
      return { race: r, timestamp: parsed.getTime() };
    })
    .filter((r): r is { race: typeof races[0]; timestamp: number } => r !== null && !Number.isNaN(r.timestamp))
    .filter((r) => r.timestamp > now.getTime())
    .sort((a, b) => a.timestamp - b.timestamp)[0]?.race;

  const isNextRace = upcomingRace?.round === String(roundNumber);

  // Fetch results for completed races
  let results: RaceResult[] = [];
  let qualifyingResults: RaceResult[] = [];
  let sprintResults: RaceResult[] = [];
  let fp1Results: RaceResult[] = [];
  let fp2Results: RaceResult[] = [];
  let fp3Results: RaceResult[] = [];
  let sprintQualiResults: RaceResult[] = [];
  if (isPast) {
    try {
      const res = await getRaceResults(seasonYear, roundNumber);
      results = res.results ?? [];
    } catch {
      // no results
    }
    try {
      const res = await getQualifyingResults(seasonYear, roundNumber);
      qualifyingResults = res.results ?? [];
    } catch {
      qualifyingResults = [];
    }
    try {
      const res = await getSprintResults(seasonYear, roundNumber);
      sprintResults = res.results ?? [];
    } catch {
      sprintResults = [];
    }
    // Fetch each practice/SQ session independently so one failure doesn't wipe all results
    const [fp1Res, fp2Res, fp3Res, sqRes] = await Promise.allSettled([
      getSessionClassification(seasonYear, roundNumber, "FP1"),
      getSessionClassification(seasonYear, roundNumber, "FP2"),
      getSessionClassification(seasonYear, roundNumber, "FP3"),
      getSessionClassification(seasonYear, roundNumber, "SQ"),
    ]);
    fp1Results = fp1Res.status === "fulfilled" ? fp1Res.value.results ?? [] : [];
    fp2Results = fp2Res.status === "fulfilled" ? fp2Res.value.results ?? [] : [];
    fp3Results = fp3Res.status === "fulfilled" ? fp3Res.value.results ?? [] : [];
    sprintQualiResults = sqRes.status === "fulfilled" ? sqRes.value.results ?? [] : [];
  }

  // Fetch circuit info
  let circuitInfo = null;
  try {
    circuitInfo = await getCircuitInfo(seasonYear, race.raceName);
  } catch {
    circuitInfo = null;
  }

  const circuit = race.Circuit;
  const location = circuit?.Location;

  const circuitStats: Array<{ label: string; value: string | number }> = (
    [
      { label: "Laps", value: circuitInfo?.total_laps ?? null },
      { label: "Corners", value: circuitInfo?.num_corners || null },
      {
        label: "Fastest Lap",
        value: circuitInfo?.fastest_lap?.time
          ? `${circuitInfo.fastest_lap.time}${
              circuitInfo.fastest_lap.driver ? ` (${circuitInfo.fastest_lap.driver})` : ""
            }`
          : null,
      },
    ] as Array<{ label: string; value: string | number | null }>
  ).flatMap((stat) => (stat.value === null ? [] : [{ ...stat, value: stat.value }]));

  return (
    <div className="px-6 lg:px-12 max-w-[1600px] mx-auto pt-4 pb-20">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-8 gap-6">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <span
              className={`px-3 py-1 text-[10px] font-bold uppercase tracking-widest ${
                isPast
                  ? "bg-neutral-800 text-neutral-400"
                  : isNextRace
                  ? "bg-secondary-container/20 text-secondary-container border border-secondary-container/30"
                  : "bg-primary-container/20 text-primary-container border border-primary-container/30"
              }`}
            >
              {isPast ? "Completed" : isNextRace ? "Next Race" : "Upcoming"}
            </span>
            <span className="text-neutral-500 font-[family-name:var(--font-label)] text-[10px] tracking-widest uppercase">
              Round {race.round} · {seasonYear}
            </span>
          </div>
          <h1 className="text-5xl lg:text-7xl font-black font-[family-name:var(--font-headline)] italic skew-x-[-12deg] uppercase tracking-tighter leading-none">
            {race.raceName.replace(" Grand Prix", "")}{" "}
            <span className="text-primary-container neon-text-primary">
              GP
            </span>
          </h1>
          <p className="text-neutral-500 font-[family-name:var(--font-label)] tracking-widest text-sm uppercase">
            {circuit?.circuitName}
            {location?.locality ? ` · ${location.locality}, ${location.country}` : ""}
          </p>
        </div>
        <div className="flex flex-col sm:flex-row items-start sm:items-end gap-6">
          <RaceSelector races={races} currentRound={String(roundNumber)} seasonYear={seasonYear} />
          <Link
            href="/schedule"
            className="font-[family-name:var(--font-label)] text-xs uppercase tracking-widest text-primary-container border border-primary-container/30 px-6 hover:bg-primary-container/10 transition-all active:scale-95 h-[52px] flex items-center justify-center"
          >
            Back to Schedule
          </Link>
        </div>
      </div>

      {/* Circuit info bar — only the stats FastF1 reports for this event */}
      {circuitStats.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-8">
          {circuitStats.map((stat) => (
            <div key={stat.label} className="bg-surface-container p-4">
              <p className="text-[10px] text-neutral-500 uppercase tracking-widest">
                {stat.label}
              </p>
              <p className="font-[family-name:var(--font-headline)] font-bold text-lg italic">
                {stat.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Session Tabs + Content */}
      <SessionTabs
        race={race}
        results={results}
        qualifyingResults={qualifyingResults}
        sprintResults={sprintResults}
        sprintQualiResults={sprintQualiResults}
        fp1Results={fp1Results}
        fp2Results={fp2Results}
        fp3Results={fp3Results}
        isPast={isPast}
      />
    </div>
  );
}
