import Link from "next/link";

/**
 * The 404 this app was rendering before was Next's stock black-and-white
 * "404 | This page could not be found" — and it was reachable in NORMAL
 * operation, not just on a mistyped URL: `circuits/[circuitId]/page.tsx` calls
 * `notFound()` whenever a circuit id doesn't resolve. Any visitor following a
 * stale link landed on an unstyled page from a different application.
 */
export default function NotFound() {
  return (
    <div className="relative z-10 max-w-[1440px] mx-auto px-6 md:px-10 py-20 md:py-28">
      <div className="max-w-[52ch]">
        <p className="font-[family-name:var(--font-headline)] font-extrabold text-[64px] leading-none tracking-[-2px] text-primary-container">
          404
        </p>
        <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-[28px] tracking-[-0.6px] mt-4 mb-3">
          No such corner on this circuit
        </h1>
        <p className="font-medium text-sm leading-relaxed text-warm-300 mb-8">
          This page doesn&apos;t exist. If you followed a link from inside APEX,
          that&apos;s a bug worth reporting — a season, driver or circuit that
          used to resolve and no longer does is exactly the kind of thing that
          slips through.
        </p>

        <div className="flex flex-wrap gap-3">
          <Link
            href="/"
            className="font-bold text-xs px-5 h-[46px] rounded-control apex-glass-soft flex items-center justify-center hover:border-[rgba(255,138,61,0.5)] transition-[border-color,transform] duration-150 active:scale-95"
          >
            Back to home
          </Link>
          <Link
            href="/schedule"
            className="font-bold text-xs px-5 h-[46px] rounded-control apex-glass-soft flex items-center justify-center hover:border-[rgba(255,138,61,0.5)] transition-[border-color,transform] duration-150 active:scale-95"
          >
            Race schedule
          </Link>
          <Link
            href="/standings"
            className="font-bold text-xs px-5 h-[46px] rounded-control apex-glass-soft flex items-center justify-center hover:border-[rgba(255,138,61,0.5)] transition-[border-color,transform] duration-150 active:scale-95"
          >
            Standings
          </Link>
        </div>

        <p className="font-medium text-xs text-warm-500 mt-8">
          Broken link?{" "}
          <a
            href="https://github.com/Nisarg6502/f1-hub/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-warm-300 transition-colors"
          >
            Report it
          </a>
          .
        </p>
      </div>
    </div>
  );
}
