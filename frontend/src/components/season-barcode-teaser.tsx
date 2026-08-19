import Link from "next/link";
import type { HistoricalRace } from "@/lib/api";
import { getConstructorIdentity } from "@/lib/constructor-identity";

// Compact, non-interactive teaser of the `/history` Season Barcode for
// the home page — same stripe-per-race idea and colour source, deliberately
// simplified: no tooltips, no hover isolation, no per-stripe motion. It only
// needs to say "look, this many seasons of colour" and link through. The
// count is derived from the races it was handed rather than written down:
// the hardcoded "75" it used to carry was two years stale and disagreed
// with the page it links to. A server
// component (no "use client") since it has no interaction; the one-shot
// reveal is the existing site-wide `.anim-fade` CSS class, which the app's
// global reduced-motion media query already neutralises.
export default function SeasonBarcodeTeaser({ races }: { races: HistoricalRace[] }) {
  if (races.length === 0) return null;

  const seasons = new Set(races.map((race) => race.season)).size;

  return (
    <Link
      href="/history"
      aria-label={`Explore ${seasons} seasons of Formula 1 history`}
      className="group block px-6 md:px-10 anim-fade"
      style={{ animationDelay: "0.65s" }}
    >
      <div className="apex-glass rounded-[14px] px-4 py-2.5 flex items-center gap-4 overflow-hidden transition-colors group-hover:bg-[rgba(245,235,222,0.05)]">
        <span className="font-bold text-[10px] tracking-[0.1em] uppercase text-warm-500 whitespace-nowrap flex-none">
          {seasons} Seasons
        </span>
        <svg
          viewBox={`0 0 ${races.length} 40`}
          preserveAspectRatio="none"
          className="flex-1 min-w-0 h-6 sm:h-7 block rounded-[3px]"
          aria-hidden="true"
        >
          {races.map((race, index) => (
            <rect
              key={`${race.season}-${race.round}`}
              x={index}
              y={0}
              width={1}
              height={40}
              fill={getConstructorIdentity(race.constructor_key).color.hex}
            />
          ))}
        </svg>
        <span className="font-semibold text-[10px] tracking-[0.06em] uppercase text-warm-500 whitespace-nowrap flex-none group-hover:text-warm-300 transition-colors">
          Explore →
        </span>
      </div>
    </Link>
  );
}
