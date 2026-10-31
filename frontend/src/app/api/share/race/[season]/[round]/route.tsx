import type { NextRequest } from "next/server";
import { getActiveSeasonYear, getRaceResults, getSeasonRaces, getSprintResults } from "@/lib/api";
import { parseRaceParams, shareCacheControl, shareFilename } from "@/lib/share";
import { hasClassification, resultRows } from "@/lib/share-results";
import { loadDriverPortrait } from "../../../_lib/assets";
import { cardHost } from "../../../_lib/frame";
import { memoCard, renderCard, shareError } from "../../../_lib/respond";
import { RaceCard } from "../../../_cards/race-card";

/**
 * `GET /api/share/race/2026/5?session=race|sprint&format=landscape|portrait`
 *
 * One session's podium and top ten as a PNG. Shaped like the page's own URL
 * (`/schedule/2026/5`) so the two are obviously the same thing.
 *
 * 404 rather than an empty card for a session with nothing to show. Unlike
 * standings — where "no races yet" is a true statement about a season worth
 * a card — a race result with no classification has nothing to say, and the
 * share button is not offered on the page in that state anyway. That covers a
 * round still to be run, a sprint on a weekend without one, and the rounds
 * whose rows exist with every position empty.
 */
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ season: string; round: string }> }
): Promise<Response> {
  const active = getActiveSeasonYear();
  const parsed = parseRaceParams(await params, request.nextUrl.searchParams, active);
  if (!parsed.ok) return shareError(400, parsed.error);
  // Memoised by the parsed card, not the URL; see `memoCard`.
  return memoCard(`race:${JSON.stringify(parsed.value)}`, async () => {
  const { season, round, session, format } = parsed.value;

  let races: Awaited<ReturnType<typeof getSeasonRaces>>["races"];
  try {
    races = (await getSeasonRaces(season)).races ?? [];
  } catch {
    return shareError(503, "The calendar is unavailable right now.");
  }
  const race = races.find((r) => Number(r.round) === round);
  if (!race) return shareError(404, `Round ${round} is not on the ${season} calendar.`);
  if (session === "sprint" && !race.Sprint) {
    return shareError(404, `The ${season} ${race.raceName} had no sprint.`);
  }

  let results;
  try {
    const res = session === "sprint" ? await getSprintResults(season, round) : await getRaceResults(season, round);
    results = res.results ?? [];
  } catch {
    // The backend answers a not-yet-run session with an error rather than an
    // empty list, so this is "nothing to show" far more often than "down".
    return shareError(404, "No classification is available for this session yet.");
  }
  if (!hasClassification(results)) {
    return shareError(404, "No classification is available for this session yet.");
  }

  const rows = resultRows(results, 10);
  const podiumPortraits = await Promise.all(
    rows.slice(0, 3).map(async (row) => [row.position, await loadDriverPortrait(row.givenName, row.familyName)] as const)
  );

  return renderCard(
    <RaceCard
      format={format}
      season={season}
      round={round}
      session={session}
      raceName={race.raceName}
      circuitName={race.Circuit?.circuitName ?? null}
      rows={rows}
      portraits={Object.fromEntries(podiumPortraits)}
      host={cardHost()}
    />,
    format,
    {
      cacheControl: shareCacheControl(season, active),
      filename: shareFilename([race.raceName, season, session === "sprint" ? "sprint" : null], format),
    }
  );
  });
}
