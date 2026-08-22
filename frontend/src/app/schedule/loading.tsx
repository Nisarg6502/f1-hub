/**
 * `/schedule` is `force-dynamic` and attaches a winner to every completed
 * round, so it waits on results as well as the calendar. Same reasoning as
 * `drivers/loading.tsx`.
 *
 * The row height and the `lg:grid-cols-[280px_1fr]` split match
 * `schedule-board.tsx`, whose rows are a three/four-column grid at
 * `py-5` — about 78px — inside a sidebar layout.
 */
export default function ScheduleLoading() {
  return (
    <div className="px-6 md:px-10 pt-11 pb-16 animate-pulse" aria-busy="true">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-5 mb-7">
        <div>
          <div className="h-3 w-36 rounded apex-glass-soft" />
          <div className="h-11 w-60 rounded-lg apex-glass-soft mt-3" />
        </div>
        <div className="h-11 w-56 rounded-xl apex-glass-soft" />
      </div>
      <div className="grid lg:grid-cols-[280px_1fr] gap-7 items-start">
        <div className="h-[260px] rounded-2xl apex-glass-soft" />
        <div className="flex flex-col gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-[78px] rounded-2xl apex-glass-soft" />
          ))}
        </div>
      </div>
    </div>
  );
}
