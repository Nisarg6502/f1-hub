import { Bell, EyeOff, LayoutGrid, MessagesSquare, type LucideIcon } from "lucide-react";

/**
 * What an account adds, on the "Create account" tab.
 *
 * The tab used to say "an account adds chat history, favourites and
 * preferences that follow you across devices" in one run-on sentence, which
 * names a category and none of the things in it. This lists the four that are
 * real today, each in the words of what the visitor gets. Every row is shipped
 * and works: race reminders (`reminders-section.tsx`), spoiler-free mode and
 * the home layout syncing to the account, favourites, and saved chats. If a row
 * here stops being true, remove it rather than leave it promised.
 *
 * Lucide icons, not Material Symbols: that font is a subset
 * (`lib/material-symbols.ts`) and a name outside it renders as text.
 */
const BENEFITS: ReadonlyArray<{ icon: LucideIcon; title: string; line: string }> = [
  {
    icon: Bell,
    title: "Race reminders",
    line: "An email before qualifying and the race, in your time zone.",
  },
  {
    icon: EyeOff,
    title: "Spoiler-free on every device",
    line: "Hide results until you've watched, on your phone and laptop alike.",
  },
  {
    icon: LayoutGrid,
    title: "Your home, your favourites",
    line: "Your layout, driver and team follow you everywhere.",
  },
  {
    icon: MessagesSquare,
    title: "Saved conversations",
    line: "Come back to your Pitwall Assistant chats later.",
  },
];

export default function AccountBenefits() {
  return (
    <div className="mb-6">
      <ul className="apex-glass-soft rounded-2xl divide-y divide-white/[0.06]">
        {BENEFITS.map(({ icon: Icon, title, line }) => (
          <li key={title} className="flex items-start gap-3.5 px-4 py-3.5">
            <span className="mt-0.5 flex-none text-primary" aria-hidden="true">
              <Icon size={18} />
            </span>
            <span className="min-w-0">
              <span className="block font-semibold text-sm text-on-background">{title}</span>
              <span className="block text-[13px] leading-snug text-warm-300 mt-0.5">{line}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-warm-400 mt-3">
        Free, no password, and everything else works without an account.
      </p>
    </div>
  );
}
