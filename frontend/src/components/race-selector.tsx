"use client";

import { useRouter } from "next/navigation";
import type { Race } from "@/lib/api";

interface RaceSelectorProps {
  races: Race[];
  currentRound: string;
  seasonYear: number;
}

export default function RaceSelector({
  races,
  currentRound,
  seasonYear,
}: RaceSelectorProps) {
  const router = useRouter();

  const handleSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const round = e.target.value;
    if (round) {
      router.push(`/schedule/${seasonYear}/${round}`);
    }
  };

  return (
    <div className="relative">
      <select
        value={currentRound}
        onChange={handleSelect}
        aria-label="Select Grand Prix"
        className="appearance-none apex-glass-soft rounded-[11px] text-on-background font-bold text-sm py-[13px] pl-4 pr-11 outline-none focus:border-[rgba(255,138,61,0.5)] transition-colors cursor-pointer w-full md:w-60"
      >
        {races.map((race) => (
          <option key={race.round} value={race.round} className="bg-[#14110e]">
            {race.raceName.replace(" Grand Prix", "")}
          </option>
        ))}
      </select>
      <span className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 text-[#FFAE6A] pointer-events-none text-xl">
        keyboard_arrow_down
      </span>
    </div>
  );
}
