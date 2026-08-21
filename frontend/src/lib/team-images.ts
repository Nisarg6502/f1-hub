// Team logo resolver — mirrors driver-images.ts/circuit-images.ts.
//
// Only 8 of the 11 current-grid teams have a logo here. Ferrari, Red Bull and
// Racing Bulls run pictorial (non-text) marks with no freely-licensed source
// on Wikimedia Commons, so they intentionally return null and fall back to
// the color+monogram treatment in team-colors.ts.
//
// Matched by case-insensitive substring, same as getTeamColor, so it
// tolerates the various constructor names the API returns ("RB F1 Team",
// "Aston Martin Aramco", …). Order matters: more specific names first so
// "Red Bull" doesn't fall through to a shorter unrelated key.
const TEAM_LOGO_MAP: Array<[string, string]> = [
  ["mercedes", "Mercedes.svg"],
  ["mclaren", "McLaren.png"],
  ["alpine", "Alpine.png"],
  ["williams", "Williams.png"],
  ["aston martin", "Aston_Martin.jpg"],
  ["haas", "Haas.svg"],
  ["audi", "Audi.svg"],
  ["cadillac", "Cadillac.png"],
];

const ASSET_BASE = process.env.NEXT_PUBLIC_ASSET_BASE_URL ?? "";

export function getTeamLogoPath(teamName?: string): string | null {
  const name = (teamName ?? "").toLowerCase();
  for (const [key, file] of TEAM_LOGO_MAP) {
    if (name.includes(key)) return `${ASSET_BASE}/teams/${file}`;
  }
  return null;
}

export function hasTeamLogo(teamName?: string): boolean {
  return getTeamLogoPath(teamName) !== null;
}

/* -------------------------------------------------------------------------- */
/* car renders                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Official side-profile car renders, mirrored into `gs://f1-scratch-assets/cars`.
 *
 * **Licensing is different here and the difference matters.** The logos above
 * are Wikimedia Commons material, which is why three teams are deliberately
 * missing rather than sourced from somewhere convenient. These renders are
 * Formula One World Championship Limited's own press assets, taken from
 * formula1.com's media CDN — all rights reserved, used here on the same footing
 * as any fan site. If this project ever needs to stand on clean licensing, this
 * is the directory to revisit first.
 *
 * Unlike the logos, coverage is complete: all 11 constructors, so no caller
 * needs a fallback branch for a missing car the way it does for a missing mark.
 *
 * 1920x423 WebP with a real alpha channel — they are cut out, not on a white
 * plate, so they composite straight onto the dark theme with no scrim. Roughly
 * 100KB each; the source is 3840px wide and can be re-pulled at that size if a
 * hero ever needs it.
 */
const TEAM_CAR_MAP: Array<[string, string]> = [
  ["mercedes", "Mercedes"],
  ["ferrari", "Ferrari"],
  ["mclaren", "McLaren"],
  ["red bull", "Red_Bull"],
  ["alpine", "Alpine"],
  ["williams", "Williams"],
  ["aston martin", "Aston_Martin"],
  ["haas", "Haas"],
  ["audi", "Audi"],
  ["sauber", "Audi"],
  ["cadillac", "Cadillac"],
  ["racing bulls", "Racing_Bulls"],
  ["rb", "Racing_Bulls"],
];

/** Which way the car points. Both exist for every team, so two cars can be put
 * nose to nose in a head-to-head without one of them driving backwards. */
export type CarFacing = "right" | "left";

export function getTeamCarPath(
  teamName?: string,
  facing: CarFacing = "right"
): string | null {
  const name = (teamName ?? "").toLowerCase();
  for (const [key, file] of TEAM_CAR_MAP) {
    if (name.includes(key)) return `${ASSET_BASE}/cars/${file}-${facing}.webp`;
  }
  return null;
}

export function hasTeamCar(teamName?: string): boolean {
  return getTeamCarPath(teamName) !== null;
}

// The short form to draw when a team has no logo above. Matched the same
// case-insensitive-substring way as getTeamColor and getTeamLogoPath, most
// specific first, so "Red Bull" cannot fall through to the "rb" entry.
//
// A map rather than a derivation because deriving one is wrong in both
// directions: `name.slice(0, 2)` turns Ferrari into "FE" and Red Bull into
// "RE", and taking word initials turns "Haas F1 Team" into "HF". These are the
// abbreviations the sport itself uses, and the reader already knows them.
const TEAM_ABBREVIATION_MAP: Array<[string, string]> = [
  ["mercedes", "MER"],
  ["ferrari", "FER"],
  ["mclaren", "MCL"],
  ["red bull", "RBR"],
  ["alpine", "ALP"],
  ["williams", "WIL"],
  ["aston martin", "AMR"],
  ["haas", "HAA"],
  ["audi", "AUD"],
  ["sauber", "SAU"],
  ["cadillac", "CAD"],
  ["racing bulls", "RB"],
  ["rb", "RB"],
];

/** Words that identify no team and must not contribute an initial. */
const FILLER = new Set(["f1", "formula", "one", "team", "racing", "the", "and"]);

/**
 * A three-letter-ish stand-in for a team's logo.
 *
 * Falls back to initials for a constructor this file has never heard of — a new
 * entrant, or a rename mid-season — so the mark degrades to something readable
 * rather than to an empty box.
 */
export function getTeamAbbreviation(teamName?: string): string {
  const name = (teamName ?? "").trim();
  if (!name) return "—";

  const lower = name.toLowerCase();
  for (const [key, abbreviation] of TEAM_ABBREVIATION_MAP) {
    if (lower.includes(key)) return abbreviation;
  }

  const words = name
    .split(/\s+/)
    .filter((word) => word && !FILLER.has(word.toLowerCase()));
  if (words.length === 0) return name.slice(0, 3).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words
    .slice(0, 3)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}
