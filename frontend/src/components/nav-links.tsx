"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/", label: "Home" },
  { href: "/schedule", label: "Schedule" },
  { href: "/standings", label: "Standings" },
  { href: "/drivers", label: "Drivers" },
  { href: "/teams", label: "Teams" },
  { href: "/circuits", label: "Circuits" },
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
            className={`transition-colors duration-200 ${
              isActive
                ? "text-on-background"
                : "text-warm-400 hover:text-on-background"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </>
  );
}

export function MobileNav() {
  const pathname = usePathname();

  const mobileItems = [
    { href: "/", icon: "home", label: "Home" },
    { href: "/schedule", icon: "event", label: "Schedule" },
    { href: "/standings", icon: "leaderboard", label: "Standings" },
    { href: "/drivers", icon: "groups", label: "Drivers" },
    { href: "/circuits", icon: "route", label: "Circuits" },
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
            className={`flex flex-col items-center gap-1 transition-colors ${
              isActive ? "text-[#FFAE6A]" : "text-warm-500"
            }`}
          >
            <span className="material-symbols-outlined text-[22px]">
              {item.icon}
            </span>
            <span className="text-[9px] font-semibold tracking-[0.12em] uppercase">
              {item.label}
            </span>
          </Link>
        );
      })}
    </>
  );
}
