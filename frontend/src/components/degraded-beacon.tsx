"use client";

import { useEffect } from "react";
import { track } from "@/lib/analytics";

/**
 * Fires `backend_unavailable` once, from a server-rendered page's empty state.
 *
 * This exists because the thing worth measuring cannot be measured where it
 * happens. Every page catches its own fetch failure and renders empty rather
 * than erroring, so a degraded page still returns HTTP 200 and Cloud Run's logs
 * see a healthy request. The browser is the only place the difference is
 * visible at all.
 *
 * Those catches are in `async` server components, which have no `gtag`, so the
 * page renders this instead: one client component, one effect, no state.
 *
 * Once per mount, which is once per route view. The question is "how often does
 * someone see a degraded page", not "how many fetches failed" -- several
 * fetches on one page can fail together and that is still one bad visit.
 */
export default function DegradedBeacon({ route }: { route: string }) {
  useEffect(() => {
    track("backend_unavailable", { route });
  }, [route]);
  return null;
}
