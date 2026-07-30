// Curated Constructor Genealogy lineages for the `/history` page (Batch 14,
// CP49). This is the actual moat of the feature: F1 team lineage does not
// exist anywhere as a clean, machine-readable graph, so every lineage below
// was verified season-by-season against Jolpica/Ergast's own
// `/constructors/{id}/seasons` data before being written down here.
//
// Scope is a deliberate ~17 lineages / ~42 nodes / ~25 rename edges, not all
// ~214 constructorIds Ergast has ever recorded — enough to make the tree
// legible and the "team X became team Y" story land, without turning this
// into an unbounded curation project. Long-running teams that never renamed
// (Ferrari, McLaren, Williams, Haas, Brabham, classic Lotus, Cooper, BRM,
// Vanwall) are included as one-node lineages specifically for visual
// contrast against the ones that kept changing names — per the CP49 brief.
//
// The chart itself renders only the lineages that END on a constructor still
// racing this season (see `filterToCurrentGrid` at the bottom of this file).
// The extinct lineages below are deliberately kept in the data rather than
// deleted: they are hand-verified curation that costs nothing to hold, they
// document the `lotus`/`lotus_f1` and `renault`/`renault` era traps that the
// live lineages depend on being understood, and re-showing them is a
// one-line change if the page ever wants an "all eras" toggle.
//
// A node's `ergastIds` are RAW Ergast constructorIds — the exact strings
// `/api/constructor_seasons` (backend/app/historical_index.py) expects. Some
// raw ids are reused by Ergast across totally unrelated eras decades apart
// (`sauber`, `renault`, `honda`, `mercedes`, `aston_martin`) — `yearRange`
// slices a node down to only the seasons that belong to *this* era. Some
// teams are fragmented across chassis/engine-era ids in the early decades
// (classic Lotus, Brabham, Cooper) — `ergastIds` lists all of them and their
// season lists are unioned, mirroring backend's own `CONSTRUCTOR_ALIASES`
// collapse for the exact same ids.
//
// Colour resolution: `colorKey`, when present, is passed to
// `getConstructorIdentity` (constructor-identity.ts) — used wherever that
// file already has a correct mapping for this era (including a couple of
// deliberate reuses: `racing_point` also resolves current-grid Aston Martin
// green, `bmw_sauber` also resolves current-grid Sauber/Audi green, so the
// modern end of a lineage always matches `/standings` exactly). Where no
// clean mapping exists at all (Ergast ids `bar`, `mf1`, `spyker`,
// `force_india`, `sauber` itself, `minardi`, `rb`, `jaguar` have no entry in
// either of that file's maps), `fallbackHex` supplies an approximate,
// hand-picked historical livery colour instead of falling through to that
// file's generic orange placeholder.

export interface LineageNode {
  /** Raw Ergast constructorId(s) queried via /api/constructor_seasons. More
   * than one entry means this era's seasons are the union of several
   * chassis/engine-split ids (classic Lotus, Brabham, Cooper). */
  ergastIds: string[];
  /** Display label for this specific era (may differ from Ergast's own
   * `name` field, e.g. "Midland F1" for the raw id `mf1`). */
  label: string;
  /** Idiomatic short form, used only when the era's band is too narrow for
   * `label` but wide enough for this. Curated (not derived) because the
   * only abbreviations worth showing are the ones people actually say —
   * "BAR", "BMW", "Alfa Romeo" — and a generic truncation would produce
   * "British Ame…" / "Alfa Romeo …" instead. Eras too narrow for even this
   * get an out-of-band callout label; see constructor-genealogy.tsx. */
  abbr?: string;
  /** Resolves via getConstructorIdentity when it already has a correct
   * mapping for this era. */
  colorKey?: string;
  /** Approximate historical livery colour, hand-picked when no
   * getConstructorIdentity mapping exists for this raw id/era at all. */
  fallbackHex?: string;
  /** Restricts the queried season list to this inclusive range, for raw ids
   * Ergast reuses across unrelated eras decades apart. */
  yearRange?: [number, number];
  /** One-line curated note — why the team changed hands/name here. Sourced
   * from this file, not computed, per the CP49 brief. */
  note: string;
}

export interface Lineage {
  id: string;
  /** Full chain, for the section's own reference / accessible label. */
  title: string;
  /** Short label rendered next to the row in the chart. */
  shortTitle: string;
  nodes: LineageNode[];
}

export const CONSTRUCTOR_LINEAGES: Lineage[] = [
  {
    id: "tyrrell-mercedes",
    title: "Tyrrell → BAR → Honda → Brawn → Mercedes",
    shortTitle: "Tyrrell → Mercedes",
    nodes: [
      {
        ergastIds: ["tyrrell"],
        label: "Tyrrell",
        colorKey: "tyrrell",
        note: "Ken Tyrrell's team ran its own chassis from 1970 and stayed independent for 29 seasons.",
      },
      {
        ergastIds: ["bar"],
        label: "British American Racing",
        abbr: "BAR",
        fallbackHex: "#C4122E",
        note: "British American Tobacco bought Tyrrell for 1999 and rebranded it BAR.",
      },
      {
        ergastIds: ["honda"],
        label: "Honda",
        colorKey: "honda",
        yearRange: [2006, 2008],
        note: "Honda, BAR's engine partner since 2000, bought full control for 2006 and raced under its own name until withdrawing at the end of 2008.",
      },
      {
        ergastIds: ["brawn"],
        label: "Brawn GP",
        colorKey: "brawn",
        note: "Team principal Ross Brawn led a management buyout after Honda's withdrawal; the reborn team won both 2009 titles in its only season.",
      },
      {
        ergastIds: ["mercedes"],
        label: "Mercedes",
        colorKey: "mercedes",
        yearRange: [2010, 2026],
        note: "Mercedes bought Brawn GP at the end of 2009 and has raced as a full works team ever since.",
      },
    ],
  },
  {
    id: "jordan-aston-martin",
    title:
      "Jordan → Midland → Spyker → Force India → Racing Point → Aston Martin",
    shortTitle: "Jordan → Aston Martin",
    nodes: [
      {
        ergastIds: ["jordan"],
        label: "Jordan",
        colorKey: "jordan",
        note: "Eddie Jordan's team, a grid fixture from 1991, scored its sole win in 1999 (Belgian GP).",
      },
      {
        ergastIds: ["mf1"],
        label: "Midland F1",
        abbr: "Midland",
        fallbackHex: "#8B0000",
        note: "Eddie Jordan sold the team to Russian-backed Midland Group for the 2006 season.",
      },
      {
        ergastIds: ["spyker"],
        label: "Spyker",
        fallbackHex: "#FF6A00",
        note: "Dutch sports-car maker Spyker Cars bought the team mid-2006, racing under its own name from 2007.",
      },
      {
        ergastIds: ["force_india"],
        label: "Force India",
        fallbackHex: "#00A651",
        note: "Vijay Mallya's consortium bought the team from Spyker for 2008.",
      },
      {
        ergastIds: ["racing_point"],
        label: "Racing Point",
        fallbackHex: "#F363B3",
        note: "Force India entered administration in mid-2018; a Lawrence Stroll-led consortium bought the assets and renamed it Racing Point for 2019.",
      },
      {
        ergastIds: ["aston_martin"],
        label: "Aston Martin",
        colorKey: "racing_point",
        yearRange: [2021, 2026],
        note: "Stroll rebranded the team Aston Martin for 2021 — reviving the marque's F1 name after a 61-year gap (see the separate 1959-60 Aston Martin works entry, unrelated to this lineage).",
      },
    ],
  },
  {
    id: "sauber-audi",
    title:
      "Sauber → BMW Sauber → Sauber → Alfa Romeo Racing → Kick Sauber → Audi",
    shortTitle: "Sauber → Audi",
    nodes: [
      {
        ergastIds: ["sauber"],
        label: "Sauber",
        fallbackHex: "#006F62",
        yearRange: [1993, 2005],
        note: "Peter Sauber's independent Swiss team enters F1 in 1993.",
      },
      {
        ergastIds: ["bmw_sauber"],
        label: "BMW Sauber",
        abbr: "BMW",
        colorKey: "bmw_sauber",
        note: "BMW bought a controlling stake for 2006, racing as a BMW works team through 2009.",
      },
      {
        ergastIds: ["sauber"],
        label: "Sauber",
        fallbackHex: "#0EA5A0",
        yearRange: [2010, 2018],
        note: "BMW withdrew after 2009; Peter Sauber reacquired the team, which reverted to independent Sauber entries.",
      },
      {
        ergastIds: ["alfa"],
        label: "Alfa Romeo Racing",
        abbr: "Alfa Romeo",
        colorKey: "alfa_sauber",
        yearRange: [2019, 2023],
        note: "Sauber struck a title-branding deal with Alfa Romeo, racing as Alfa Romeo 2019-2023 (a licensing arrangement, not the same company as the 1950s/1980s Alfa Romeo works entries).",
      },
      {
        ergastIds: ["sauber"],
        label: "Kick Sauber",
        abbr: "Kick",
        colorKey: "bmw_sauber",
        yearRange: [2024, 2025],
        note: "The Alfa Romeo branding ended; the team ran 2024-2025 under Kick's sponsorship while Audi's factory buy-in completed.",
      },
      {
        ergastIds: ["audi"],
        label: "Audi",
        colorKey: "bmw_sauber",
        note: "Audi completed its buy-in and became the constructor of record from 2026, its first season racing under its own name.",
      },
    ],
  },
  {
    id: "minardi-rb",
    title: "Minardi → Toro Rosso → AlphaTauri → RB",
    shortTitle: "Minardi → RB",
    nodes: [
      {
        ergastIds: ["minardi"],
        label: "Minardi",
        fallbackHex: "#F2B705",
        note: "Giancarlo Minardi's perennial Faenza independent, on the grid from 1985.",
      },
      {
        ergastIds: ["toro_rosso"],
        label: "Toro Rosso",
        colorKey: "toro_rosso",
        note: "Red Bull bought Minardi at the end of 2005 to run as its junior team, renamed Scuderia Toro Rosso.",
      },
      {
        ergastIds: ["alphatauri"],
        label: "AlphaTauri",
        colorKey: "alphatauri",
        note: "Renamed AlphaTauri for 2020 to promote Red Bull's fashion label of the same name.",
      },
      {
        ergastIds: ["rb"],
        label: "RB",
        fallbackHex: "#6692FF",
        note: "Renamed again to RB (Visa Cash App RB) for 2024, dropping the AlphaTauri branding.",
      },
    ],
  },
  {
    id: "stewart-red-bull",
    title: "Stewart → Jaguar → Red Bull",
    shortTitle: "Stewart → Red Bull",
    nodes: [
      {
        ergastIds: ["stewart"],
        label: "Stewart Grand Prix",
        abbr: "Stewart",
        colorKey: "stewart",
        note: "Jackie Stewart's team, on the grid 1997-1999, won the 1999 European GP.",
      },
      {
        ergastIds: ["jaguar"],
        label: "Jaguar Racing",
        abbr: "Jaguar",
        fallbackHex: "#1B4D3E",
        note: "Ford bought Stewart for 2000 and rebranded it Jaguar Racing.",
      },
      {
        ergastIds: ["red_bull"],
        label: "Red Bull Racing",
        abbr: "Red Bull",
        colorKey: "red_bull",
        note: "Ford sold the unprofitable team to Red Bull for 2005, who renamed it Red Bull Racing.",
      },
    ],
  },
  {
    id: "benetton-alpine",
    title: "Benetton → Renault → Lotus F1 Team → Renault → Alpine",
    shortTitle: "Benetton → Alpine",
    nodes: [
      {
        ergastIds: ["benetton"],
        label: "Benetton",
        colorKey: "benetton",
        note: "The Benetton family's team, on the grid 1986-2001, won titles with Schumacher in 1994-95.",
      },
      {
        ergastIds: ["renault"],
        label: "Renault",
        colorKey: "renault",
        yearRange: [2002, 2011],
        note: "Renault bought Benetton in 2000, racing under the Benetton name through 2001 before rebranding Renault F1 for 2002.",
      },
      {
        ergastIds: ["lotus_f1"],
        label: "Lotus F1 Team",
        abbr: "Lotus",
        colorKey: "lotus_f1",
        note: "Renault sold the team to Genii Capital, renamed Lotus F1 Team for 2012 — unrelated to the classic 1958-1994 Team Lotus lineage.",
      },
      {
        ergastIds: ["renault"],
        label: "Renault",
        colorKey: "renault",
        yearRange: [2016, 2020],
        note: "Renault bought the team back for 2016 and reverted the name to Renault.",
      },
      {
        ergastIds: ["alpine"],
        label: "Alpine",
        colorKey: "alpine",
        note: "Renault rebranded its works team Alpine for 2021, after its own performance-car marque.",
      },
    ],
  },
  // Below: current-grid entries that have never renamed or changed hands.
  // Rendered as single unbroken bands, which is the visual contrast that
  // makes the multi-era chains above read as unusual rather than normal.
  {
    id: "ferrari",
    title: "Ferrari",
    shortTitle: "Ferrari",
    nodes: [
      {
        ergastIds: ["ferrari"],
        label: "Ferrari",
        colorKey: "ferrari",
        note: "The only team to have competed continuously since the first World Championship season in 1950.",
      },
    ],
  },
  {
    id: "mclaren",
    title: "McLaren",
    shortTitle: "McLaren",
    nodes: [
      {
        ergastIds: ["mclaren", "mclaren-ford"],
        label: "McLaren",
        colorKey: "mclaren",
        note: "Bruce McLaren's team, on the grid continuously since 1966 (briefly filed under Ergast's separate 'McLaren-Ford' engine-era id, 1966-1970).",
      },
    ],
  },
  {
    id: "williams",
    title: "Williams",
    shortTitle: "Williams",
    nodes: [
      {
        ergastIds: ["williams"],
        label: "Williams",
        colorKey: "williams",
        note: "Sir Frank Williams' team has raced under its own name continuously since 1975.",
      },
    ],
  },
  {
    id: "haas",
    title: "Haas",
    shortTitle: "Haas",
    nodes: [
      {
        ergastIds: ["haas"],
        label: "Haas",
        colorKey: "haas",
        note: "Gene Haas' team entered in 2016 as F1's first American constructor since 1986, and is the only current entry that was built from scratch rather than bought from a predecessor.",
      },
    ],
  },
  {
    id: "cadillac",
    title: "Cadillac",
    shortTitle: "Cadillac",
    nodes: [
      {
        ergastIds: ["cadillac"],
        label: "Cadillac",
        colorKey: "cadillac",
        note: "The grid's eleventh team, new for 2026 — General Motors' first works F1 entry, running Ferrari power units until its own unit arrives.",
      },
    ],
  },
  {
    id: "renault-works",
    title: "Renault (works team, 1977-1985)",
    shortTitle: "Renault (1st stint)",
    nodes: [
      {
        ergastIds: ["renault"],
        label: "Renault",
        colorKey: "renault",
        yearRange: [1977, 1985],
        note: "Renault's first F1 works effort, pioneer of the turbocharged engine; withdrew after 1985. Genealogically separate from the Benetton-descended Renault lineage below — it did not become that team.",
      },
    ],
  },
  {
    id: "brabham",
    title: "Brabham",
    shortTitle: "Brabham",
    nodes: [
      {
        ergastIds: [
          "brabham",
          "brabham-climax",
          "brabham-ford",
          "brabham-repco",
          "brabham-alfa_romeo",
        ],
        label: "Brabham",
        colorKey: "brabham",
        note: "Jack Brabham's constructor, on the grid 1962-1992 (split across several chassis/engine-era ids in Ergast's own data).",
      },
    ],
  },
  {
    id: "lotus-classic",
    title: "Lotus (classic Team Lotus, 1958-1994)",
    shortTitle: "Lotus (classic)",
    nodes: [
      {
        ergastIds: ["team_lotus", "lotus-climax", "lotus-ford", "lotus-brm"],
        label: "Lotus",
        colorKey: "lotus",
        note: "Colin Chapman's Team Lotus, 1958-1994 — unrelated to the 2012-2015 'Lotus F1 Team' further up this tree, which only borrowed the name.",
      },
    ],
  },
  {
    id: "cooper",
    title: "Cooper",
    shortTitle: "Cooper",
    nodes: [
      {
        ergastIds: ["cooper", "cooper-climax", "cooper-maserati"],
        label: "Cooper",
        colorKey: "cooper",
        note: "Pioneered the rear/mid-engined layout that made front-engined cars obsolete; won back-to-back titles 1959-1960.",
      },
    ],
  },
  {
    id: "brm",
    title: "BRM",
    shortTitle: "BRM",
    nodes: [
      {
        ergastIds: ["brm"],
        label: "BRM",
        colorKey: "brm",
        note: "British Racing Motors, on the grid 1951-1977; won the 1962 title with Graham Hill.",
      },
    ],
  },
  {
    id: "vanwall",
    title: "Vanwall",
    shortTitle: "Vanwall",
    nodes: [
      {
        ergastIds: ["vanwall"],
        label: "Vanwall",
        colorKey: "vanwall",
        note: "Tony Vandervell's team won F1's first-ever Constructors' Championship in 1958.",
      },
    ],
  },
];

/** Every unique raw Ergast constructorId referenced anywhere above, for the
 * page to resolve in one batch of /api/constructor_seasons calls. */
export function getAllErgastIds(): string[] {
  const ids = new Set<string>();
  for (const lineage of CONSTRUCTOR_LINEAGES) {
    for (const node of lineage.nodes) {
      for (const id of node.ergastIds) ids.add(id);
    }
  }
  return Array.from(ids);
}

export interface ResolvedNode extends LineageNode {
  startYear: number | null;
  endYear: number | null;
  /** How many seasons this era actually raced. Not `endYear - startYear + 1`
   * — a few eras have gaps in Ergast's own season list, so this is the real
   * count and can be smaller than the span the band covers. */
  seasonCount: number;
  /** True when the resolved season list came back empty — a curation
   * error (typo'd id, wrong yearRange) rather than a real gap. Rendered
   * distinctly rather than silently dropped. */
  invalid: boolean;
}

export interface ResolvedLineage extends Omit<Lineage, "nodes"> {
  nodes: ResolvedNode[];
}

/** Resolve every node's real active-year span from a map of
 * ergastId -> seasons (as returned by /api/constructor_seasons for each id
 * collected by getAllErgastIds). Purely a data transform — no fetching
 * here, so it can run in a server component. */
export function resolveLineages(
  seasonsById: Record<string, number[]>
): ResolvedLineage[] {
  return CONSTRUCTOR_LINEAGES.map((lineage) => ({
    ...lineage,
    nodes: lineage.nodes.map((node) => {
      let years = node.ergastIds.flatMap((id) => seasonsById[id] ?? []);
      if (node.yearRange) {
        const [from, to] = node.yearRange;
        years = years.filter((y) => y >= from && y <= to);
      }
      years = Array.from(new Set(years)).sort((a, b) => a - b);

      if (years.length === 0) {
        return {
          ...node,
          startYear: null,
          endYear: null,
          seasonCount: 0,
          invalid: true,
        };
      }

      return {
        ...node,
        startYear: years[0],
        endYear: years[years.length - 1],
        seasonCount: years.length,
        invalid: false,
      };
    }),
  }));
}

/**
 * Keep only the lineages that are still running — i.e. whose FINAL era is
 * still racing in `activeSeason`, which is exactly "this constructor is on
 * the current grid".
 *
 * The test is on resolved data, not a hardcoded list of team names: a
 * lineage's last node's `endYear` comes from `/api/constructor_seasons`,
 * which is Ergast's own record of which seasons that constructorId entered.
 * A constructor with a `2026` season IS the 2026 grid — the same source
 * `/api/constructorstandings?year=2026` is built from — so this can never
 * drift out of date the way a literal ["mercedes", "ferrari", …] array
 * would when a team is bought, renamed, or added.
 *
 * Lineages whose final era failed to resolve at all (`invalid`) are KEPT, so
 * a curation error still surfaces as the visible warning the chart renders
 * for it rather than being silently filtered out of existence.
 */
export function filterToCurrentGrid(
  lineages: ResolvedLineage[],
  activeSeason: number
): ResolvedLineage[] {
  return lineages.filter((lineage) => {
    const final = lineage.nodes[lineage.nodes.length - 1];
    if (!final) return false;
    if (final.invalid) return true;
    return (final.endYear ?? 0) >= activeSeason;
  });
}
