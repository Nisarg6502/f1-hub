import type { Metadata } from "next";
import { Suspense } from "react";
import { getActiveSeasonYear } from "@/lib/api";
import { Bricolage_Grotesque, Hanken_Grotesk } from "next/font/google";
import Link from "next/link";
import NavLinks, { MobileNav } from "@/components/nav-links";
import SeasonBadge from "@/components/season-badge";
import GlobalSearch from "@/components/global-search";
import PitwallAssistantLauncher from "@/components/pitwall-assistant-launcher";
import AppShell from "@/components/app-shell";
import "./globals.css";

/**
 * Public origin, used for `metadataBase` and therefore for every absolute URL
 * in a link preview.
 *
 * The fallback is the service's CANONICAL Cloud Run URL -- the one
 * `gcloud run services describe f1-frontend` reports as `status.url`, verified
 * rather than assumed. Cloud Run answers on a second, project-number form as
 * well (both are allowlisted for CORS), but only one is canonical, and putting
 * the other in a preview card or a sitemap advertises a host that is not the
 * site's own address. Without a `metadataBase` at all Next warns and
 * falls back to localhost, which yields cards pointing at nothing.
 *
 * Set `NEXT_PUBLIC_SITE_URL` when a custom domain exists; this constant should
 * not have to be edited for that.
 */
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ??
  "https://f1-frontend-2w5wydk2ca-el.a.run.app";

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-headline",
  weight: ["600", "700", "800"],
  display: "swap",
});

const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

/**
 * `generateMetadata`, not a static `metadata` object, so the season in the
 * title is the season the app is actually serving.
 *
 * It was hardcoded to 2026 in three places here. Every other surface resolves
 * the year through `getActiveSeasonYear`, so on 1 January the whole site would
 * have rolled over while the browser tab, the meta description and the footer
 * went on advertising the previous season — the most visible possible place
 * for a stale constant.
 */
export async function generateMetadata(): Promise<Metadata> {
  const season = getActiveSeasonYear();
  const title = `APEX | ${season} F1 Season Hub`;
  const description = `APEX — a warm, high-clarity home for the ${season} Formula 1 season: schedule, standings, drivers, teams, circuits and telemetry.`;

  return {
    // Required for the relative OG image path below to resolve, and for any
    // other absolute URL Next needs to build. Without it Next warns and falls
    // back to localhost, which produces preview cards that resolve to nothing.
    metadataBase: new URL(SITE_URL),
    title,
    description,
    applicationName: "APEX",
    openGraph: {
      type: "website",
      siteName: "APEX",
      title,
      description,
      url: "/",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

/**
 * One labelled column of footer links.
 *
 * Every link carries a 40px hit area written as FOUR separate negative
 * offsets rather than a compound `-inset-y-3`. That is not a style preference:
 * the compound form SILENTLY GENERATED NOTHING here -- checked in the browser,
 * no rule matching `inset-y-3` existed in any stylesheet, while `inset-y-1`
 * was present. The classes look right, the element keeps its 16px hit box, and
 * nothing warns. If you reach for a negative compound inset, measure it before
 * believing it.
 */
function FooterGroup({
  heading,
  links,
}: {
  heading: string;
  links: { href: string; label: string; external?: boolean }[];
}) {
  const linkClass =
    "relative font-medium text-xs text-warm-400 hover:text-on-background transition-colors before:absolute before:-top-2.5 before:-bottom-2.5 before:-left-1 before:-right-1 before:content-['']";

  return (
    <div className="flex flex-col gap-3">
      <span className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-600">
        {heading}
      </span>
      {links.map((link) =>
        link.external ? (
          <a
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className={linkClass}
          >
            {link.label}
          </a>
        ) : (
          <Link key={link.href} href={link.href} className={linkClass}>
            {link.label}
          </Link>
        )
      )}
    </div>
  );
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap"
          rel="stylesheet"
        />
      </head>
      <body
        className={`${bricolage.variable} ${hanken.variable} bg-background text-on-background font-[family-name:var(--font-body)] antialiased`}
      >
        {/* Liquid-glass displacement filters referenced by .apex-glass* via url(#liquid) */}
        <svg
          width="0"
          height="0"
          style={{ position: "absolute" }}
          aria-hidden="true"
        >
          <defs>
            <filter id="liquid" x="0%" y="0%" width="100%" height="100%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.009 0.013"
                numOctaves={2}
                seed={12}
                result="n"
              />
              <feGaussianBlur in="n" stdDeviation="1.1" result="nb" />
              <feDisplacementMap
                in="SourceGraphic"
                in2="nb"
                scale={15}
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>
            <filter id="liquidStrong" x="0%" y="0%" width="100%" height="100%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.011 0.015"
                numOctaves={2}
                seed={4}
                result="n"
              />
              <feGaussianBlur in="n" stdDeviation="1.3" result="nb" />
              <feDisplacementMap
                in="SourceGraphic"
                in2="nb"
                scale={22}
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>
          </defs>
        </svg>

        {/* Chrome is assembled here (so the nav's server components still
            render on the server) but *placed* by AppShell, which drops all of
            it on the full-screen /watch routes. */}
        <AppShell
          ambient={
        /* Ambient warmth — fixed behind everything */
        <div
          className="fixed inset-0 z-0 pointer-events-none overflow-hidden"
          aria-hidden="true"
        >
          <div className="absolute -top-[6%] left-[4%] w-[52vw] h-[52vw] rounded-full blur-[10px] bg-[radial-gradient(circle,rgba(255,90,31,0.13),transparent_60%)]" />
          <div className="absolute -bottom-[14%] -right-[4%] w-[48vw] h-[48vw] rounded-full blur-[12px] bg-[radial-gradient(circle,rgba(226,58,14,0.10),transparent_62%)]" />
          <div className="absolute top-[44%] left-[38%] w-[40vw] h-[40vw] rounded-full blur-[14px] bg-[radial-gradient(circle,rgba(255,138,61,0.07),transparent_64%)]" />
        </div>
          }
          nav={
        <nav aria-label="Main" className="sticky top-0 z-50 bg-surface-container-low/55 backdrop-blur-[16px] backdrop-saturate-150 border-b border-white/[0.08] shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_10px_40px_rgba(0,0,0,0.4)]">
          <div className="max-w-[1440px] mx-auto flex items-center justify-between px-6 md:px-10 py-[15px]">
            <div className="flex items-center gap-8 md:gap-12">
              {/* 32px tall as drawn, 40px to a finger — the nav's own vertical
                  padding is what constrains it, and growing the wordmark to
                  suit would enlarge the one element setting the bar's
                  height. */}
              <Link href="/" className="relative flex items-center gap-[11px] before:absolute before:-inset-y-1 before:-inset-x-2 before:content-['']">
                <span className="w-[9px] h-[9px] rounded-full bg-primary-container shadow-[0_0_14px_rgba(255,90,31,0.9)]" />
                <span className="font-[family-name:var(--font-headline)] font-extrabold text-[22px] tracking-[-0.5px]">
                  APEX
                </span>
              </Link>
              {/* `lg`, not `md`, and the difference is two unreachable
                  destinations. Nine links plus the logo, search, launcher and
                  season badge need about 900px; turning them on at 768 made the
                  bar overflow its own container — measured at 768x1024 the page
                  scrollWidth was 880 against a clientWidth of 768, "History"
                  rendered as "Histor" and the season badge was off-screen
                  entirely. At 844x390 the Pitwall launcher was drawn *on top of*
                  a nav link. Every tablet and every landscape phone lands in
                  that 768-900 band. `lg` is also where GlobalSearch already
                  hides itself, so the two now agree. */}
              <div className="hidden lg:flex items-center gap-[30px] font-[family-name:var(--font-body)] font-semibold text-[13px]">
                <NavLinks />
              </div>
            </div>
            <div className="flex items-center gap-4">
              <GlobalSearch />
              <PitwallAssistantLauncher />
              <Suspense fallback={<div className="font-semibold text-xs text-warm-300 w-[85px]" />}>
                <SeasonBadge />
              </Suspense>
            </div>
          </div>
        </nav>
          }
          footer={
        <footer className="relative z-10 border-t border-white/[0.07]">
          <div className="max-w-[1440px] mx-auto px-6 md:px-10 py-9">
            {/* Three groups, and NOT in the main nav.
                The nav bar already carries nine links and overflowed its own
                container between 768 and 900px until the breakpoint was moved
                to `lg` -- measured at 768x1024 the page scrollWidth was 880
                against a clientWidth of 768, "History" rendered as "Histor"
                and the season badge was off-screen. Six more destinations
                would re-break exactly that. These pages are also the kind
                people look for at the bottom rather than the top. */}
            <div className="flex flex-col sm:flex-row sm:flex-wrap gap-8 sm:gap-14 mb-8">
              <FooterGroup
                heading="Project"
                links={[
                  { href: "/about", label: "About" },
                  { href: "/faq", label: "FAQ" },
                  {
                    href: "https://github.com/Nisarg6502/f1-hub",
                    label: "GitHub",
                    external: true,
                  },
                  {
                    href: "https://github.com/Nisarg6502/f1-hub/issues",
                    label: "Report a bug",
                    external: true,
                  },
                ]}
              />
              <FooterGroup
                heading="Data"
                links={[
                  { href: "/data-sources", label: "Data sources" },
                  { href: "/ai-disclosure", label: "AI disclosure" },
                ]}
              />
              <FooterGroup
                heading="Legal"
                links={[
                  { href: "/privacy", label: "Privacy" },
                  { href: "/disclaimer", label: "Disclaimer" },
                  { href: "/attributions", label: "Attributions" },
                ]}
              />
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-6 border-t border-white/[0.05]">
              <div className="flex items-center gap-[10px]">
                <span className="w-2 h-2 rounded-full bg-primary-container" />
                <span className="font-[family-name:var(--font-headline)] font-extrabold text-[15px]">
                  APEX
                </span>
                <span className="font-medium text-xs text-warm-500">
                  · F1 season hub
                </span>
              </div>
              {/* This line already existed and already made the right claim;
                  it just had nowhere to go. It is now the entry point to the
                  page that states it properly. */}
              <Link
                href="/disclaimer"
                className="relative font-medium text-xs text-warm-500 underline hover:text-warm-300 transition-colors before:absolute before:-top-3 before:-bottom-3 before:-left-1 before:-right-1 before:content-['']"
              >
                Unofficial · not affiliated with Formula 1
              </Link>
            </div>
          </div>
        </footer>
          }
          mobileNav={
        /* Matches the nav's new `lg` breakpoint. These two must move together:
           leaving this at `md` would have left 768-1023px with no navigation
           at all once the desktop bar moved up. It is a real `nav` element
           rather than a `div` so a screen reader can find it, and it carries
           its own label since a page now has two navigations. */
        <nav
          aria-label="Sections"
          className="lg:hidden fixed bottom-0 left-0 w-full z-50 bg-surface-container-low/85 backdrop-blur-xl border-t border-white/[0.08] px-3 sm:px-6 py-3 flex justify-between items-center"
        >
          <MobileNav />
        </nav>
          }
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
