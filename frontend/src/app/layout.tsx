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
import Analytics from "@/components/analytics";
import ConsentBanner from "@/components/consent-banner";
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
  wide = false,
}: {
  heading: string;
  links: { href: string; label: string; external?: boolean }[];
  /** Lay the links out in two sub-columns and span two grid columns.
   *  Only "Explore" needs it: it lists all nine sections, and as a single
   *  stack it made the footer twice as tall as its own content warranted
   *  while the other three columns ended level with its third link. */
  wide?: boolean;
}) {
  const linkClass =
    "relative font-medium text-xs text-warm-400 hover:text-on-background transition-colors before:absolute before:-top-2.5 before:-bottom-2.5 before:-left-1 before:-right-1 before:content-['']";

  return (
    <div className={`flex flex-col gap-3 ${wide ? "col-span-2" : ""}`}>
      <span className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-600">
        {heading}
      </span>
      <div
        className={
          wide
            ? "grid grid-cols-2 gap-x-6 gap-y-3"
            : "flex flex-col gap-3"
        }
      >
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
        {/* `no-page-custom-font` is a Pages Router rule warning about a font
            that would only load on one page via `pages/_document.js` — this
            is App Router, there is no `pages/_document.js`, and this is the
            root layout, so this loads for every page. `next/font` doesn't
            support this font's variable weight/fill axes via the Google
            Fonts CSS API, so a stylesheet link is the correct approach here. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap"
          rel="stylesheet"
        />
      </head>
      <body
        className={`${bricolage.variable} ${hanken.variable} bg-background text-on-background font-[family-name:var(--font-body)] antialiased`}
      >
        <Analytics />
        <ConsentBanner />

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
          <div className="absolute -top-[6%] left-[4%] w-[52vw] h-[52vw] rounded-full blur-[10px] bg-[radial-gradient(circle,rgb(var(--rgb-primary-container)_/_0.13),transparent_60%)]" />
          <div className="absolute -bottom-[14%] -right-[4%] w-[48vw] h-[48vw] rounded-full blur-[12px] bg-[radial-gradient(circle,rgb(var(--rgb-ember)_/_0.10),transparent_62%)]" />
          <div className="absolute top-[44%] left-[38%] w-[40vw] h-[40vw] rounded-full blur-[14px] bg-[radial-gradient(circle,rgb(var(--rgb-flame-bright)_/_0.07),transparent_64%)]" />
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
                <span className="w-[9px] h-[9px] rounded-full bg-primary-container shadow-[0_0_14px_rgb(var(--rgb-primary-container)_/_0.9)]" />
                <span className="font-[family-name:var(--font-headline)] font-extrabold text-[22px] tracking-[-0.5px]">
                  APEX
                </span>
              </Link>
              {/* NavLinks renders its own row container, and has to: the
                  active-tab underline is measured against that row and drawn
                  inside it. It used to be a Motion `layoutId` shared element,
                  which projects in document space and so, in this `sticky`
                  nav, mistook the App Router's scroll-to-top for a vertical
                  move — the underline flew up from the bottom of the screen on
                  every navigation. The `hidden lg:flex` breakpoint moved into
                  NavLinks with the row; see the comment there for why `lg` and
                  not `md`, and note that the mobile bar below must move with
                  it or 768-1023px has no navigation at all. */}
              <NavLinks />
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
          {/* `pb-24` below `lg`, because the mobile tab strip is `fixed
              bottom-0` and the footer is the one region nothing was holding
              clear of it. `AppShell` carries `pb-24 lg:pb-12`, but on the MAIN
              content div, which sits above this element -- so the last ~66px
              of the footer rendered underneath the strip and its final row was
              unreachable. Measured at 390x844 before the fix: the Sitemap link
              ended at y=712 against a tab strip starting at y=682. This was
              true of the old disclaimer row too; it is not new here. */}
          <div className="max-w-[1440px] mx-auto px-6 md:px-10 pt-9 pb-24 lg:pb-9">
            {/* Four groups, and NOT in the main nav.
                The nav bar already carries nine links and overflowed its own
                container between 768 and 900px until the breakpoint was moved
                to `lg` -- measured at 768x1024 the page scrollWidth was 880
                against a clientWidth of 768, "History" rendered as "Histor"
                and the season badge was off-screen. Six more destinations
                would re-break exactly that. These pages are also the kind
                people look for at the bottom rather than the top.

                "Explore" is the fourth group and is doing real work, not
                filling space: `nav-links.tsx` documents that the mobile bar
                reaches only six of the nine sections, so Teams, Live and
                History had no route to them on a phone at all. Now they do.

                On the layout itself: the three groups used to sit in a bare
                `flex-row` with no `justify-*`, which packs to the start. Each
                column is only ~65px wide, so the whole footer's content lived
                in the leftmost quarter -- measured at 1440px, 315px of a
                1350px band, 23%. Nothing anywhere reserved that space for
                anything; it was left over from the reskin, which replaced an
                original four-column grid with a single `justify-between` row
                and then had the groups added back above it. The identity block
                now holds the left edge and the columns are pushed to the
                right, so the band is spanned rather than hugged. */}
            <div className="flex flex-col gap-10 lg:flex-row lg:items-start lg:justify-between mb-8">
              <div className="flex flex-col gap-3 lg:max-w-[290px]">
                <div className="flex items-center gap-[10px]">
                  <span className="w-2 h-2 rounded-full bg-primary-container" />
                  <span className="font-[family-name:var(--font-headline)] font-extrabold text-[15px]">
                    APEX
                  </span>
                </div>
                <p className="font-medium text-xs leading-relaxed text-warm-500">
                  A season hub for Formula 1 — every round, every session,
                  every driver, with the timing and telemetry behind them.
                </p>
                {/* This line already existed and already made the right claim;
                    it just had nowhere to go. It is now the entry point to the
                    page that states it properly. */}
                <Link
                  href="/disclaimer"
                  className="relative self-start font-medium text-xs text-warm-500 underline hover:text-warm-300 transition-colors before:absolute before:-top-3 before:-bottom-3 before:-left-1 before:-right-1 before:content-['']"
                >
                  Unofficial · not affiliated with Formula 1
                </Link>
              </div>

              {/* `flex-1` with a cap, not natural width: left to size themselves
                  these five columns come to ~550px and, pushed right by
                  `justify-between`, simply move the dead space from the right
                  of the footer into the middle of it. Letting the grid claim
                  the remaining width spreads the columns instead, so the
                  headings sit on an even rhythm across the band. The cap stops
                  that becoming four links marooned at 2560px. */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-x-8 gap-y-8 lg:flex-1 lg:max-w-[820px]">
                <FooterGroup
                  heading="Explore"
                  wide
                  links={[
                    { href: "/schedule", label: "Schedule" },
                    { href: "/standings", label: "Standings" },
                    { href: "/drivers", label: "Drivers" },
                    { href: "/teams", label: "Teams" },
                    { href: "/circuits", label: "Circuits" },
                    { href: "/telemetry", label: "Live" },
                    { href: "/watch", label: "Watch" },
                    { href: "/history", label: "History" },
                  ]}
                />
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
            </div>

            {/* Provenance, and the reason this row exists rather than the
                previous logo-plus-disclaimer bar: the site is obliged to say
                some of it. `/attributions` records that Wikipedia-derived
                content is used under CC BY-SA, and that attribution
                conventionally sits adjacent to the work rather than one click
                away. It also closes the block horizontally, which four
                narrow columns above a hairline do not.

                The season is DERIVED, never written down. Hardcoding 2026
                here is the exact bug that was fixed for the title and
                description -- a stale year in a footer is the kind of thing
                nobody notices until January. */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-6 border-t border-white/[0.05]">
              <p className="font-medium text-[11px] leading-relaxed text-warm-600">
                Season {getActiveSeasonYear()} · Timing and results from{" "}
                <Link
                  href="/data-sources"
                  className="text-warm-500 hover:text-warm-300 underline transition-colors"
                >
                  Jolpica (Ergast), FastF1 and OpenF1
                </Link>
                {" "}· Circuit and history text derived from Wikipedia, used
                under CC BY-SA
              </p>
              <a
                href="/sitemap.xml"
                className="relative font-medium text-[11px] text-warm-600 hover:text-warm-300 transition-colors whitespace-nowrap before:absolute before:-top-3 before:-bottom-3 before:-left-1 before:-right-1 before:content-['']"
              >
                Sitemap
              </a>
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
