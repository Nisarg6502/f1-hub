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
            className={`transition-colors duration-300 ${
              isActive
                ? "text-cyan-400 border-b-2 border-cyan-400 pb-1"
                : "text-neutral-400 hover:text-neutral-100"
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
    { href: "/schedule", icon: "schedule", label: "Schedule" },
    { href: "/standings", icon: "leaderboard", label: "Standings" },
    { href: "/teams", icon: "group", label: "Teams" },
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
            className={`flex flex-col items-center ${
              isActive ? "text-cyan-400" : "text-neutral-500"
            }`}
          >
            <span className="material-symbols-outlined">{item.icon}</span>
            <span className="text-[8px] font-[family-name:var(--font-label)] tracking-widest uppercase mt-1">
              {item.label}
            </span>
          </Link>
        );
      })}
    </>
  );
}
