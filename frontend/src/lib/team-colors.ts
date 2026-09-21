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

/** WCAG relative luminance of an `#rrggbb` string. */
function relativeLuminance(hex: string): number {
  const v = hex.replace("#", "");
  const channel = (pair: string) => {
    const srgb = parseInt(pair, 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(v.slice(0, 2)) +
    0.7152 * channel(v.slice(2, 4)) +
    0.0722 * channel(v.slice(4, 6))
  );
}

/**
 * Text colour for a chip filled with a team's accent — whichever of near-black
 * or white the accent actually carries.
 *
 * The abbreviation chips (the "FER"/"RBR" marks that stand in wherever a team
 * has no logo asset) hardcoded `#0a0908` on every accent. That is right for
 * eight of the thirteen colours here and wrong for Ferrari's #E80020, which
 * axe-core measured at 4.21:1 — under AA for the 13px bold text on it. Red
 * Bull's #3671C6 is darker still.
 *
 * Deciding per colour rather than per team means a future accent — a new
 * entrant, a livery change — is handled without anyone having to notice.
 * White here is pure `#fff` deliberately: the app's warm `#f6f1ea` off-white
 * is dark enough to FAIL on Ferrari red (4.13:1) where pure white passes at
 * 4.72:1, which is the sort of near-miss this helper exists to stop.
 */
export function getInkOn(hex: string): string {
  const l = relativeLuminance(hex);
  const onDark = (l + 0.05) / 0.05; // contrast against #000-ish ink
  const onLight = 1.05 / (l + 0.05); // contrast against #fff
  return onDark >= onLight ? "#0a0908" : "#ffffff";
}
