"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";

const navItems = [
  { href: "/", label: "Home" },
  { href: "/schedule", label: "Schedule" },
  { href: "/watch", label: "Watch" },
  { href: "/standings", label: "Standings" },
  { href: "/drivers", label: "Drivers" },
  { href: "/teams", label: "Teams" },
  { href: "/circuits", label: "Circuits" },
  { href: "/telemetry", label: "Live" },
  { href: "/history", label: "History" },
];

export default function NavLinks() {
  const pathname = usePathname();

  return (
    <>
      {navItems.map((item) => {
        const isActive =
          item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            // The active link was marked only by colour and an animated
            // underline, both invisible to a screen reader. `/watch`'s season
            // tabs already do this correctly, so the pattern was known here
            // and simply not applied to the main nav.
            aria-current={isActive ? "page" : undefined}
            className={`relative py-1 transition-colors duration-200 ${
              isActive
                ? "text-on-background"
                : "text-warm-400 hover:text-on-background"
            }`}
          >
            {item.label}
            {isActive && (
              <motion.span
                layoutId="nav-underline"
                className="absolute -bottom-0.5 left-0 right-0 h-[2px] rounded-full bg-[#FF5A1F] shadow-[0_0_10px_rgba(255,90,31,0.8)]"
                transition={{ type: "spring", stiffness: 400, damping: 32 }}
              />
            )}
          </Link>
        );
      })}
    </>
  );
}

export function MobileNav() {
  const pathname = usePathname();

  /**
   * Six, and the sixth is Watch on purpose.
   *
   * This bar is the *only* navigation below 1024px, so anything missing from
   * it is unreachable on a phone. Watch mode is the app's second-screen
   * feature — it is designed for a phone propped against a television — and it
   * had no way to be reached from one, which is close to the definition of a
   * feature that does not ship.
   *
   * It stops at six because the labels have to stay legible: at 390px the row
   * has ~342px to divide, and a seventh column puts "Standings" under 48px.
   * Teams, Live and History remain desktop-only here; they are reachable from
   * in-page links, and a bottom bar that has to scroll is worse than a short
   * one. Labels are shortened rather than dropped — an unlabelled icon row is
   * a guessing game.
   */
  const mobileItems = [
    { href: "/", icon: "home", label: "Home" },
    { href: "/schedule", icon: "event", label: "Races" },
    { href: "/watch", icon: "smart_display", label: "Watch" },
    { href: "/standings", icon: "leaderboard", label: "Table" },
    { href: "/drivers", icon: "groups", label: "Drivers" },
    { href: "/circuits", icon: "route", label: "Tracks" },
  ];

  return (
    <>
      {mobileItems.map((item) => {
        const isActive =
          item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={`flex flex-col items-center gap-1 flex-1 min-w-0 transition-colors ${
              isActive ? "text-[#FFAE6A]" : "text-warm-500"
            }`}
          >
            {/* Hidden from assistive technology because the ligature text IS
                the glyph: a Material Symbols span containing "home" is read
                aloud as the word, so this link announced itself as "homeHome"
                and the schedule one as "eventRaces". The launcher button
                already sets this; the nav simply never did. */}
            <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
              {item.icon}
            </span>
            <span className="text-[9px] font-semibold tracking-[0.1em] uppercase">
              {item.label}
            </span>
          </Link>
        );
      })}
    </>
  );
}
