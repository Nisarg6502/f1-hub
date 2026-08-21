import Link from "next/link";
import {
  getQualifyingResults,
  getRaceResults,
  getSessionClassification,
  getSprintResults,
  type Race,
  type RaceResult,
} from "@/lib/api";
import { getRaceWeek } from "@/lib/race-week";
import type { RaceSessionField, SessionTimelineItem } from "@/lib/sessions";
import { getTeamColor } from "@/lib/team-colors";

/**
 * A strip that only exists during a race weekend: the top three of the most
 * recent session that has actually been classified, and a way through to the
 * rest of it.
 *
 * Deliberately a glimpse. The full classification, every session's tabs, the
 * weather and the strategy all live on the round page — this is the two-second
 * "what happened while I was away" answer, and linking through is the point.
 *
 * Between weekends it renders nothing at all rather than falling back to a
 * result from a fortnight ago; the hero countdown already carries the "what's
 * next" job, and the bento's "Last time out" card carries the last winner.
 * Inside a weekend it degrades to a one-line status when a session has run
 * but its timing has not been published yet.
 */

/** How far back down the weekend's session list to look for classified results.
 *
 * Practice and sprint qualifying come from FastF1, whose upstream is blocked
 * from Cloud Run often enough that a just-finished session is frequently still
 * empty (see the sync notes in backend/app/f1_results.py). When that happens
 * the right answer is the session before it, not an empty card — but each
 * attempt is a round trip on a server-rendered page, so the walk is capped.
 */
const MAX_SESSION_LOOKBACK = 4;

type SessionRow = {
  position: string;
  familyName: string;
  constructor: string;
  time: string;
};

/**
 * Fetch one session from whichever endpoint actually owns it.
 *
 * The race, qualifying and sprint have dedicated Ergast-backed endpoints, and
 * those are used rather than `/session_classification` for a reason worth not
 * relitigating: that endpoint normalises a RACE row's `Time.time` to the
 * driver's FASTEST LAP, so a podium rendered from it reads "1:22.491" for the
 * winner instead of the race time, and P3 can appear quicker than P1.
 */
async function fetchSession(
  year: number,
  round: number,
  field: RaceSessionField
): Promise<RaceResult[]> {
  switch (field) {
    case "Race":
      return (await getRaceResults(year, round)).results ?? [];
    case "Qualifying":
      return (await getQualifyingResults(year, round)).results ?? [];
    case "Sprint":
      return (await getSprintResults(year, round)).results ?? [];
    case "FirstPractice":
      return (await getSessionClassification(year, round, "FP1")).results ?? [];
    case "SecondPractice":
      return (await getSessionClassification(year, round, "FP2")).results ?? [];
    case "ThirdPractice":
      return (await getSessionClassification(year, round, "FP3")).results ?? [];
    case "SprintQualifying":
      return (await getSessionClassification(year, round, "SQ")).results ?? [];
  }
}

/**
 * The one number worth showing per driver, which is a different number per
 * session type. Qualifying-shaped sessions are ranked on their best segment
 * time; timed sessions carry a lap time in `Time`; the race and sprint carry a
 * duration for the winner and a gap for everyone behind.
 */
function sessionTime(row: RaceResult, field: RaceSessionField): string {
  if (field === "Qualifying" || field === "SprintQualifying") {
    const best = row.Q3 || row.Q2 || row.Q1;
    if (best) return best;
  }
  return row.Time?.time || row.status || "—";
}

/** "FP1", "FP1 and FP2", "FP1, FP2 and FP3". */
function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function toRows(results: RaceResult[], field: RaceSessionField): SessionRow[] {
  return results.slice(0, 3).map((row, index) => ({
    position: row.position || String(index + 1),
    familyName: row.Driver?.familyName || row.Driver?.code || "—",
    constructor: row.Constructor?.name || "",
    time: sessionTime(row, field),
  }));
}

export default async function RaceWeekGlimpse({
  races,
  seasonYear,
  nowMs,
}: {
  races: Race[];
  seasonYear: number;
  nowMs: number;
}) {
  const week = getRaceWeek(races, nowMs);
  if (!week) return null;

  const round = Number(week.race.round);
  if (!Number.isFinite(round)) return null;

  let session: SessionTimelineItem | null = null;
  let rows: SessionRow[] = [];

  for (const candidate of week.finished.slice(0, MAX_SESSION_LOOKBACK)) {
    try {
      const results = await fetchSession(seasonYear, round, candidate.sessionField);
      if (results.length > 0) {
        session = candidate;
        rows = toRows(results, candidate.sessionField);
        break;
      }
    } catch {
      // Try the session before it — one unavailable endpoint should not cost
      // the whole strip.
    }
  }

  const gpName = week.race.raceName.replace(" Grand Prix", " GP");
  const live = week.live;
  const hasResult = session !== null && rows.length > 0;

  // Chronological, because the fallback sentence names them in the order they
  // were run; `week.finished` is ordered newest-first for the result walk above.
  const ranSessions = [...week.finished].reverse();
  const ranLabel = formatList(ranSessions.map((s) => s.sessionLabel));

  // Nothing has run, nothing is running, nothing is classified: there is no
  // glimpse to give that the hero's countdown does not already give better.
  if (!hasResult && ranSessions.length === 0 && !live) return null;

  return (
    <section className="px-6 md:px-10 mt-2 mb-9">
      <Link
        href={`/schedule/${seasonYear}/${round}`}
        aria-label={
          hasResult
            ? `${session!.sessionLabel} result for the ${week.race.raceName} — see the full session results`
            : `${week.race.raceName} weekend — see every session`
        }
        className="group block anim-fade"
        style={{ animationDelay: "0.65s" }}
      >
        <div className="apex-glass rounded-[16px] px-4 sm:px-5 py-4 transition-colors group-hover:bg-[rgba(245,235,222,0.05)]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-3">
            {live ? (
              <span className="inline-flex items-center gap-2 rounded-full bg-[rgba(255,90,31,0.16)] px-2.5 py-1 font-bold text-[10px] tracking-[0.14em] uppercase text-[#FFAE6A]">
                {/* Two stacked dots: the outer one pings, the inner one is the
                    steady mark that survives `prefers-reduced-motion`, which
                    Tailwind's `motion-safe:` variant turns the ping off for. */}
                <span className="relative flex w-1.5 h-1.5 flex-none">
                  <span className="absolute inline-flex w-full h-full rounded-full bg-[#FF5A1F] opacity-75 motion-safe:animate-ping" />
                  <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-[#FF5A1F]" />
                </span>
                {live.sessionLabel} live
              </span>
            ) : (
              <span className="font-bold text-[10px] tracking-[0.14em] uppercase text-[#FF7A3D]">
                Race week
              </span>
            )}
            <span className="font-semibold text-[10px] tracking-[0.1em] uppercase text-warm-400 truncate">
              {gpName}
              {hasResult ? ` · ${session!.sessionLabel}` : ""}
            </span>
            <span className="ml-auto font-semibold text-[10px] tracking-[0.06em] uppercase text-warm-500 whitespace-nowrap group-hover:text-warm-300 transition-colors">
              {hasResult ? "Full results →" : "Weekend →"}
            </span>
          </div>

          {/* Sessions have run but none is classified yet — normal on a Friday,
              and not rare later either, since practice and sprint qualifying
              come from FastF1 and can lag hours behind the chequered flag.
              Says so in a sentence rather than reprinting the weekend's
              schedule: the hero directly above already lists every upcoming
              session with its local time, and a second row of the same chips
              is noise. Which sessions have already run, and that their timing
              is simply late, is the part the hero does not carry. */}
          {!hasResult && (
            <p className="font-medium text-[12px] text-warm-400">
              {ranSessions.length > 0
                ? `${ranLabel} ${ranSessions.length === 1 ? "has" : "have"} run — classified timing hasn't been published yet.`
                : "Timing appears here as soon as the session is classified."}
            </p>
          )}

          {hasResult && (
          <ol className="grid gap-2 sm:grid-cols-3">
            {rows.map((row) => {
              const color = getTeamColor(row.constructor);
              const isWinner = row.position === "1";
              return (
                <li
                  key={`${row.position}-${row.familyName}`}
                  className="flex items-stretch gap-2.5 rounded-[12px] bg-[rgba(245,235,222,0.04)] px-3 py-2.5 min-w-0"
                >
                  <span
                    aria-hidden
                    className="w-[3px] rounded-full flex-none"
                    style={{ background: color.hex }}
                  />
                  <span
                    className={`self-center font-[family-name:var(--font-headline)] font-extrabold text-[15px] tabular-nums flex-none ${
                      isWinner ? "text-[#FFAE6A]" : "text-warm-500"
                    }`}
                  >
                    {row.position}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-bold text-[13px] truncate">
                      {row.familyName}
                    </span>
                    <span className="block font-medium text-[10.5px] text-warm-500 truncate">
                      {row.constructor || "—"}
                    </span>
                  </span>
                  <span
                    className={`self-center font-semibold text-[11.5px] tabular-nums whitespace-nowrap ${
                      isWinner ? "text-[#FFAE6A]" : "text-warm-300"
                    }`}
                  >
                    {row.time}
                  </span>
                </li>
              );
            })}
          </ol>
          )}
        </div>
      </Link>
    </section>
  );
}
