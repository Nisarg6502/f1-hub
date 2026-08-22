import type { Metadata } from "next";

/**
 * Keeps the superseded full-page chat UI out of search indexes. Same reasoning
 * as `agent-check/layout.tsx`: the page is a client component and cannot carry
 * its own `robots` metadata.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function PitwallChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
