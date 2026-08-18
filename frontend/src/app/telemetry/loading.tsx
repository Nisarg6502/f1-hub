/** Same reasoning as `app/history/loading.tsx`: without one, Next leaves the
 * previous page on screen and the navigation gives no sign it happened. */
export default function TelemetryLoading() {
  return (
    <div className="px-6 md:px-10 pt-11 pb-16 animate-pulse" aria-busy="true">
      <div className="h-3 w-28 rounded apex-glass-soft" />
      <div className="h-11 w-[min(24rem,75%)] rounded-lg apex-glass-soft mt-3" />
      <div className="h-[180px] rounded-2xl apex-glass-soft mt-8" />
    </div>
  );
}
