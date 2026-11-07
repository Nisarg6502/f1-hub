import { getActiveSeasonYear, getSeasonRaces } from "@/lib/api";
import {
  buildIcs,
  extractSessions,
  filterSessions,
  parseSessionTypes,
  SESSION_TYPE_LABELS,
} from "@/lib/race-calendar";
import { publicSiteUrl } from "@/lib/site-url";

/**
 * `GET /api/calendar/<anything>.ics?sessions=race,qualifying,…` — the current
 * season as a subscribable iCalendar feed. No account needed.
 *
 * A catch-all so the URL can END in `.ics` (`/api/calendar/apex-f1.ics`):
 * some calendar clients decide whether a subscription URL is a calendar by
 * its extension, and every one of them accepts a query string after it.
 * `sessions` picks the session types (see `parseSessionTypes`); `download=1`
 * serves the same body as an attachment for a one-off import.
 *
 * Times are UTC (`…Z`), so the feed needs no VTIMEZONE and every client
 * shows the reader's own local time. Each event has a stable UID, so a
 * rescheduled session moves rather than duplicates on the next refresh.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string[] }> }
) {
  const { name } = await params;
  const last = name[name.length - 1] ?? "";
  if (name.length !== 1 || !/^[\w.-]{1,64}\.ics$/i.test(last)) {
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const types = parseSessionTypes(url.searchParams.get("sessions"));
  const season = getActiveSeasonYear();

  let races;
  try {
    races = (await getSeasonRaces(season)).races ?? [];
  } catch {
    // An error, not an empty calendar: a subscribed client that receives a
    // valid empty feed DELETES every event it had. A 503 makes it keep them.
    return new Response("Schedule temporarily unavailable", {
      status: 503,
      headers: { "Retry-After": "600", "Cache-Control": "no-store" },
    });
  }

  const sessions = filterSessions(extractSessions(races), types);
  const label = types.length === 5 ? "all sessions" : types.map((t) => SESSION_TYPE_LABELS[t]).join(", ");
  const body = buildIcs(sessions, {
    siteUrl: publicSiteUrl(request),
    nowMs: Date.now(),
    name: `F1 ${season} · ${label} · APEX`,
  });

  const headers: Record<string, string> = {
    "Content-Type": "text/calendar; charset=utf-8",
    "Cache-Control": "public, max-age=3600, s-maxage=3600",
  };
  if (url.searchParams.get("download") === "1") {
    headers["Content-Disposition"] = `attachment; filename="apex-f1-${season}.ics"`;
  }
  return new Response(body, { headers });
}
