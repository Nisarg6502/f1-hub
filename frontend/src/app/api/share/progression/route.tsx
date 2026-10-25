import type { NextRequest } from "next/server";
import { getActiveSeasonYear, getConstructorStandings, getDriverStandings } from "@/lib/api";
import { buildProgressionRows } from "@/lib/championship-progression";
import {
  buildConstructorSeasonLogs,
  buildDriverSeasonLogs,
  fetchSeasonResults,
  fetchSeasonSprints,
} from "@/lib/season-results";
import { parseStandingsParams, shareCacheControl, shareFilename } from "@/lib/share";
import { buildProgressionGeometry, progressionSeriesLimit } from "@/lib/share-chart";
import { getTeamColor } from "@/lib/team-colors";
import { shortTeamLabel } from "@/lib/share-results";
import { cardHost } from "../_lib/frame";
import { renderCard, shareError } from "../_lib/respond";
import { ProgressionCard, progressionChartBox } from "../_cards/progression-card";

/**
 * `GET /api/share/progression?season=2026&kind=drivers|constructors&format=…`
 *
 * The championship-progression chart from `/standings` as a PNG, built from
 * exactly the data the page builds it from — `fetchSeasonResults` +
 * `fetchSeasonSprints` → season logs → `buildProgressionRows` — so the card
 * and the chart it was shared from cannot disagree about a total.
 */
export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<Response> {
  const active = getActiveSeasonYear();
  const parsed = parseStandingsParams(request.nextUrl.searchParams, active);
  if (!parsed.ok) return shareError(400, parsed.error);
  const { season, kind, format } = parsed.value;

  let entities: Array<{ id: string; label: string; colorHex: string }>;
  let logs: Record<string, { entries: Array<{ round: number; shortName: string; points: number }> } | undefined>;
  let total: number;
  try {
    if (kind === "drivers") {
      const drivers = (await getDriverStandings(season)).driver_standings ?? [];
      total = drivers.length;
      const [rounds, sprints] = await Promise.all([
        drivers.length ? fetchSeasonResults(season, { includeQualifying: false }) : Promise.resolve([]),
        drivers.length ? fetchSeasonSprints(season).catch(() => []) : Promise.resolve([]),
      ]);
      logs = buildDriverSeasonLogs(drivers, rounds, sprints);
      entities = drivers.slice(0, progressionSeriesLimit(kind)).map((d) => ({
        id: d.Driver.driverId ?? "",
        label: d.Driver.code || d.Driver.familyName || "—",
        colorHex: getTeamColor(d.Constructors?.[0]?.name ?? "—").hex,
      }));
    } else {
      const constructors = (await getConstructorStandings(season)).constructor_standings ?? [];
      total = constructors.length;
      const [rounds, sprints] = await Promise.all([
        constructors.length ? fetchSeasonResults(season, { includeQualifying: false }) : Promise.resolve([]),
        constructors.length ? fetchSeasonSprints(season).catch(() => []) : Promise.resolve([]),
      ]);
      logs = buildConstructorSeasonLogs(constructors, rounds, sprints);
      entities = constructors.slice(0, progressionSeriesLimit(kind)).map((c) => ({
        id: c.Constructor.constructorId ?? "",
        label: shortTeamLabel(c.Constructor.name ?? "—"),
        colorHex: getTeamColor(c.Constructor.name).hex,
      }));
    }
  } catch {
    return shareError(503, "Championship data is unavailable right now.");
  }

  const rows = buildProgressionRows(
    entities.map((e) => e.id),
    logs
  );
  const box = progressionChartBox(format);
  const geometry = rows.length
    ? buildProgressionGeometry(rows, entities, box, {
        maxXLabels: format === "landscape" ? 6 : 5,
        labelGap: format === "landscape" ? 21 : 30,
      })
    : null;

  return renderCard(
    <ProgressionCard
      format={format}
      kind={kind}
      season={season}
      geometry={geometry}
      chartWidth={box.width}
      chartHeight={box.height}
      roundCount={rows.length}
      shown={entities.length}
      total={total}
      host={cardHost(request.url)}
    />,
    format,
    {
      cacheControl: shareCacheControl(season, active),
      filename: shareFilename(["title-race", season, kind], format),
    }
  );
}
