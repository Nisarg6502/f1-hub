"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { getActiveSeasonYear, resolveSeasonYear } from "@/lib/api";

// The layout has no route params of its own, so this reads whichever season
// the current page is actually showing: the /schedule/[season]/... path
// segment, then a ?season= query param (run through resolveSeasonYear so it
// never shows a value the page itself wouldn't accept), then the real active
// season as a last resort.
export default function SeasonBadge() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const scheduleMatch = pathname.match(/^\/schedule\/(\d{4})(?:\/|$)/);
  const pathYear = scheduleMatch ? Number(scheduleMatch[1]) : null;

  const year =
    pathYear && Number.isFinite(pathYear)
      ? pathYear
      : resolveSeasonYear(searchParams.get("season") ?? undefined);

  return (
    <div className="font-semibold text-xs text-warm-300">
      Season <span className="text-on-background">{year || getActiveSeasonYear()}</span>
    </div>
  );
}
