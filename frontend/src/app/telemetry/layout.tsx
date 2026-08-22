import type { Metadata } from "next";

/**
 * `/telemetry` is a `"use client"` page and a client component cannot export
 * `metadata`, so its title lives here. Without it the route inherited the root
 * layout's title and was indistinguishable from the home page in a tab strip,
 * a bookmark or a search result.
 */
export const metadata: Metadata = {
  title: "Live timing | APEX",
  description:
    "Live session timing when a Formula 1 session is running: positions, gaps, sector times and tyre compounds.",
};

export default function TelemetryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
