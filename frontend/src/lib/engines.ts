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
  Alpine: "Renault",
  Sauber: "Audi",
};

export function getEngineForTeam(teamName: string): EngineProvider | null {
  const key = Object.keys(teamEnginesMap).find((k) =>
    teamName.toLowerCase().includes(k.toLowerCase())
  );
  if (!key) return null;
  const engineName = teamEnginesMap[key];
  return engineProviders[engineName] || null;
}
