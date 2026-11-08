/** "2026 Champion" pill, shown wherever a mathematically decided champion is named. */
export default function ChampionBadge({
  year,
  label = "Champion",
  className = "",
}: {
  year: number;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 flex-none rounded-full bg-primary-container/16 text-primary px-2 py-[2px] font-bold text-[10px] tracking-[0.08em] uppercase whitespace-nowrap ${className}`}
    >
      <span className="material-symbols-outlined text-[12px] leading-none" aria-hidden="true">
        trophy
      </span>
      {year} {label}
    </span>
  );
}
