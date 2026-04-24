import type { Metadata } from "next";
import { Space_Grotesk, Manrope, Inter } from "next/font/google";
import Link from "next/link";
import NavLinks, { MobileNav } from "@/components/nav-links";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-headline",
  weight: ["300", "400", "500", "600", "700"],
});

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["200", "300", "400", "500", "600", "700", "800"],
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-label",
  weight: ["100", "200", "300", "400", "500", "600", "700", "800", "900"],
});

export const metadata: Metadata = {
  title: "KINETIC VELOCITY | F1 Hub",
  description:
    "The ultimate telemetry and driver insights hub for high-performance motorsports enthusiasts.",
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
        className={`${spaceGrotesk.variable} ${manrope.variable} ${inter.variable} bg-background text-on-background font-[family-name:var(--font-body)] antialiased`}
      >
        {/* Top Navigation Bar */}
        <nav className="fixed top-0 w-full z-50 bg-neutral-950/80 backdrop-blur-xl shadow-[0_0_15px_rgba(0,242,255,0.1)]">
          <div className="flex justify-between items-center w-full px-8 py-4 max-w-[1920px] mx-auto">
            <Link
              href="/"
              className="text-2xl font-black italic tracking-tighter text-cyan-400 skew-x-[-10deg] font-[family-name:var(--font-headline)]"
            >
              KINETIC VELOCITY
            </Link>

            <div className="hidden md:flex items-center gap-8 font-[family-name:var(--font-label)] text-xs uppercase tracking-widest">
              <NavLinks />
            </div>

            <div className="flex items-center gap-4">
              <div className="hidden lg:flex items-center bg-surface-container px-4 py-2 border border-outline-variant/30">
                <span className="material-symbols-outlined text-outline text-sm mr-2">
                  search
                </span>
                <input
                  className="bg-transparent border-none focus:ring-0 focus:outline-none text-[10px] tracking-tighter w-40 font-[family-name:var(--font-label)] uppercase text-on-surface placeholder:text-outline"
                  placeholder="SEARCH TELEMETRY"
                  type="text"
                />
              </div>
              <button className="bg-primary-container text-on-primary px-6 py-2 font-black italic skew-x-[-12deg] text-xs tracking-tighter hover:shadow-[0_0_20px_rgba(0,242,255,0.4)] transition-all active:scale-95 font-[family-name:var(--font-headline)]">
                LIVE STATUS
              </button>
            </div>
          </div>
        </nav>

        {/* Main Content */}
        <main className="pt-24 pb-12 min-h-screen">{children}</main>

        {/* Footer */}
        <footer className="w-full border-t border-neutral-800 bg-neutral-950">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8 px-12 py-16 w-full max-w-[1920px] mx-auto">
            <div className="col-span-1">
              <div className="text-lg font-bold text-neutral-500 font-[family-name:var(--font-headline)] italic uppercase tracking-tighter mb-4">
                KINETIC VELOCITY
              </div>
              <p className="text-[10px] font-[family-name:var(--font-label)] text-neutral-600 tracking-widest uppercase leading-relaxed">
                The ultimate destination for high-speed telemetry and race
                analysis. Fast as light, precise as engineering.
              </p>
            </div>
            <div className="flex flex-col gap-4">
              <h4 className="text-cyan-400 font-[family-name:var(--font-label)] text-xs uppercase tracking-widest font-bold">
                PLATFORM
              </h4>
              <a
                className="text-neutral-600 text-xs uppercase tracking-widest hover:text-cyan-400 transition-colors"
                href="#"
              >
                Privacy Policy
              </a>
              <a
                className="text-neutral-600 text-xs uppercase tracking-widest hover:text-cyan-400 transition-colors"
                href="#"
              >
                Terms of Service
              </a>
            </div>
            <div className="flex flex-col gap-4">
              <h4 className="text-cyan-400 font-[family-name:var(--font-label)] text-xs uppercase tracking-widest font-bold">
                RESOURCES
              </h4>
              <a
                className="text-neutral-600 text-xs uppercase tracking-widest hover:text-cyan-400 transition-colors"
                href="#"
              >
                Press Kit
              </a>
              <a
                className="text-neutral-600 text-xs uppercase tracking-widest hover:text-cyan-400 transition-colors"
                href="#"
              >
                Contact
              </a>
            </div>
            <div className="flex flex-col gap-4">
              <h4 className="text-cyan-400 font-[family-name:var(--font-label)] text-xs uppercase tracking-widest font-bold">
                CONNECT
              </h4>
              <div className="flex gap-4">
                <span className="material-symbols-outlined text-neutral-600 hover:text-cyan-400 cursor-pointer">
                  rss_feed
                </span>
                <span className="material-symbols-outlined text-neutral-600 hover:text-cyan-400 cursor-pointer">
                  share
                </span>
                <span className="material-symbols-outlined text-neutral-600 hover:text-cyan-400 cursor-pointer">
                  monitoring
                </span>
              </div>
              <p className="text-[10px] font-[family-name:var(--font-label)] text-neutral-700 tracking-widest uppercase mt-2">
                © 2025 KINETIC VELOCITY. FAST AS LIGHT.
              </p>
            </div>
          </div>
        </footer>

        {/* Mobile Bottom Nav */}
        <div className="md:hidden fixed bottom-0 left-0 w-full z-50 bg-neutral-950/90 backdrop-blur-xl px-6 py-4 flex justify-between items-center">
          <MobileNav />
        </div>
      </body>
    </html>
  );
}
