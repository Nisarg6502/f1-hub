// Canonical F1 team accent colours for the APEX design system.
// Single source of truth — replaces the per-page teamColors maps that used to
// live in drivers/standings/teams. Matched by case-insensitive substring so it
// tolerates the various constructor names the API returns
// ("RB F1 Team", "Kick Sauber", "Aston Martin Aramco", …).

export interface TeamColor {
  hex: string;
  /** same hue at ~40% alpha, for glows */
  glow: string;
}

// Order matters: more specific names first so "Red Bull" doesn't fall through
// to the "rb" entry.
const TEAM_COLOR_MAP: Array<[string, string]> = [
  ["mercedes", "#00D7B6"],
  ["ferrari", "#E80020"],
  ["mclaren", "#FF8000"],
  ["red bull", "#3671C6"],
  ["alpine", "#FF87BC"],
  ["williams", "#64C4FF"],
  ["aston martin", "#229971"],
  ["haas", "#B6BABD"],
  ["audi", "#52E252"],
  ["sauber", "#52E252"],
  ["cadillac", "#C4C4C4"],
  ["racing bulls", "#6692FF"],
  ["rb", "#6692FF"],
];

const FALLBACK = "#FF5A1F"; // APEX flame — used when no team matches

export function getTeamColor(teamName?: string): TeamColor {
  const name = (teamName ?? "").toLowerCase();
  for (const [key, hex] of TEAM_COLOR_MAP) {
    if (name.includes(key)) return { hex, glow: hex + "66" };
  }
  return { hex: FALLBACK, glow: FALLBACK + "66" };
}
