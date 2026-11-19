import type { NextRequest } from "next/server";
import { getActiveSeasonYear, getSeasonRaces } from "@/lib/api";
import { parseWatchParams, shareCacheControl, shareFilename } from "@/lib/share";
import { raceDayLabel } from "@/lib/watch-races";
import { cardHost } from "../../../_lib/frame";
import { memoCard, renderCard, shareError } from "../../../_lib/respond";
import { WatchCard } from "../../../_cards/watch-card";

/**
 * `GET /api/share/watch/2026/20?format=landscape|portrait`
 *
 * The link preview for a race replay (`/watch/2026-20`): the race, the circuit
 * and the day, with no result of any kind.
 *
 * A replay link is sent to people who have not seen the race, which is the whole
 * reason watch mode exists, so this route reads the calendar and **nothing
 * else**. It never requests a classification, and it does not read the
 * `winner` the calendar attaches. A test pins that
 * (`share-routes.test.ts`, "never requests results"). The race result card
 * (`/api/share/race/...`) is the one for pages that show results.
 *
 * Node runtime, like the other cards: it reads its fonts from disk.
 */
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ season: string; round: string }> }
): Promise<Response> {
  const active = getActiveSeasonYear();
  const parsed = parseWatchParams(await params, request.nextUrl.searchParams, active);
  if (!parsed.ok) return shareError(400, parsed.error);
  // Memoised by the parsed card, not the URL; see `memoCard`.
  return memoCard(`watch:${JSON.stringify(parsed.value)}`, async () => {
    const { season, round, format } = parsed.value;

    let races: Awaited<ReturnType<typeof getSeasonRaces>>["races"];
    try {
      races = (await getSeasonRaces(season)).races ?? [];
    } catch {
      return shareError(503, "The calendar is unavailable right now.");
    }
    const race = races.find((r) => Number(r.round) === round);
    if (!race) return shareError(404, `Round ${round} is not on the ${season} calendar.`);

    return renderCard(
      <WatchCard
        format={format}
        season={season}
        round={round}
        raceName={race.raceName}
        circuitName={race.Circuit?.circuitName ?? null}
        dayLabel={raceDayLabel(race.date)}
        host={cardHost()}
      />,
      format,
      {
        cacheControl: shareCacheControl(season, active),
        filename: shareFilename([race.raceName, season, "replay"], format),
      }
    );
  });
}
