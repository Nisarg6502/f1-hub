/**
 * `/teams` resolves constructor standings, lineages and per-team heritage, and
 * is `force-dynamic`. Same reasoning as `drivers/loading.tsx`.
 *
 * The two-column card block and the four-column footer grid mirror the real
 * page's `md:grid-cols-2` and `grid-cols-2 lg:grid-cols-4`.
 */
export default function TeamsLoading() {
  return (
    <div className="px-6 md:px-10 pt-11 pb-16 animate-pulse" aria-busy="true">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-5 mb-7">
        <div>
          <div className="h-3 w-28 rounded apex-glass-soft" />
          <div className="h-11 w-52 rounded-lg apex-glass-soft mt-3" />
        </div>
        <div className="h-11 w-56 rounded-xl apex-glass-soft" />
      </div>
      <div className="grid md:grid-cols-2 items-start gap-4 mb-10">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-[212px] rounded-2xl apex-glass-soft" />
        ))}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[104px] rounded-2xl apex-glass-soft" />
        ))}
      </div>
    </div>
  );
}
