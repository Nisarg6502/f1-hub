// Per-team dossiers for `/teams`: what a constructor is, and what its
// lineage has actually won.
//
// ═══════════════════════════════════════════════════════════════════════════
// PROVENANCE — READ THIS BEFORE ADDING A FIELD
// ═══════════════════════════════════════════════════════════════════════════
// This app's standing rule is that a displayed fact is traceable to data the
// app actually holds. This module renders two kinds of fact and keeps them
// physically separate so nobody has to guess which is which:
//
// COMPUTED — derived here from cached archive data, never typed by hand:
//   · debut season, seasons entered, and every era's year span
//       ← /api/constructor_seasons (Jolpica's own per-constructor season
//         list), resolved by `resolveLineages` in constructor-lineages.ts
//   · Grand Prix wins, per era and per lineage
//       ← /api/historical_race_index (one winner record per championship
//         race since 1950, from backend/app/historical_index.py)
//   · Constructors' Championships, and Drivers' Championships won with the
//     team, per era and per lineage
//       ← /api/constructor_titles (backend/app/constructor_titles.py, read
//         from Jolpica's end-of-season standings)
//   · this season's position / wins / points
//       ← /api/constructorstandings
//
// HAND-AUTHORED — the `TEAM_PROFILES` table at the bottom of this file, and
// nothing else:
//   · `base` (where the team operates from)
//   · `blurb` (one or two sentences on what the team is today)
//   The lineage itself — who became whom, and why — is ALSO hand-authored,
//   but it is not duplicated here: it lives in `constructor-lineages.ts`,
//   which already curated it season-by-season against Jolpica for the
//   `/history` genealogy chart. This module reads that file. There is
//   deliberately no second lineage table.
//
// No API returns "Racing Bulls used to be Minardi", so the editorial half is
// unavoidable. What is avoidable is presenting it as if it were measured —
// hence the split above, and hence the UI labelling `TEAM_PROFILES` content
// as an editorial note rather than a statistic.
//
// A NOTE ON WHY EVERY COUNT IS YEAR-FILTERED
// ------------------------------------------
// Ergast reuses raw constructorIds across unrelated teams decades apart
// (`mercedes` is both the 1954-55 works team and the 2010- one; `renault`
// covers 1977-85, 2002-11 and 2016-20; `sauber` covers three separate
// stints). Every count below is therefore scoped to the era's own resolved
// year range. Without that filter, Mercedes' modern era would absorb
// Fangio's 1954 and 1955 drivers' titles, which belong to a different team
// that merely shares an id.

import {
  seasonStints,
  type ResolvedLineage,
  type ResolvedNode,
} from "./constructor-lineages";

/** The fields of `/api/historical_race_index`'s race record this module
 * reads. Declared structurally rather than importing `HistoricalRace` from
 * api.ts, because api.ts imports `ConstructorTitlesResponse` from here and a
 * mutual import between the two would be a cycle. */
export interface WinnerRecord {
  season: number;
  constructor_key: string;
  indy500: boolean;
}

// --- Title payload (backend/app/constructor_titles.py) ---------------------

export interface DriverTitle {
  season: number;
  driver: string;
}

export interface ConstructorTitleEntry {
  constructor_titles: number[];
  driver_titles: DriverTitle[];
}

export interface ConstructorTitlesResponse {
  first_season: number;
  last_season: number;
  constructor_title_first_season: number;
  seasons_resolved: number;
  seasons_expected: number;
  /** False when Jolpica did not answer for every season in range. A partial
   * resolve is an UNDERCOUNT that reads like a real number, so callers must
   * hide the counts rather than show them. */
  complete: boolean;
  constructors: Record<string, ConstructorTitleEntry>;
}

// --- Era key matching ------------------------------------------------------

/**
 * Every archive key an era can legitimately be filed under.
 *
 * A node's `ergastIds` are raw Ergast ids; `colorKey` is sometimes the
 * backend's canonical key for an era Ergast files under a reused raw id
 * (`alfa` -> `alfa_sauber`), and sometimes a deliberate reuse of a
 * *different* era's key for colour only (Kick Sauber -> `bmw_sauber`). Both
 * are included, and the year filter applied by every caller is what makes
 * the second case contribute nothing.
 */
export function eraKeys(node: ResolvedNode): Set<string> {
  const keys = new Set(node.ergastIds);
  if (node.colorKey) keys.add(node.colorKey);
  return keys;
}

/** `constructor_key|season` -> number of championship wins that season. */
export type WinIndex = Map<string, number>;

/**
 * Build the win index from `/api/historical_race_index`.
 *
 * The 1950-60 Indianapolis 500 counted toward the World Championship, and the
 * backend flags those races `indy500` (see historical_index.py, defect 4).
 * They are excluded here: no constructor in any lineage this module serves
 * ever won one, so this changes no current number — it is a guard against a
 * future lineage (Kurtis Kraft, Watson) picking up "Grand Prix wins" it never
 * scored.
 */
export function buildWinIndex(races: WinnerRecord[]): WinIndex {
  const index: WinIndex = new Map();
  for (const race of races) {
    if (race.indy500) continue;
    const key = `${race.constructor_key}|${race.season}`;
    index.set(key, (index.get(key) ?? 0) + 1);
  }
  return index;
}

/**
 * An era's year span, optionally cut off at `throughSeason`.
 *
 * `/teams` can be viewed at a past season, and a lineage rendered "as of
 * 2019" must not carry wins or titles from seasons that had not happened
 * yet. Returns null when the era had not started by then.
 */
function spanThrough(
  node: ResolvedNode,
  throughSeason?: number
): [number, number] | null {
  if (node.invalid || node.startYear === null || node.endYear === null) return null;
  if (throughSeason === undefined) return [node.startYear, node.endYear];
  if (node.startYear > throughSeason) return null;
  return [node.startYear, Math.min(node.endYear, throughSeason)];
}

/** Championship race wins scored by one era, within its own year span. */
export function winsForNode(
  node: ResolvedNode,
  index: WinIndex,
  throughSeason?: number
): number {
  const span = spanThrough(node, throughSeason);
  if (!span) return 0;
  const keys = eraKeys(node);
  let wins = 0;
  for (let year = span[0]; year <= span[1]; year++) {
    for (const key of keys) wins += index.get(`${key}|${year}`) ?? 0;
  }
  return wins;
}

/** Championships won by one era, within its own year span. */
export function titlesForNode(
  node: ResolvedNode,
  titles: ConstructorTitlesResponse | null,
  throughSeason?: number
): { constructorTitles: number[]; driverTitles: DriverTitle[] } {
  const span = spanThrough(node, throughSeason);
  if (!titles || !span) {
    return { constructorTitles: [], driverTitles: [] };
  }
  const [from, to] = span;
  const constructorTitles = new Set<number>();
  const driverTitles = new Map<string, DriverTitle>();

  for (const key of eraKeys(node)) {
    const entry = titles.constructors[key];
    if (!entry) continue;
    for (const season of entry.constructor_titles) {
      if (season >= from && season <= to) constructorTitles.add(season);
    }
    for (const title of entry.driver_titles) {
      if (title.season >= from && title.season <= to) {
        // Keyed by season+driver so an era matched through both its raw id
        // and its colorKey cannot count the same title twice.
        driverTitles.set(`${title.season}|${title.driver}`, title);
      }
    }
  }

  return {
    constructorTitles: [...constructorTitles].sort((a, b) => a - b),
    driverTitles: [...driverTitles.values()].sort((a, b) => a.season - b.season),
  };
}

// --- Dossier ---------------------------------------------------------------

export interface EraStats {
  node: ResolvedNode;
  nodeIndex: number;
  /** Last season of this era at or before the season being viewed. Equals
   * `node.endYear` for every era except the one still running. */
  endYear: number;
  /** Seasons raced by this era at or before the season being viewed. */
  seasonCount: number;
  wins: number;
  constructorTitles: number[];
  driverTitles: DriverTitle[];
}

export interface TeamDossier {
  lineage: ResolvedLineage;
  profile: TeamProfile | null;
  /** Valid eras only, oldest first. */
  eras: EraStats[];
  /** The era the team is racing as now — the last resolved node. */
  current: EraStats | null;
  /** First season anything in this lineage entered a championship round.
   *
   * This is the LINEAGE's debut, so for Mercedes it is 1970 — Tyrrell. It
   * belongs beside the lineage totals and nowhere else: a card headed
   * *Mercedes* that says "on the grid since 1970" is answering a question
   * nobody asked, about a team called something else. Use `currentSince` for
   * "when is this team from". */
  debutSeason: number | null;
  /** First season of the era the team is racing as NOW — 2010 for Mercedes,
   * 2021 for Aston Martin, 1975 for Williams (which has raced under its own
   * name throughout). */
  currentSince: number | null;
  /** Seasons that current era has raced, up to `asOfSeason`. */
  currentSeasons: number;
  /** True when the lineage's FINAL node resolved to no seasons at all, so
   * which era the team is racing as now is unknown.
   *
   * Measured on the live page: with the current-grid ids throttled,
   * `eras[eras.length - 1]` silently became the previous era and the Red Bull
   * card read "on the grid since 2000 — 5 seasons as Jaguar Racing". Every
   * word of that is wrong and none of it looks wrong. Callers must render the
   * absence rather than the fallback. */
  currentEraUnresolved: boolean;
  /** Contiguous runs the CURRENT era's constructor id raced OUTSIDE this
   * LINEAGE, oldest first — the separate earlier life of a reused name.
   *
   * Mercedes raced in 1954-1955 and returned in 2010; Aston Martin in
   * 1959-1960 and returned in 2021. Those seasons are deliberately not
   * counted into any total here (they were a different team by every measure
   * except the name), but a card that never mentions them reads as if the
   * team began at its most recent debut.
   *
   * Seasons claimed by ANY era of this lineage are excluded, which is the
   * difference between "a separate entry" and "an earlier chapter of this
   * same team". Kick Sauber's id also covers 1993-2005 and 2010-2018 — but
   * those are the Sauber and BMW Sauber eras listed in this very chain, so
   * calling them a separate entry "not counted above" was false twice over.
   * Only seasons no era of the lineage claims survive. */
  priorStints: Array<[number, number]>;
  /** Real seasons raced across every era, not `now - debut` — a few lineages
   * have gaps (Honda withdrew, Sauber's stints), and `seasonCount` on each
   * node is Ergast's own season list length. */
  seasonsEntered: number;
  lineageWins: number;
  lineageConstructorTitles: number;
  lineageDriverTitles: number;
}

/**
 * Match a constructor from `/api/constructorstandings` to its lineage.
 *
 * The test is `some era of this lineage raced under this raw Ergast id`,
 * which is exactly "this constructor is a stage of this lineage". Matching
 * any era rather than only the final one is what lets the page work at a
 * past season: `/teams?season=2019` returns `racing_point`, which is a
 * middle node of the Jordan→Aston Martin chain, not its end.
 *
 * Data-driven on purpose — a hardcoded name map would need editing every
 * time a team is renamed, and renaming is the one thing these lineages do.
 */
export function findLineageForConstructor(
  lineages: ResolvedLineage[],
  constructorId: string | undefined
): ResolvedLineage | null {
  if (!constructorId) return null;
  return (
    lineages.find((lineage) =>
      lineage.nodes.some((node) => node.ergastIds.includes(constructorId))
    ) ?? null
  );
}

/**
 * Assemble one team's dossier as it stood at the end of `asOfSeason`.
 *
 * Eras that had not started by then are dropped, and every count is capped
 * at that season. Viewing `/teams?season=2019` therefore shows Racing Point
 * as the current era with 2019-and-earlier totals, not Aston Martin with
 * 2026 ones.
 */
export function buildDossier(
  lineage: ResolvedLineage,
  winIndex: WinIndex,
  titles: ConstructorTitlesResponse | null,
  asOfSeason: number
): TeamDossier {
  const eras: EraStats[] = [];
  lineage.nodes.forEach((node, nodeIndex) => {
    if (node.invalid || node.startYear === null || node.endYear === null) return;
    if (node.startYear > asOfSeason) return;
    const { constructorTitles, driverTitles } = titlesForNode(
      node,
      titles,
      asOfSeason
    );
    eras.push({
      node,
      nodeIndex,
      endYear: Math.min(node.endYear, asOfSeason),
      seasonCount: node.seasons.filter((year) => year <= asOfSeason).length,
      wins: winsForNode(node, winIndex, asOfSeason),
      constructorTitles,
      driverTitles,
    });
  });

  const starts = eras
    .map((era) => era.node.startYear)
    .filter((year): year is number => year !== null);

  // Every season any era of this lineage accounts for. Used to tell a
  // genuinely separate earlier entry apart from an earlier chapter of this
  // same chain.
  const claimed = new Set<number>();
  for (const era of eras) {
    for (const year of era.node.seasons) claimed.add(year);
  }

  // If the lineage's last node resolved to nothing, the era the team races as
  // now is unknown — and the previous era must NOT stand in for it.
  const finalNode = lineage.nodes[lineage.nodes.length - 1];
  const currentEraUnresolved = Boolean(finalNode?.invalid);
  const current = currentEraUnresolved
    ? null
    : eras.length > 0
      ? eras[eras.length - 1]
      : null;

  return {
    lineage,
    profile: TEAM_PROFILES[lineage.id] ?? null,
    eras,
    current,
    debutSeason: starts.length > 0 ? Math.min(...starts) : null,
    currentEraUnresolved,
    currentSince: current?.node.startYear ?? null,
    currentSeasons: current?.seasonCount ?? 0,
    // Everything the era's own ids raced that NO era of this lineage claims,
    // capped at the season being viewed so a past-season view cannot show a
    // stint from its own future.
    priorStints: current
      ? seasonStints(
          current.node.allSeasons.filter(
            (year) => year <= asOfSeason && !claimed.has(year)
          )
        )
      : [],
    seasonsEntered: eras.reduce((sum, era) => sum + era.seasonCount, 0),
    lineageWins: eras.reduce((sum, era) => sum + era.wins, 0),
    lineageConstructorTitles: eras.reduce(
      (sum, era) => sum + era.constructorTitles.length,
      0
    ),
    lineageDriverTitles: eras.reduce(
      (sum, era) => sum + era.driverTitles.length,
      0
    ),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// HAND-AUTHORED. Nothing below this line is computed, measured, or fetched.
// ═══════════════════════════════════════════════════════════════════════════
//
// Two fields per team, both chosen because they are stable and checkable:
//
// · `base` — where the team designs and builds its cars. Stable over decades
//   (Ferrari has been in Maranello since 1943, Williams in Grove since 1996)
//   and unaffected by rebrands, which is what makes it safe to write down.
//
// · `blurb` — what the team is *today*, in one or two sentences. Deliberately
//   free of anything countable: no win totals, no title counts, no "most
//   successful team in history" claims. Every number on a team card comes
//   from the archive; if a number appeared here it would be a number with no
//   source, which is the failure mode this whole file is arranged to prevent.
//
//   The trap this rule exists for, because the first draft of this table fell
//   into it three times: a **grid-relative superlative is a count wearing
//   words**. "One of only two entries that builds its own power unit" was
//   false the moment the 2026 grid had four (Mercedes, Ferrari, Red Bull
//   Powertrains-Ford, Audi), and it contradicted three other blurbs in this
//   same table. "The only entry built from scratch" stopped being true when
//   Cadillac entered. Neither is checkable against anything the app holds, so
//   neither can be caught by a test — state what a team *is*, not where it
//   ranks.
//
// Explicitly NOT recorded here, and why:
// · team principal / driver line-up — changes mid-season, and the app has no
//   feed to correct a stale value against.
// · founding date — the debut season is computed from Jolpica; a hand-typed
//   founding year would be a second, conflicting answer to the same question.
// · engine supplier — already computed per season by `engines.ts`.
//
// Keyed by `Lineage.id` from constructor-lineages.ts. A team with no entry
// simply renders without these two rows; nothing is invented to fill a gap.

export interface TeamProfile {
  /** Principal operating base — "Town, Country". */
  base: string;
  /** A second site that genuinely matters to how the team is organised
   * (power-unit plant, or a split chassis/engine operation). Omitted rather
   * than padded out for teams that run from one place. */
  secondBase?: string;
  blurb: string;
}

export const TEAM_PROFILES: Record<string, TeamProfile> = {
  "tyrrell-mercedes": {
    base: "Brackley, United Kingdom",
    secondBase: "Power units built at Brixworth, United Kingdom",
    blurb:
      "The Mercedes-Benz works team: it designs its own chassis at Brackley and builds its own power unit at Brixworth, and supplies that power unit to customer teams as well.",
  },
  "jordan-aston-martin": {
    base: "Silverstone, United Kingdom",
    blurb:
      "Lawrence Stroll's works Aston Martin entry, operating from a purpose-built campus alongside the Silverstone circuit. It runs customer Honda power units.",
  },
  "sauber-audi": {
    base: "Hinwil, Switzerland",
    secondBase: "Power units built at Neuburg an der Donau, Germany",
    blurb:
      "Audi's works entry, built on the Swiss racing operation Peter Sauber founded — the chassis side stays in Hinwil while Audi builds the power unit in Germany. 2026 is its first season racing under the Audi name.",
  },
  "minardi-rb": {
    base: "Faenza, Italy",
    blurb:
      "Red Bull's second team, still based in the small Emilia-Romagna town its Minardi predecessor raced out of. It shares power units and permitted components with Red Bull Racing, and races under Racing Bulls branding.",
  },
  "stewart-red-bull": {
    base: "Milton Keynes, United Kingdom",
    blurb:
      "Red Bull's senior team, and from 2026 a builder of its own power unit as well as its own chassis — through Red Bull Powertrains, established in Milton Keynes alongside the chassis operation, in partnership with Ford.",
  },
  "benetton-alpine": {
    base: "Enstone, United Kingdom",
    secondBase: "Historically paired with Renault's engine plant at Viry-Châtillon, France",
    blurb:
      "Renault's works team, racing under the group's Alpine sports-car marque. It has run from the same Enstone factory since the Benetton era.",
  },
  ferrari: {
    base: "Maranello, Italy",
    blurb:
      "The oldest team on the grid and the only one that has entered every World Championship season. Chassis and power unit are both built at Maranello, and it supplies power units to customer teams.",
  },
  mclaren: {
    base: "Woking, United Kingdom",
    blurb:
      "Founded by New Zealand driver Bruce McLaren, and on the grid continuously since 1966. It runs customer Mercedes power units from its Woking Technology Centre.",
  },
  williams: {
    base: "Grove, United Kingdom",
    blurb:
      "Founded by Sir Frank Williams and engineer Patrick Head, and independent for its whole history until American investment firm Dorilton Capital bought it in 2020. It runs customer Mercedes power units.",
  },
  haas: {
    base: "Kannapolis, North Carolina, United States",
    secondBase: "European operations at Banbury, United Kingdom and Maranello, Italy",
    blurb:
      "Gene Haas' team, and the grid's most outsourced operation by design: it buys every component the regulations permit from Ferrari and Dallara rather than building them in-house.",
  },
  cadillac: {
    base: "Fishers, Indiana, United States",
    secondBase: "European operations at Silverstone, United Kingdom",
    blurb:
      "General Motors' works entry and the grid's eleventh team, new for 2026. It runs customer Ferrari power units while its own General Motors unit is developed.",
  },
};
