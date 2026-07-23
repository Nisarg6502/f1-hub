export default function StandingsLoading() {
  return (
    <div className="px-6 md:px-10 pt-11 pb-16 animate-pulse">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6 mb-7">
        <div>
          <div className="h-3 w-40 rounded apex-glass-soft" />
          <div className="h-11 w-64 rounded-lg apex-glass-soft mt-3" />
        </div>
        <div className="h-11 w-56 rounded-xl apex-glass-soft" />
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="h-[68px] rounded-2xl apex-glass-soft" />
        ))}
      </div>
    </div>
  );
}
