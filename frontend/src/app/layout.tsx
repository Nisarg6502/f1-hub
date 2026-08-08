import type { Metadata } from "next";
import { Suspense } from "react";
import { Bricolage_Grotesque, Hanken_Grotesk } from "next/font/google";
import Link from "next/link";
import NavLinks, { MobileNav } from "@/components/nav-links";
import SeasonBadge from "@/components/season-badge";
import GlobalSearch from "@/components/global-search";
import PitwallAssistantLauncher from "@/components/pitwall-assistant-launcher";
import AppShell from "@/components/app-shell";
import "./globals.css";

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

export const metadata: Metadata = {
  title: "APEX | 2026 F1 Season Hub",
  description:
    "APEX — a warm, high-clarity home for the 2026 Formula 1 season: schedule, standings, drivers, teams and circuits.",
};

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
        <nav className="sticky top-0 z-50 bg-[rgba(18,15,12,0.55)] backdrop-blur-[16px] backdrop-saturate-150 border-b border-white/[0.08] shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_10px_40px_rgba(0,0,0,0.4)]">
          <div className="max-w-[1440px] mx-auto flex items-center justify-between px-6 md:px-10 py-[15px]">
            <div className="flex items-center gap-8 md:gap-12">
              <Link href="/" className="flex items-center gap-[11px]">
                <span className="w-[9px] h-[9px] rounded-full bg-[#FF5A1F] shadow-[0_0_14px_rgba(255,90,31,0.9)]" />
                <span className="font-[family-name:var(--font-headline)] font-extrabold text-[21px] tracking-[-0.5px]">
                  APEX
                </span>
              </Link>
              <div className="hidden md:flex items-center gap-[30px] font-[family-name:var(--font-body)] font-semibold text-[13px]">
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
          <div className="max-w-[1440px] mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 px-6 md:px-10 py-7">
            <div className="flex items-center gap-[10px]">
              <span className="w-2 h-2 rounded-full bg-[#FF5A1F]" />
              <span className="font-[family-name:var(--font-headline)] font-extrabold text-[15px]">
                APEX
              </span>
              <span className="font-medium text-xs text-warm-500">
                · 2026 F1 season hub
              </span>
            </div>
            <div className="flex items-center gap-4">
              <a
                href="https://github.com/Nisarg6502/f1-hub"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-xs text-warm-500 underline hover:text-warm-300 transition-colors"
              >
                GitHub
              </a>
              <span className="font-medium text-xs text-warm-500">
                Concept prototype · not affiliated with Formula 1
              </span>
            </div>
          </div>
        </footer>
          }
          mobileNav={
        <div className="md:hidden fixed bottom-0 left-0 w-full z-50 bg-[rgba(18,15,12,0.85)] backdrop-blur-xl border-t border-white/[0.08] px-6 py-3 flex justify-between items-center">
          <MobileNav />
        </div>
          }
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
