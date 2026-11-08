/**
 * Shown while a race's replay, per-second timing and radio load on the server.
 *
 * Without this file the nearest boundary was `app/watch/loading.tsx`, the race
 * *list's* skeleton: a grid of nine empty tiles, which on a cold cache sat on
 * screen for ~20s (2026-11-08) and read as a broken page rather than a loading
 * one. A cold cache is now rare (`backend/app/watch_cache_warm.py`), but the
 * page still waits on two backend calls, so the wait gets something worth
 * looking at: a start-light gantry and a line or two about what is coming.
 *
 * Everything here is true of the page it precedes. It is pure CSS (keyframes in
 * `globals.css`, `.apex-start-*`) so it animates from the first streamed byte,
 * and a fast load simply replaces it before the first lamp is lit.
 */
const FACTS = [
  "Every lap replays at the pace it was actually run.",
  "Gaps tick down between real timing readings, seconds apart.",
  "Safety-car laps run long, exactly as they did on the day.",
  "Pause any time, or jump straight to the lap you want.",
];

export default function WatchRaceLoading() {
  return (
    <div
      className="min-h-[100dvh] flex flex-col items-center justify-center px-6 py-16 text-center"
      aria-busy="true"
    >
      <span className="sr-only" role="status">
        Loading the race replay
      </span>

      <p className="font-bold text-[10px] tracking-[0.14em] uppercase text-flame" aria-hidden="true">
        Watch party
      </p>

      {/* The gantry: five pods of two lamps, as on a real start. */}
      <div
        className="mt-6 flex gap-2.5 sm:gap-3.5 rounded-2xl px-4 py-3.5 sm:px-5 sm:py-4 bg-[#0d0b0a] border border-white/[0.08] shadow-[0_20px_60px_rgba(0,0,0,0.55)]"
        aria-hidden="true"
      >
        {Array.from({ length: 5 }).map((_, pod) => (
          <div
            key={pod}
            className="apex-start-pod flex flex-col gap-2 rounded-xl bg-[#171311] border border-white/[0.06] p-1.5 sm:p-2"
          >
            {/* Two unlit lamps above, as on the real gantry, then the two that
                carry the sequence. */}
            {[0, 1].map((lamp) => (
              <span key={`d${lamp}`} className="block w-7 h-7 sm:w-9 sm:h-9 rounded-full bg-white/[0.06] shadow-[inset_0_1px_2px_rgba(0,0,0,0.6)]" />
            ))}
            {[0, 1].map((lamp) => (
              <span key={`l${lamp}`} className="apex-start-lamp block w-7 h-7 sm:w-9 sm:h-9 rounded-full" />
            ))}
          </div>
        ))}
      </div>

      <div
        className="apex-start-caption relative h-5 mt-4 w-full font-bold text-[11px] tracking-[0.18em] uppercase"
        aria-hidden="true"
      >
        <span className="absolute inset-0 text-warm-500">Lining up the grid</span>
        <span className="absolute inset-0 text-on-background">Lights out</span>
      </div>

      <h1 className="mt-8 font-[family-name:var(--font-headline)] font-extrabold text-2xl md:text-3xl leading-tight">
        Loading the race
      </h1>

      <div className="relative mt-3 h-12 w-full max-w-md" aria-hidden="true">
        {FACTS.map((fact) => (
          <p
            key={fact}
            className="apex-start-fact absolute inset-x-0 top-0 font-medium text-sm text-warm-300 leading-relaxed"
          >
            {fact}
          </p>
        ))}
      </div>
    </div>
  );
}
