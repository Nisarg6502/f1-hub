import type { Metadata } from "next";

/**
 * Exists only to keep this route out of search indexes.
 *
 * `/agent-check` is a `"use client"` page, and a client component cannot
 * export `metadata`, so the `noindex` has to live in a layout beside it.
 * `robots.ts` disallows the path as well; this is the stronger of the two,
 * because a disallow stops crawling but does not stop a discovered URL being
 * indexed. Both matter here: every crawl of this page drives the real agent
 * endpoint and spends free-tier quota.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AgentCheckLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
