/** Same reasoning as `app/history/loading.tsx`. This one matters a little more
 * than most: the round someone wants is usually the one that just ran, so this
 * page is most often opened when the answer is least likely to be cached. */
export default function WatchIndexLoading() {
  return (
    <div className="px-6 md:px-10 pt-8 pb-16 max-w-[1100px] mx-auto animate-pulse" aria-busy="true">
      <div className="h-10 w-32 rounded-control apex-glass-soft" />
      <div className="h-3 w-28 rounded apex-glass-soft mt-7" />
      <div className="h-12 w-[min(32rem,85%)] rounded-lg apex-glass-soft mt-3" />
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3.5 mt-10">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="h-[104px] rounded-tile apex-glass-soft" />
        ))}
      </div>
    </div>
  );
}
