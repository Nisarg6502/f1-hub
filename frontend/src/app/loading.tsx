/**
 * The home page is `force-dynamic` and fetches the schedule, both standings
 * tables and the next race's session times before it can render anything.
 *
 * It is also the route where holding the previous page costs most, because
 * arriving here is usually the FIRST navigation — there is no previous page to
 * hold, so without this file the reader gets a blank frame rather than a stale
 * one. Same pattern as the other seven; see `history/loading.tsx` for the
 * measurement behind it.
 */
export default function HomeLoading() {
  return (
    <div className="px-6 md:px-10 pt-11 pb-16 animate-pulse" aria-busy="true">
      {/* Hero */}
      <div className="mb-10">
        <div className="h-3 w-32 rounded apex-glass-soft" />
        <div className="h-14 w-full max-w-[620px] rounded-xl apex-glass-soft mt-4" />
        <div className="h-14 w-full max-w-[420px] rounded-xl apex-glass-soft mt-3" />
        <div className="flex flex-wrap gap-3 mt-7">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-9 w-[124px] rounded-xl apex-glass-soft" />
          ))}
        </div>
      </div>
      {/* Standings / next-race cards */}
      <div className="grid md:grid-cols-2 gap-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-[320px] rounded-2xl apex-glass-soft" />
        ))}
      </div>
    </div>
  );
}
