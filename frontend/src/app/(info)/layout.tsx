import Link from "next/link";

/**
 * Shared shell for the six standing information pages.
 *
 * A route GROUP rather than a `/legal` segment, so the URLs stay short —
 * `/privacy`, not `/legal/privacy`. These are the ones people type, link and
 * quote, and a shorter path is worth more here than the tidiness of a shared
 * prefix.
 *
 * The layout owns the reading column, the heading rhythm and the reviewed
 * date. Six pages styled independently drift within a release or two; the one
 * that matters most is the reviewed date, because a policy page with no date
 * gives a reader no way to judge whether it still describes the software.
 */

/**
 * Bumped by hand when the FACTS on any of these pages change — not when a
 * typo is fixed.
 *
 * Deliberately a constant rather than a build timestamp. A build stamp would
 * refresh on every unrelated deploy and quietly claim the privacy policy had
 * been re-checked when nothing had been read. That is the failure mode a
 * "last updated" line exists to prevent, so it must move only when a person
 * verifies the content again.
 */
export const LAST_REVIEWED = "2026-08-22";

const SECTIONS = [
  { href: "/about", label: "About" },
  { href: "/data-sources", label: "Data sources" },
  { href: "/ai-disclosure", label: "AI disclosure" },
  { href: "/faq", label: "FAQ" },
  { href: "/privacy", label: "Privacy" },
  { href: "/disclaimer", label: "Disclaimer" },
];

export default function InfoLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative z-10 max-w-[1440px] mx-auto px-6 md:px-10 py-10 md:py-14">
      <div className="max-w-[68ch]">
        <nav
          aria-label="Information pages"
          className="flex flex-wrap gap-x-5 gap-y-2 mb-9"
        >
          {SECTIONS.map((section) => (
            <Link
              key={section.href}
              href={section.href}
              /* 12px text is nowhere near a 40px target, and these wrap onto
                 several rows on a phone. The hit area grows with four separate
                 offsets rather than a compound negative inset: see the footer
                 link in app/layout.tsx for the measured reason a compound
                 negative inset is not trusted in this codebase. */
              className="relative font-semibold text-xs text-warm-400 hover:text-on-background transition-colors before:absolute before:-top-3 before:-bottom-3 before:-left-1.5 before:-right-1.5 before:content-['']"
            >
              {section.label}
            </Link>
          ))}
        </nav>

        <article className="info-prose">{children}</article>

        <p className="font-medium text-[11px] text-warm-500 mt-12 pt-6 border-t border-white/[0.07]">
          Last reviewed {LAST_REVIEWED}. These pages describe the software as it
          actually behaves; if you find one that does not,{" "}
          <a
            href="https://github.com/Nisarg6502/f1-hub/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-warm-300 transition-colors"
          >
            that is a bug worth reporting
          </a>
          .
        </p>
      </div>
    </div>
  );
}
