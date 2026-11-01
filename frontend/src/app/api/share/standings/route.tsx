import type { NextRequest } from "next/server";
import {
  getActiveSeasonYear,
  getConstructorStandings,
  getDriverStandings,
  getSeasonRaces,
} from "@/lib/api";
import { parseStandingsParams, shareCacheControl, shareFilename } from "@/lib/share";
import { constructorStandingRows, driverStandingRows, lastScoredRound } from "@/lib/share-results";
import { loadDriverPortrait } from "../_lib/assets";
import { cardHost } from "../_lib/frame";
import { memoCard, renderCard, shareError } from "../_lib/respond";
import { StandingsCard, standingsRowLimit } from "../_cards/standings-card";

/**
 * `GET /api/share/standings?season=2026&kind=drivers|constructors&format=landscape|portrait`
 *
 * The championship table as a PNG. Every parameter is optional — the bare URL
 * is the current drivers' standings in landscape, which is what a link
 * preview asks for — but every parameter that IS given is validated, and a
 * bad one is a 400 (see `lib/share.ts`).
 *
 * Node runtime: the card reads its fonts and portraits from disk.
 */
export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<Response> {
  const active = getActiveSeasonYear();
  const parsed = parseStandingsParams(request.nextUrl.searchParams, active);
  if (!parsed.ok) return shareError(400, parsed.error);
  // Memoised by the parsed card, not the URL; see `memoCard`.
  return memoCard(`standings:${JSON.stringify(parsed.value)}`, async () => {
  const { season, kind, format } = parsed.value;

  let standings: Parameters<typeof driverStandingRows>[0] | Parameters<typeof constructorStandingRows>[0];
  let races: Awaited<ReturnType<typeof getSeasonRaces>>["races"] = [];
  try {
    const [table, calendar] = await Promise.all([
      kind === "drivers"
        ? getDriverStandings(season).then((r) => r.driver_standings ?? [])
        : getConstructorStandings(season).then((r) => r.constructor_standings ?? []),
      // The calendar only supplies "after round N"; a card without that line
      // is still a correct card, so its failure is not the request's.
      getSeasonRaces(season).catch(() => ({ races: [] })),
    ]);
    standings = table;
    races = calendar.races ?? [];
  } catch {
    return shareError(503, "Standings are unavailable right now.");
  }

  const limit = standingsRowLimit(kind);
  const rows =
    kind === "drivers"
      ? driverStandingRows(standings as Parameters<typeof driverStandingRows>[0], limit)
      : constructorStandingRows(standings as Parameters<typeof constructorStandingRows>[0], limit);
  const leaderPortrait =
    kind === "drivers" && rows[0] ? await loadDriverPortrait(rows[0].givenName, rows[0].familyName) : null;

  return renderCard(
    <StandingsCard
      format={format}
      kind={kind}
      season={season}
      rows={rows}
      totalEntries={standings.length}
      leaderPortrait={leaderPortrait}
      afterRound={lastScoredRound(races)}
      isFinal={season < active}
      host={cardHost()}
    />,
    format,
    {
      cacheControl: shareCacheControl(season, active),
      filename: shareFilename(["standings", season, kind], format),
    }
  );
  });
}
