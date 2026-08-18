/**
 * `/history` is the slowest route in the app — measured at 2.6s TTFB for a
 * 697 KB payload — and without this file Next held the *previous* page on
 * screen, fully interactive, for the whole of it. Sampled every 250ms after
 * clicking "History" from the home page: ten consecutive samples still showed
 * `path=/`, no skeleton, no `aria-busy`, and the nav underline still under
 * "Home". The click looked like it had done nothing, which is how a user comes
 * to click it twice.
 *
 * A `loading.tsx` costs one file and makes the navigation acknowledge itself.
 */
export default function HistoryLoading() {
  return (
    <div className="px-6 md:px-10 pt-11 pb-16 animate-pulse" aria-busy="true">
      <div className="h-3 w-32 rounded apex-glass-soft" />
      <div className="h-12 w-[min(28rem,80%)] rounded-lg apex-glass-soft mt-3" />
      <div className="h-4 w-[min(34rem,90%)] rounded apex-glass-soft mt-4" />
      <div className="h-[220px] rounded-2xl apex-glass-soft mt-10" />
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3.5 mt-8">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-[132px] rounded-2xl apex-glass-soft" />
        ))}
      </div>
    </div>
  );
}
