"use client";

import { useRouter, usePathname } from "next/navigation";

interface SeasonSelectorProps {
  currentYear: number;
  minYear?: number;
  maxYear?: number;
  /**
   * When set, navigates to this path template (with "{year}" swapped in)
   * instead of appending a `?season=` query param to the current path —
   * used by the race-detail page, which keeps season in the URL segment.
   */
  hrefTemplate?: string;
  className?: string;
}

const DEFAULT_MIN_YEAR = 2018;

export default function SeasonSelector({
  currentYear,
  minYear = DEFAULT_MIN_YEAR,
  maxYear,
  hrefTemplate,
  className = "",
}: SeasonSelectorProps) {
  const router = useRouter();
  const pathname = usePathname();
  const top = maxYear ?? new Date().getFullYear();
  const years = Array.from({ length: Math.max(top - minYear + 1, 1) }, (_, i) => top - i);

  const handleSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const year = Number(e.target.value);
    if (!Number.isFinite(year)) return;
    if (hrefTemplate) {
      router.push(hrefTemplate.replace("{year}", String(year)));
      return;
    }
    router.push(`${pathname}?season=${year}`);
  };

  return (
    <div className={`relative ${className}`}>
      <select
        value={currentYear}
        onChange={handleSelect}
        aria-label="Select season"
        className="appearance-none apex-glass-soft rounded-[11px] text-on-background font-bold text-sm py-[13px] pl-4 pr-11 outline-none focus:border-[rgba(255,138,61,0.5)] transition-colors cursor-pointer w-full md:w-32"
      >
        {years.map((y) => (
          <option key={y} value={y} className="bg-[#14110e]">
            {y}
          </option>
        ))}
      </select>
      <span className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 text-[#FFAE6A] pointer-events-none text-xl">
        keyboard_arrow_down
      </span>
    </div>
  );
}
