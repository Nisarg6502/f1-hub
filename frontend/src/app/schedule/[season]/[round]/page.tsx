import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getActiveSeasonYear,
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
import SeasonSelector from "@/components/season-selector";

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

  // Fetch results, session classifications and circuit info for completed
  // races in one parallel wave instead of six sequential round trips — each
  // request fails independently so one missing session doesn't wipe the rest.
  let results: RaceResult[] = [];
  let qualifyingResults: RaceResult[] = [];
  let sprintResults: RaceResult[] = [];
  let fp1Results: RaceResult[] = [];
  let fp2Results: RaceResult[] = [];
  let fp3Results: RaceResult[] = [];
  let sprintQualiResults: RaceResult[] = [];
  let circuitInfo = null;

  if (isPast) {
    const [
      raceRes,
      qualiRes,
      sprintRes,
      fp1Res,
      fp2Res,
      fp3Res,
      sqRes,
      circuitInfoRes,
    ] = await Promise.allSettled([
      getRaceResults(seasonYear, roundNumber),
      getQualifyingResults(seasonYear, roundNumber),
      getSprintResults(seasonYear, roundNumber),
      getSessionClassification(seasonYear, roundNumber, "FP1"),
      getSessionClassification(seasonYear, roundNumber, "FP2"),
      getSessionClassification(seasonYear, roundNumber, "FP3"),
      getSessionClassification(seasonYear, roundNumber, "SQ"),
      getCircuitInfo(seasonYear, race.raceName),
    ]);

    results = raceRes.status === "fulfilled" ? raceRes.value.results ?? [] : [];
    qualifyingResults = qualiRes.status === "fulfilled" ? qualiRes.value.results ?? [] : [];
    sprintResults = sprintRes.status === "fulfilled" ? sprintRes.value.results ?? [] : [];
    fp1Results = fp1Res.status === "fulfilled" ? fp1Res.value.results ?? [] : [];
    fp2Results = fp2Res.status === "fulfilled" ? fp2Res.value.results ?? [] : [];
    fp3Results = fp3Res.status === "fulfilled" ? fp3Res.value.results ?? [] : [];
    sprintQualiResults = sqRes.status === "fulfilled" ? sqRes.value.results ?? [] : [];
    circuitInfo = circuitInfoRes.status === "fulfilled" ? circuitInfoRes.value : null;
  } else {
    try {
      circuitInfo = await getCircuitInfo(seasonYear, race.raceName);
    } catch {
      circuitInfo = null;
    }
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

  const statusBadge = isPast
    ? { label: "Completed", bg: "rgba(255,255,255,0.06)", color: "#a89e90" }
    : isNextRace
    ? { label: "Next race", bg: "rgba(255,90,31,0.16)", color: "#FFAE6A" }
    : { label: "Upcoming", bg: "rgba(245,235,222,0.06)", color: "#c9c0b4" };

  return (
    <div className="px-6 md:px-10 pt-8 pb-16">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-7 gap-6">
        <div>
          <div className="flex items-center gap-3 mb-3">
            <span
              className="font-bold text-[10px] tracking-[0.1em] uppercase px-3 py-1.5 rounded-lg"
              style={{ background: statusBadge.bg, color: statusBadge.color }}
            >
              {statusBadge.label}
            </span>
            <span className="font-semibold text-xs text-warm-400">
              Round {race.round} · {seasonYear}
            </span>
          </div>
          <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-4xl md:text-[56px] tracking-[-1.5px] leading-none">
            {race.raceName.replace(" Grand Prix", "")}{" "}
            <span className="apex-flame-text">GP</span>
          </h1>
          <p className="font-semibold text-[13px] text-warm-400 mt-2">
            {circuit?.circuitName}
            {location?.locality
              ? ` · ${location.locality}, ${location.country}`
              : ""}
          </p>
        </div>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <SeasonSelector
            currentYear={seasonYear}
            maxYear={getActiveSeasonYear()}
            hrefTemplate="/schedule/{year}/1"
          />
          <RaceSelector
            races={races}
            currentRound={String(roundNumber)}
            seasonYear={seasonYear}
          />
          <Link
            href="/schedule"
            className="font-bold text-xs px-5 h-[46px] rounded-[11px] apex-glass-soft flex items-center justify-center hover:border-[rgba(255,138,61,0.5)] transition-[border-color,transform] duration-150 active:scale-95"
          >
            ← Back to schedule
          </Link>
        </div>
      </div>

      {/* Circuit info bar — only the stats FastF1 reports for this event */}
      {circuitStats.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3.5 mb-6">
          {circuitStats.map((stat) => (
            <div
              key={stat.label}
              className="apex-glass-soft rounded-[14px] px-[22px] py-[18px]"
            >
              <p className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500">
                {stat.label}
              </p>
              <p className="font-[family-name:var(--font-headline)] font-bold text-lg mt-1 tabular-nums">
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
