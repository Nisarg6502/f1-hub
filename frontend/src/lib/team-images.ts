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
