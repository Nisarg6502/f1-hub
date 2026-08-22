import type { MetadataRoute } from "next";

/**
 * There was no `robots.txt` at all before this.
 *
 * Two debugging surfaces ship to production and are publicly reachable:
 * `/agent-check` (the deploy smoke test, which drives the real agent endpoint)
 * and `/pitwall-chat` (the superseded full-page chat UI). Both are deliberately
 * unlinked and both are deliberately kept — see their own docstrings for why —
 * but unlinked is not unindexed, and a crawler that finds either one indexes a
 * raw event-stream dump as though it were a feature of the site. Worse for
 * `/agent-check`: every crawl of it spends real agent quota on a free tier.
 *
 * `/api/` is excluded as well, since Next route handlers under it return JSON
 * that has no business in a search index.
 */
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ??
  "https://f1-frontend-2w5wydk2ca-el.a.run.app";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/agent-check", "/pitwall-chat", "/api/"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
