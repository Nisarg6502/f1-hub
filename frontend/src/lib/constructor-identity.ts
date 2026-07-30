// Constructor identity for the `/history` page (Batch 14: 75-Season Barcode +
// Constructor Genealogy) — colours and display names keyed by the
// `constructor_key` the backend's `/api/historical_race_index` already
// normalises (see `backend/app/historical_index.py`'s module docstring for
// why raw Ergast constructorIds aren't usable directly: shared-drive
// duplicates, chassis/engine-era id splits, and `alfa` covering three
// unrelated teams 70 years apart).
//
// Only 38 canonical keys have ever won a championship race across 75 years
// (probed live against Jolpica for this batch), so this is a small,
// hand-authored file, not a generated one.
//
// For constructors that still race today, colour is delegated to
// `getTeamColor` in `team-colors.ts` so a team's colour is IDENTICAL on
// `/history` and everywhere else in the app (`/standings`, `/teams`, …) —
// this file only adds the ~30 historical-only keys that map has no reason
// to know about.

import { getTeamColor, type TeamColor } from "./team-colors";

export interface ConstructorIdentity {
  name: string;
  color: TeamColor;
  /** The 1950-60 Indianapolis 500 counted for the World Championship;
   * these constructors never entered a Grand Prix. Rendered visually
   * distinct (muted chrome) rather than colour-mapped like a real team. */
  indyOnly?: boolean;
}

// Canonical keys that are still active today, or exist under a different
// current name — deferred to getTeamColor by name so the two files can
// never disagree on a colour.
const ACTIVE_KEY_TO_TEAM_COLOR_NAME: Record<string, string> = {
  ferrari: "ferrari",
  mclaren: "mclaren",
  mercedes: "mercedes",
  red_bull: "red bull",
  williams: "williams",
  alpine: "alpine",
  racing_point: "aston martin", // Racing Point -> Aston Martin, same current entry
  // Neither has ever won a race, so neither can appear in the barcode — they
  // are here for the genealogy tree, which draws every current-grid entry.
  haas: "haas",
  cadillac: "cadillac",
  toro_rosso: "racing bulls", // Faenza outfit's earlier name, same current entry
  alphatauri: "racing bulls",
  bmw_sauber: "sauber",
};

// Everything else: a team that no longer exists, or exists but predates
// team-colors.ts's current-grid-only map (e.g. Honda, which won as a 2006
// works team, decades before its 2026 power-unit-supplier return).
const HISTORICAL_IDENTITY: Record<string, ConstructorIdentity> = {
  lotus: { name: "Lotus", color: { hex: "#FFB800", glow: "#FFB80066" } },
  // The 2012-15 Renault-descended team, briefly renamed "Lotus F1 Team" —
  // NOT the same lineage as classic Lotus above (see the backend module
  // docstring; conflating the two was an actual bug caught during this
  // batch's live-data verification). Kept as its own distinct colour.
  lotus_f1: { name: "Lotus F1 Team", color: { hex: "#E8A33D", glow: "#E8A33D66" } },
  renault: { name: "Renault", color: { hex: "#FFD100", glow: "#FFD10066" } },
  benetton: { name: "Benetton", color: { hex: "#00A94F", glow: "#00A94F66" } },
  brabham: { name: "Brabham", color: { hex: "#2D5DA1", glow: "#2D5DA166" } },
  tyrrell: { name: "Tyrrell", color: { hex: "#0A3B7A", glow: "#0A3B7A66" } },
  brm: { name: "BRM", color: { hex: "#4B7A3F", glow: "#4B7A3F66" } },
  cooper: { name: "Cooper", color: { hex: "#5FA8D3", glow: "#5FA8D366" } },
  // 1950-51 Alfa Romeo works team — the only Alfa era that ever won a race.
  alfa_1950s: { name: "Alfa Romeo", color: { hex: "#B71C1C", glow: "#B71C1C66" } },
  vanwall: { name: "Vanwall", color: { hex: "#0F5C2E", glow: "#0F5C2E66" } },
  maserati: { name: "Maserati", color: { hex: "#5E2CA5", glow: "#5E2CA566" } },
  "matra-ford": { name: "Matra-Ford", color: { hex: "#1E4C9A", glow: "#1E4C9A66" } },
  ligier: { name: "Ligier", color: { hex: "#005BAC", glow: "#005BAC66" } },
  brawn: { name: "Brawn GP", color: { hex: "#F5F1E6", glow: "#F5F1E666" } },
  jordan: { name: "Jordan", color: { hex: "#F2C94C", glow: "#F2C94C66" } },
  honda: { name: "Honda", color: { hex: "#D9D9D9", glow: "#D9D9D966" } },
  march: { name: "March", color: { hex: "#8C6B4F", glow: "#8C6B4F66" } },
  wolf: { name: "Wolf", color: { hex: "#B08D2A", glow: "#B08D2A66" } },
  porsche: { name: "Porsche", color: { hex: "#C7A24A", glow: "#C7A24A66" } },
  "eagle-weslake": { name: "Eagle-Weslake", color: { hex: "#8B5A2B", glow: "#8B5A2B66" } },
  hesketh: { name: "Hesketh", color: { hex: "#E5B800", glow: "#E5B80066" } },
  penske: { name: "Penske", color: { hex: "#F5C400", glow: "#F5C40066" } },
  shadow: { name: "Shadow", color: { hex: "#1A1A1A", glow: "#1A1A1A66" } },
  stewart: { name: "Stewart", color: { hex: "#00305A", glow: "#00305A66" } },
  // Never-active-today, never-merged historical-only Alfa eras — kept for
  // completeness even though only the 1950s era ever won a race, so the
  // genealogy tree can still place them on the timeline correctly.
  alfa_1980s: { name: "Alfa Romeo", color: { hex: "#8E1A1A", glow: "#8E1A1A66" } },
  alfa_sauber: { name: "Alfa Romeo Racing", color: { hex: "#9B2226", glow: "#9B222666" } },

  // The 1950-60 Indianapolis 500 counted for the World Championship; these
  // four American roadster builders never entered a Grand Prix. Rendered as
  // muted chrome, not a "real" team colour — see `indyOnly` above.
  kurtis_kraft: { name: "Kurtis Kraft", color: { hex: "#9AA0A6", glow: "#9AA0A666" }, indyOnly: true },
  kuzma: { name: "Kuzma", color: { hex: "#9AA0A6", glow: "#9AA0A666" }, indyOnly: true },
  epperly: { name: "Epperly", color: { hex: "#9AA0A6", glow: "#9AA0A666" }, indyOnly: true },
  watson: { name: "Watson", color: { hex: "#9AA0A6", glow: "#9AA0A666" }, indyOnly: true },
};

const FALLBACK: ConstructorIdentity = {
  name: "Unknown constructor",
  color: { hex: "#FF5A1F", glow: "#FF5A1F66" }, // APEX flame fallback, matches team-colors.ts
};

/**
 * Resolve a backend `constructor_key` (already normalised by
 * `historical_index.py`) to a display name + colour. Active-team keys defer
 * to `getTeamColor` so `/history` never drifts from `/standings`; everything
 * else comes from the hand-authored map above.
 */
export function getConstructorIdentity(constructorKey: string): ConstructorIdentity {
  const activeName = ACTIVE_KEY_TO_TEAM_COLOR_NAME[constructorKey];
  if (activeName) {
    return { name: toDisplayName(activeName), color: getTeamColor(activeName) };
  }

  return HISTORICAL_IDENTITY[constructorKey] ?? FALLBACK;
}

// getTeamColor matches by lowercase substring and doesn't itself carry a
// canonical display name, so this maps the lookup key back to a properly
// cased label for tooltips/legends.
const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  "red bull": "Red Bull",
  "racing bulls": "Racing Bulls",
  "aston martin": "Aston Martin",
};

function toDisplayName(lookupKey: string): string {
  return (
    DISPLAY_NAME_OVERRIDES[lookupKey] ??
    lookupKey.replace(/\b\w/g, (c) => c.toUpperCase())
  );
}
