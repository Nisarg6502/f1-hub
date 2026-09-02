import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { parseDateTimeToMs, type RaceSessionField } from "@/lib/sessions";
import Link from "next/link";
import {
  getActiveSeasonYear,
  getCircuitInfo,
  getQualifyingResults,
  getRaceResults,
  getRaceWeather,
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

/** The per-session schedule fields a race document can carry. */
const SESSION_FIELDS: RaceSessionField[] = [
  "FirstPractice",
  "SecondPractice",
  "ThirdPractice",
  "SprintQualifying",
  "Sprint",
  "Qualifying",
  "Race",
];

/** `Race` viewed as its optional per-session schedule fields.
 *
 * `Partial` because a weekend genuinely may not have a session (a sprint
 * weekend has no FP3), and because `Race` carries the grand prix's own
 * date/time at the top level rather than under a `Race` key. */
type RaceWithSessions = Partial<
  Record<RaceSessionField, { date?: string; time?: string }>
>;

// The [season] path segment is the season being viewed, verbatim — no need
// to re-derive it via resolveSeasonYear the way the query-param routes do.
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { season, round } = await params;

  /* Named after the actual grand prix, because this is the page people share.
     A result link that previews as "APEX | 2026 F1 Season Hub" — the same card
     as the homepage and every other route — tells the person receiving it
     nothing about what they have been sent.

     `getSeasonRaces` is the same call the page body makes a moment later, so
     on the happy path this costs nothing: Next dedupes identical fetches
     within one render pass. The `try` is not optional — `generateMetadata`
     throwing takes the whole route down, and this one reaches a backend that
     is allowed to be offline (the page body tolerates exactly that, and so
     must this). The fallback is the old generic title, which is a worse
     preview but a working page. */
  let raceName: string | null = null;
  let circuit: string | null = null;
  try {
    const { races } = await getSeasonRaces(Number(season));
    const race = (races ?? []).find((r) => r.round === String(Number(round)));
    raceName = race?.raceName ?? null;
    circuit = race?.Circuit?.circuitName ?? null;
  } catch {
    // Backend offline — fall through to the generic title below.
  }

  if (!raceName) {
    return {
      title: `Round ${round} · ${season} F1 Season · APEX`,
      description: `Session results, weather and circuit detail for round ${round} of the ${season} Formula 1 season.`,
    };
  }

  const title = `${raceName} ${season} · Results · APEX`;
  const description = circuit
    ? `Every session of the ${season} ${raceName} at ${circuit} — practice, qualifying and race classification, weather, and an AI recap grounded in the results.`
    : `Every session of the ${season} ${raceName} — practice, qualifying and race classification, weather, and an AI recap grounded in the results.`;

  return {
    title,
    description,
    openGraph: { title, description, url: `/schedule/${season}/${round}` },
    twitter: { title, description },
  };
}

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

  // Whether any session of this weekend has STARTED -- not whether the race is
  // over.
  //
  // The fetch below used to be gated on `isPast`, which is true only once the
  // grand prix itself has begun. On a sprint weekend that meant FP1 and sprint
  // qualifying could have run, been classified, and been sitting in the
  // database for two days while this page refused to ask for them: the Dutch
  // GP showed an empty FP1 tab on the Saturday with its results already synced.
  //
  // `data_sync.py` hit exactly this and documented it -- "practice, qualifying
  // and sprint results used to be synced only for rounds whose *race* had
  // started, which meant a session run on Friday was not even asked for until
  // Sunday afternoon" -- and fixed it there by splitting `_rounds_in_play`
  // from `_completed_rounds`. The backend stopped making the mistake; the
  // frontend kept it.
  //
  // Every request below already fails independently, so asking early for a
  // session that has not run costs one empty response, not a broken page.
  const weekendHasBegun = SESSION_FIELDS.some((field) => {
    const start =
      field === "Race"
        ? parseDateTimeToMs(race.date, race.time)
        : parseDateTimeToMs(
            (race as RaceWithSessions)[field]?.date,
            (race as RaceWithSessions)[field]?.time
          );
    return start !== null && start < now.getTime();
  });

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
  let weather: Awaited<ReturnType<typeof getRaceWeather>>["weather"] = null;

  if (weekendHasBegun) {
    const [
      raceRes,
      qualiRes,
      sprintRes,
      fp1Res,
      fp2Res,
      fp3Res,
      sqRes,
      circuitInfoRes,
      weatherRes,
    ] = await Promise.allSettled([
      getRaceResults(seasonYear, roundNumber),
      getQualifyingResults(seasonYear, roundNumber),
      getSprintResults(seasonYear, roundNumber),
      getSessionClassification(seasonYear, roundNumber, "FP1"),
      getSessionClassification(seasonYear, roundNumber, "FP2"),
      getSessionClassification(seasonYear, roundNumber, "FP3"),
      getSessionClassification(seasonYear, roundNumber, "SQ"),
      getCircuitInfo(seasonYear, race.raceName),
      getRaceWeather(seasonYear, roundNumber),
    ]);

    results = raceRes.status === "fulfilled" ? raceRes.value.results ?? [] : [];
    qualifyingResults = qualiRes.status === "fulfilled" ? qualiRes.value.results ?? [] : [];
    sprintResults = sprintRes.status === "fulfilled" ? sprintRes.value.results ?? [] : [];
    fp1Results = fp1Res.status === "fulfilled" ? fp1Res.value.results ?? [] : [];
    fp2Results = fp2Res.status === "fulfilled" ? fp2Res.value.results ?? [] : [];
    fp3Results = fp3Res.status === "fulfilled" ? fp3Res.value.results ?? [] : [];
    sprintQualiResults = sqRes.status === "fulfilled" ? sqRes.value.results ?? [] : [];
    circuitInfo = circuitInfoRes.status === "fulfilled" ? circuitInfoRes.value : null;
    weather = weatherRes.status === "fulfilled" ? weatherRes.value.weather ?? null : null;
  } else {
    try {
      circuitInfo = await getCircuitInfo(seasonYear, race.raceName);
    } catch {
      circuitInfo = null;
    }
    try {
      const weatherRes = await getRaceWeather(seasonYear, roundNumber);
      weather = weatherRes.weather ?? null;
    } catch {
      weather = null;
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
    ? { label: "Next race", bg: "rgb(var(--rgb-primary-container) / 0.16)", color: "var(--color-primary)" }
    : { label: "Upcoming", bg: "rgb(var(--rgb-veil) / 0.06)", color: "#c9c0b4" };

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
          {/* Watch-party mode, offered from the round it replays. Only for a
              round that has actually run — there is nothing to replay
              otherwise, and the watch page's empty state is for an unsynced
              round, not an unraced one. */}
          {isPast && (
            <Link
              href={`/watch/${seasonYear}-${roundNumber}`}
              className="font-bold text-xs px-5 h-[46px] rounded-control flex items-center justify-center text-[#1a1210] transition-transform duration-150 active:scale-95"
              style={{ background: "linear-gradient(90deg,var(--color-primary),var(--color-primary-container))" }}
            >
              Watch at race pace
            </Link>
          )}
          <Link
            href="/schedule"
            className="font-bold text-xs px-5 h-[46px] rounded-control apex-glass-soft flex items-center justify-center hover:border-flame-bright/50 transition-[border-color,transform] duration-150 active:scale-95"
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
              className="apex-glass-soft rounded-tile px-[22px] py-[18px]"
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
        weather={weather}
      />
    </div>
  );
}
