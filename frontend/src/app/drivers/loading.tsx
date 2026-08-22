/**
 * `/drivers` is `force-dynamic` and fetches standings plus a per-driver image
 * pass, so without this file Next holds the previous page fully interactive
 * while it works — the failure `history/loading.tsx` documents in detail, where
 * a click looks like it did nothing and gets made twice.
 *
 * Dimensions are matched to `drivers-grid.tsx`'s real cards (`min-h-[340px]`,
 * `rounded-card`, the same 1/2/4-column grid) so the skeleton does not
 * relayout into the content.
 */
export default function DriversLoading() {
  return (
    <div className="px-6 md:px-10 pt-11 pb-16 animate-pulse" aria-busy="true">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-5 mb-7">
        <div>
          <div className="h-3 w-32 rounded apex-glass-soft" />
          <div className="h-11 w-56 rounded-lg apex-glass-soft mt-3" />
        </div>
        <div className="h-11 w-56 rounded-xl apex-glass-soft" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="min-h-[340px] rounded-card apex-glass-soft" />
        ))}
      </div>
    </div>
  );
}
