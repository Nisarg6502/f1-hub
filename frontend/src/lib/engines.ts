export interface EngineProvider {
  name: string;
  color: string;
  icon: string;
}

export const engineProviders: Record<string, EngineProvider> = {
  "Red Bull Ford": {
    name: "Red Bull Ford",
    color: "bg-blue-600",
    icon: "bolt",
  },
  Mercedes: {
    name: "Mercedes-AMG",
    color: "bg-teal-500",
    icon: "speed",
  },
  Ferrari: {
    name: "Ferrari",
    color: "bg-red-600",
    icon: "local_fire_department",
  },
  Honda: {
    name: "Honda",
    color: "bg-green-600",
    icon: "rocket_launch",
  },
  Renault: {
    name: "Renault",
    color: "bg-pink-500",
    icon: "cyclone",
  },
  Audi: {
    name: "Audi",
    color: "bg-neutral-300",
    icon: "all_inclusive",
  },
};

export const teamEnginesMap: Record<string, string> = {
  "Red Bull": "Red Bull Ford",
  RB: "Red Bull Ford",
  Mercedes: "Mercedes",
  McLaren: "Mercedes",
  Williams: "Mercedes",
  Ferrari: "Ferrari",
  Haas: "Ferrari",
  "Aston Martin": "Honda",
  // Sauber ran Ferrari power units for its entire modern history — the Audi
  // buyout only became a full works engine supply from the 2026 rules reset,
  // by which point the constructor itself is renamed to "Audi" (see below),
  // so this entry only ever needs to cover pre-2026 seasons.
  Sauber: "Ferrari",
  Audi: "Audi",
  // New 2026 entrant, a Ferrari customer team.
  Cadillac: "Ferrari",
};

// 2026's regulation reset moved Alpine off Renault power units onto Mercedes
// — the constructor name itself doesn't change, so a flat name→engine map
// can't represent the switch. `year` defaults to undefined (treated as
// "current/unknown", i.e. post-switch) so existing call sites that don't
// pass one keep the up-to-date answer.
const ALPINE_ENGINE_BY_YEAR = (year?: number): string =>
  year !== undefined && year < 2026 ? "Renault" : "Mercedes";

export function getEngineForTeam(
  teamName: string,
  year?: number
): EngineProvider | null {
  if (teamName.toLowerCase().includes("alpine")) {
    return engineProviders[ALPINE_ENGINE_BY_YEAR(year)] || null;
  }

  const key = Object.keys(teamEnginesMap).find((k) =>
    teamName.toLowerCase().includes(k.toLowerCase())
  );
  if (!key) return null;
  const engineName = teamEnginesMap[key];
  return engineProviders[engineName] || null;
}
