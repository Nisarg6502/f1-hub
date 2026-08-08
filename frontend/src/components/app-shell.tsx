"use client";

import { usePathname } from "next/navigation";

/**
 * Decides whether a route gets the app's chrome.
 *
 * Watch-party mode is a full-screen, chrome-free presentation surface — a phone
 * propped against a TV should show a timing tower, not a nav bar, a search box,
 * a footer and a mobile tab strip eating a third of a landscape screen.
 *
 * Next's nested layouts can only *add* to a parent layout, never remove from
 * it, so the usual way to do this is a `(chrome)` / `(bare)` route-group split —
 * which would mean relocating every existing route directory. That is a large,
 * risky diff for one new page. Instead the chrome moves behind this client
 * boundary and is skipped by pathname. The server components that live in the
 * nav (`SeasonBadge` and friends) are passed through as props, so they keep
 * rendering on the server exactly as before; only the decision to render them
 * is client-side.
 */
const BARE_PREFIXES = ["/watch"];

export default function AppShell({
  nav,
  footer,
  mobileNav,
  ambient,
  children,
}: {
  nav: React.ReactNode;
  footer: React.ReactNode;
  mobileNav: React.ReactNode;
  ambient: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const bare = BARE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );

  if (bare) {
    // No ambient glow either: it is a lovely background for a page read at
    // desk distance and a contrast tax on a timing tower read from a sofa.
    return <main className="relative z-10 min-h-[100dvh]">{children}</main>;
  }

  return (
    <>
      {ambient}
      {nav}
      <main className="relative z-10 min-h-screen max-w-[1440px] mx-auto pb-24 md:pb-12">
        {children}
      </main>
      {footer}
      {mobileNav}
    </>
  );
}
