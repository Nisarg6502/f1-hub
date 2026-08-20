import Image from "next/image";
import type { Metadata } from "next";
import {
  getActiveSeasonYear,
  getConstructorSeasons,
  getConstructorStandings,
  getConstructorTitles,
  getHistoricalRaceIndex,
  resolveSeasonYear,
} from "@/lib/api";
import {
  filterToCurrentGrid,
  getAllErgastIds,
  resolveLineages,
} from "@/lib/constructor-lineages";
import {
  buildDossier,
  buildWinIndex,
  findLineageForConstructor,
  type ConstructorTitlesResponse,
} from "@/lib/constructor-profiles";
import { getEngineForTeam } from "@/lib/engines";
import { getTeamColor } from "@/lib/team-colors";
import { getTeamLogoPath } from "@/lib/team-images";
import TiltCard from "@/components/tilt-card";
import { Stagger, StaggerItem } from "@/components/motion-primitives";
import SeasonSelector from "@/components/season-selector";
import TeamHeritageCard from "@/components/team-heritage-card";
import ConstructorGenealogy from "@/components/constructor-genealogy";

// Constructor standings change after every race; render per request.
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ season?: string }>;
}

/**
 * Run an async map over `items` with at most `limit` in flight at once.
 *
 * Copied in shape from `/history`'s page, for the same reason it exists
 * there: ~9 of the ~40 constructor ids this page resolves belong to teams
 * still racing, which the backend never caches and re-fetches from Jolpica
 * on every call (see historical_index.py's `/constructor_seasons`
 * docstring). A flat Promise.all fires all of them at once and reliably
 * trips Jolpica's rate limiter for several simultaneously — and the backend
 * fails soft to `200 OK` with empty `seasons`, so a throttled response is
 * indistinguishable at the HTTP level from a real empty one. Capping how
 * many are ever in flight, plus jittered backoff per id, is what makes the
 * lineage data on this page reliable.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

/**
 * One constructor's season list, retried with jittered exponential backoff.
 *
 * An empty `seasons` is treated as a failure worth retrying, not as an answer:
 * the backend fails soft to `200 OK` with `[]` when Jolpica throttles it, which
 * is indistinguishable at the HTTP level from a constructor that genuinely
 * never raced. Retrying costs one extra call for the handful of ids that really
 * are empty, and is what stops a throttled response from rendering as a missing
 * era (see `mapWithConcurrency` above, and the genealogy chart's
 * SHOW_UNRESOLVED_WARNING note for what that looked like in production).
 *
 * Module scope, not an inline callback: the jitter makes it impure, and an
 * impure call inside a component body is a real hazard for anything React may
 * re-run — this is a Server Component that happens to be safe, and the lint
 * rule is right not to distinguish.
 */
async function fetchSeasonsWithRetry(id: string) {
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { seasons } = await getConstructorSeasons(id);
      if (seasons.length > 0 || attempt === maxAttempts - 1) {
        return [id, seasons] as const;
      }
    } catch {
      // fall through to retry / final empty result below
    }
    const backoffMs = 300 * 2 ** attempt + Math.random() * 200;
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  return [id, []] as const;
}

// Mirrors the ?season= resolution the page itself uses, so the <title> and
// description reflect whichever season is actually being viewed instead of
// the root layout's hardcoded fallback.
export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const { season } = await searchParams;
  const year = resolveSeasonYear(season);
  return {
    title: `APEX | ${year} F1 Season Hub`,
    description: `APEX — every ${year} Formula 1 constructor: where it is based, what it has won, and the chain of teams it grew out of.`,
  };
}

export default async function TeamsPage({ searchParams }: PageProps) {
  const { season } = await searchParams;
  const year = resolveSeasonYear(season);
  const activeSeason = getActiveSeasonYear();

  let constructors: Awaited<
    ReturnType<typeof getConstructorStandings>
  >["constructor_standings"] = [];
  try {
    const res = await getConstructorStandings(year);
    constructors = res.constructor_standings ?? [];
  } catch {
    // Backend offline
  }

  const list = constructors ?? [];

  // --- Heritage data -------------------------------------------------------
  //
  // Three independent sources, all failing soft on their own: a card renders
  // its season standings with or without any of them, and the heritage block
  // simply degrades to whatever resolved.
  //
  //  · historical_race_index -> every championship race winner since 1950,
  //    which is where "Grand Prix wins" per era comes from.
  //  · constructor_seasons   -> each era's real active-year span, so no year
  //    on this page is hand-typed.
  //  · constructor_titles    -> Constructors' and Drivers' Championships,
  //    computed by the backend from Jolpica's end-of-season standings.
  //
  // See constructor-profiles.ts's provenance header for which rendered facts
  // are computed from these and which are hand-authored.

  let fullRaces: Awaited<ReturnType<typeof getHistoricalRaceIndex>>["races"] = [];
  try {
    const { races } = await getHistoricalRaceIndex("full");
    fullRaces = races;
  } catch {
    // Win counts degrade to zero-with-no-source rather than a wrong number;
    // the heritage block hides them (see hasRaceIndex below).
  }

  let lineages: ReturnType<typeof resolveLineages> = [];
  try {
    const ids = getAllErgastIds();
    const results = await mapWithConcurrency(ids, 4, fetchSeasonsWithRetry);
    lineages = resolveLineages(Object.fromEntries(results));
  } catch {
    // Backend offline — cards render without their heritage block.
  }

  // `complete: false` means Jolpica did not answer for every season in the
  // range, which yields an UNDERCOUNT rather than an error — Ferrari with 12
  // titles instead of 16 reads like data. Treated as "no title data" so the
  // card hides the rows outright instead of stating a number it cannot
  // stand behind.
  let titles: ConstructorTitlesResponse | null = null;
  try {
    const payload = await getConstructorTitles();
    titles = payload.complete ? payload : null;
  } catch {
    // Endpoint unavailable — championship rows are hidden.
  }

  const hasRaceIndex = fullRaces.length > 0;
  const winIndex = buildWinIndex(fullRaces);
  // Title data stops at the last completed season; the card labels its counts
  // with whichever is earlier, that or the season being viewed.
  const titlesThroughSeason = titles
    ? Math.min(titles.last_season, year)
    : null;

  // Group constructors by their power-unit supplier
  const engineGroups = new Map<string, string[]>();
  for (const t of list) {
    const name = t.Constructor.name ?? "";
    const engine = getEngineForTeam(name, year);
    if (!engine) continue;
    const arr = engineGroups.get(engine.name) ?? [];
    arr.push(name);
    engineGroups.set(engine.name, arr);
  }

  // The genealogy chart below always shows the CURRENT grid, matching
  // `/history`, and says so in its own subtitle — a lineage chart is about
  // where today's teams came from, and re-filtering it to a past season
  // would quietly change what the section means.
  const gridLineages = filterToCurrentGrid(lineages, activeSeason);

  return (
    <div className="px-6 md:px-10 pt-11 pb-16">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-5 mb-7">
        <div>
          <span className="font-bold text-xs tracking-[0.18em] uppercase text-[#FF7A3D]">
            Constructor standings {year}
          </span>
          {/* An `h1`, not a styled div — the last two routes without one.
              Classes unchanged, so nothing moves. */}
          <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-4xl md:text-[52px] tracking-[-1.5px] mt-2">
            Teams &amp; Chassis
          </h1>
          <p className="font-medium text-[13px] text-warm-400 mt-2.5 max-w-[620px]">
            Where each team is based, what it has won, and the chain of teams
            it grew out of — most of this grid is a renamed, resold version of
            something much older.
          </p>
        </div>
        <SeasonSelector currentYear={year} maxYear={activeSeason} />
      </div>

      {list.length === 0 && (
        <div className="apex-glass-soft rounded-2xl px-6 py-12 text-center font-medium text-warm-400">
          Constructor standings are unavailable right now.
        </div>
      )}

      {/* Team cards */}
      <Stagger
        className="grid md:grid-cols-2 gap-4 mb-10 [perspective:1400px]"
        gap={0.07}
      >
        {list.map((team, idx) => {
          const name = team.Constructor.name ?? "—";
          const color = getTeamColor(name);
          const engine = getEngineForTeam(name, year);
          const mono = name.slice(0, 2).toUpperCase();
          const logoPath = getTeamLogoPath(name);

          // Matched on the raw Ergast constructorId, not the display name:
          // "RB F1 Team" / "Racing Bulls" / "Scuderia AlphaTauri" are all the
          // id `rb` and must resolve to one lineage regardless of what the
          // standings feed calls the team this season.
          const lineage = findLineageForConstructor(
            lineages,
            team.Constructor.constructorId
          );
          const dossier = lineage
            ? buildDossier(lineage, winIndex, titles, year)
            : null;

          return (
            <StaggerItem key={name || idx}>
            <TiltCard
              className="apex-glass rounded-[20px] overflow-hidden p-[26px] block h-full"
              strength={5}
            >
              {/* corner wash + blurred blob */}
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  background: `radial-gradient(140% 90% at 100% 0%, ${color.hex}22, transparent 60%)`,
                }}
              />
              <div
                className="absolute -right-10 -top-5 w-[200px] h-[200px] rounded-full blur-[30px] opacity-[0.16] pointer-events-none"
                style={{ background: color.hex }}
              />

              <div className="relative flex items-start justify-between">
                <div className="min-w-0">
                  <div className="font-[family-name:var(--font-headline)] font-extrabold text-2xl md:text-[28px] tracking-[-0.5px] truncate">
                    {name}
                  </div>
                  <div className="flex flex-wrap items-center gap-2.5 mt-2">
                    <span className="font-semibold text-[11px] tracking-[0.08em] uppercase text-warm-400">
                      {team.Constructor.nationality}
                    </span>
                    {engine && (
                      <span className="font-semibold text-[10px] tracking-[0.04em] uppercase px-2.5 py-[5px] rounded-[7px] bg-[rgba(245,235,222,0.06)] text-warm-200">
                        Power · {engine.name}
                      </span>
                    )}
                  </div>
                </div>
                {logoPath ? (
                  <div className="relative w-[54px] h-[54px] rounded-[14px] p-2 flex-none bg-[rgba(245,235,222,0.92)]">
                    <Image
                      src={logoPath}
                      alt={`${name} logo`}
                      fill
                      sizes="54px"
                      className="object-contain p-1"
                    />
                  </div>
                ) : (
                  <div
                    className="w-[54px] h-[54px] rounded-[14px] flex items-center justify-center font-[family-name:var(--font-headline)] font-extrabold text-xl flex-none"
                    style={{ background: color.hex, color: "#0a0908" }}
                  >
                    {mono}
                  </div>
                )}
              </div>

              {/* This season only — the heritage block below carries the
                  all-time figures, and the two are labelled apart so a
                  season win count is never read as a career one. */}
              <div className="relative mt-7">
                <div className="font-semibold text-[9.5px] tracking-[0.1em] uppercase text-warm-500 mb-2">
                  {year} season
                </div>
                <div className="flex items-end justify-between">
                  <div>
                    <div className="font-semibold text-[10px] tracking-[0.1em] uppercase text-warm-500">
                      Position
                    </div>
                    <div className="font-[family-name:var(--font-headline)] font-extrabold text-xl text-[#FFAE6A]">
                      P{team.position}
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="font-semibold text-[10px] tracking-[0.1em] uppercase text-warm-500">
                      Wins
                    </div>
                    <div className="font-extrabold text-[22px] tabular-nums">
                      {team.wins}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold text-[10px] tracking-[0.1em] uppercase text-warm-500">
                      Season pts
                    </div>
                    <div className="font-extrabold text-[22px] tabular-nums">
                      {team.points}
                    </div>
                  </div>
                </div>
              </div>

              {dossier && hasRaceIndex && (
                <div className="relative">
                  <TeamHeritageCard
                    dossier={dossier}
                    accentHex={color.hex}
                    titlesComplete={titles !== null}
                    titlesThroughSeason={titlesThroughSeason}
                    profileIsCurrent={year === activeSeason}
                  />
                </div>
              )}
            </TiltCard>
            </StaggerItem>
          );
        })}
      </Stagger>

      {/* CC BY 4.0 requires attribution — the Aston Martin logo is the only
          team asset under that license; the rest are public-domain/CC0. */}
      <p className="font-medium text-[10px] text-warm-500 mb-8 -mt-6">
        Aston Martin logo via{" "}
        <a
          href="https://commons.wikimedia.org/wiki/File:Aston_Martin_F1_Team_logo_2024.jpg"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-warm-300"
        >
          Wikimedia Commons
        </a>
        , licensed{" "}
        <a
          href="https://creativecommons.org/licenses/by/4.0/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-warm-300"
        >
          CC BY 4.0
        </a>
        .
      </p>

      {/* The whole grid's family tree on one timeline — the same component
          `/history` renders, given the same data, rather than a second
          genealogy built for this page. */}
      {gridLineages.length > 0 && (
        <section className="apex-glass apex-sheen rounded-[22px] p-[26px] mb-10">
          <div className="font-[family-name:var(--font-headline)] font-bold text-[19px] mb-1">
            The whole grid, on one timeline
          </div>
          <div className="font-medium text-[13px] text-warm-400 mb-[18px]">
            Every constructor on the {activeSeason} grid traced back to the team
            it started life as. Band lengths are each era&apos;s real active
            seasons; the rename notes are curated.
          </div>
          <ConstructorGenealogy lineages={gridLineages} races={fullRaces} />
        </section>
      )}

      {/* Power units */}
      {engineGroups.size > 0 && (
        <>
          <div className="font-[family-name:var(--font-headline)] font-bold text-[19px] mb-4">
            Power units
          </div>
          <Stagger className="grid grid-cols-2 lg:grid-cols-4 gap-3.5" gap={0.05}>
            {[...engineGroups.entries()].map(([engineName, teams]) => (
              <StaggerItem
                key={engineName}
                className="apex-glass-soft rounded-[14px] px-5 py-[18px]"
              >
                <div className="font-bold text-sm">{engineName}</div>
                <div className="font-medium text-xs text-warm-400 mt-1.5">
                  {teams.join(" · ")}
                </div>
              </StaggerItem>
            ))}
          </Stagger>
        </>
      )}
    </div>
  );
}
