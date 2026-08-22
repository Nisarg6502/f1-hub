import type { MetadataRoute } from "next";

/**
 * Static routes only, and that is a deliberate limit rather than an oversight.
 *
 * The per-round, per-driver and per-circuit pages are all `force-dynamic` and
 * enumerating them here would mean fetching the whole season at sitemap-build
 * time — an upstream call, on a rate-limited free tier, triggered by anything
 * that requests this file. Crawlers reach those pages by following links from
 * the ones below, which is what links are for.
 *
 * `/agent-check` and `/pitwall-chat` are absent for the same reason
 * `robots.ts` disallows them.
 */
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ??
  "https://f1-frontend-1076575666662.asia-south1.run.app";

const ROUTES = [
  { path: "", priority: 1 },
  { path: "/schedule", priority: 0.9 },
  { path: "/standings", priority: 0.9 },
  { path: "/drivers", priority: 0.8 },
  { path: "/teams", priority: 0.8 },
  { path: "/circuits", priority: 0.8 },
  { path: "/telemetry", priority: 0.7 },
  { path: "/history", priority: 0.7 },
  { path: "/watch", priority: 0.6 },
  { path: "/about", priority: 0.5 },
  { path: "/data-sources", priority: 0.5 },
  { path: "/ai-disclosure", priority: 0.5 },
  { path: "/faq", priority: 0.5 },
  { path: "/privacy", priority: 0.3 },
  { path: "/disclaimer", priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.map(({ path, priority }) => ({
    url: `${SITE_URL}${path}`,
    priority,
  }));
}
