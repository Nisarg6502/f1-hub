"use client";

import { useRouter } from "next/navigation";
import type { Race } from "@/lib/api";

interface RaceSelectorProps {
  races: Race[];
  currentRound: string;
  seasonYear: number;
}

export default function RaceSelector({ races, currentRound, seasonYear }: RaceSelectorProps) {
  const router = useRouter();

  const handleSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const round = e.target.value;
    if (round) {
      router.push(`/schedule/${seasonYear}/${round}`);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="font-[family-name:var(--font-label)] text-[10px] uppercase tracking-[0.2em] text-primary-container font-bold">
        Select Grand Prix
      </label>
      <div className="relative">
        <select
          value={currentRound}
          onChange={handleSelect}
          className="appearance-none bg-surface-container-low text-on-surface font-[family-name:var(--font-headline)] font-bold text-lg uppercase tracking-tight py-3 pl-4 pr-12 border-l-4 border-primary-container outline-none focus:ring-2 focus:ring-primary-container/50 hover:bg-surface-container transition-colors cursor-pointer w-full md:w-64"
        >
          {races.map((race) => (
            <option key={race.round} value={race.round}>
              {race.raceName.replace(" Grand Prix", "").toUpperCase()}
            </option>
          ))}
        </select>
        <span className="material-symbols-outlined absolute right-4 top-1/2 -translate-y-1/2 text-primary-container pointer-events-none">
          keyboard_arrow_down
        </span>
      </div>
    </div>
  );
}
