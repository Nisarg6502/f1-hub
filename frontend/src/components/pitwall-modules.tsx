"use client";

import { useState, type ReactNode } from "react";

interface PitwallModule {
  id: string;
  label: string;
  /** Rendered on the server by the pitwall page and passed through, so
   * switching modules is instant and costs no extra fetch. */
  panel: ReactNode;
}

interface PitwallModulesProps {
  modules: PitwallModule[];
  /** Labels for modules that aren't built yet, shown disabled below the rest. */
  comingSoon?: string[];
  /** Opens a specific module on load — how a `?module=` deep link (e.g. from
   * a race-control citation) lands on the right panel instead of always the
   * first one. Falls back to the first module if the id doesn't match any. */
  initialModuleId?: string;
}

export default function PitwallModules({
  modules,
  comingSoon = [],
  initialModuleId,
}: PitwallModulesProps) {
  const [activeId, setActiveId] = useState(
    modules.some((m) => m.id === initialModuleId) ? initialModuleId : modules[0]?.id
  );
  const active = modules.find((module) => module.id === activeId) ?? modules[0];

  // No `items-start` on this grid: `<main>` must stretch to the row's full
  // height so TireStintsChart's `h-full` -> `flex-grow` -> Recharts
  // `height="100%"` chain has a definite height to resolve against.
  // `min-height` on the chart card alone isn't enough — it paints a tall box
  // but doesn't give percentage-height children (ResponsiveContainer) a
  // definite value, so the chart silently renders at 0 height, no error.
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
      <aside>
        <h3 className="font-bold text-[11px] tracking-[0.18em] uppercase text-warm-500 mb-4">
          Analysis modules
        </h3>
        {/* Below `lg` this is a horizontally-scrolling row of compact chips
            rather than the desktop sidebar's stack of full-width cards. Seven
            stacked 64px-tall cards pushed every chart below the fold on a
            phone or tablet — a scroll-past-the-nav-before-you-see-data
            problem, not an overflow one, which is the "pitwall is cramped on
            mobile" complaint this whole pass exists to fix. The horizontal
            scroll here is the same contained, intentional kind the wide
            tables elsewhere in the app use (see e.g. `sector-battle-panel`'s
            `overflow-x-auto`), not scroll leaking onto the page. */}
        <nav className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 lg:mx-0 lg:px-0 lg:pb-0 lg:flex-col lg:gap-2.5 lg:overflow-visible">
          {modules.map((module) => {
            const isActive = module.id === active?.id;
            return (
              <button
                key={module.id}
                onClick={() => setActiveId(module.id)}
                aria-current={isActive ? "page" : undefined}
                className={`flex items-center justify-between gap-2 shrink-0 lg:shrink lg:w-full whitespace-nowrap text-left px-4 py-2.5 rounded-full lg:px-5 lg:py-4 lg:rounded-2xl transition-[background-color,border-color,transform] duration-150 active:scale-[0.98] ${
                  isActive
                    ? "border border-primary-container/35 bg-primary-container/10 text-primary"
                    : "apex-glass-soft hover:border-flame-bright/50"
                }`}
              >
                <span className="font-bold text-[13px] lg:text-[15px]">{module.label}</span>
                {/* The chevron is wrapped rather than given `hidden` directly:
                    the Material Symbols Google Fonts stylesheet loads AFTER
                    Tailwind's compiled CSS and defines its own `display` for
                    `.material-symbols-outlined` at equal specificity, so it
                    silently wins the cascade over a `hidden`/`lg:inline-block`
                    utility placed on that same class — confirmed by hand, the
                    icon stayed visible below `lg` with `display: block` in
                    computed styles even though `.hidden` was in the class
                    list. Hiding the wrapper instead sidesteps that clash. */}
                <span className="hidden lg:inline-block">
                  <span
                    className={`material-symbols-outlined text-lg transition-opacity ${
                      isActive ? "opacity-100" : "opacity-0"
                    }`}
                  >
                    chevron_right
                  </span>
                </span>
              </button>
            );
          })}

          {comingSoon.map((label) => (
            <button
              key={label}
              disabled
              className="flex items-center justify-between gap-2 shrink-0 lg:shrink lg:w-full whitespace-nowrap text-left px-4 py-2.5 rounded-full lg:px-5 lg:py-4 lg:rounded-2xl apex-glass-soft opacity-50 cursor-not-allowed"
            >
              <span className="font-bold text-[13px] lg:text-[15px]">{label}</span>
              <span className="text-[10px] uppercase tracking-[0.1em] text-warm-500 font-bold rounded-md bg-veil/6 px-2 py-1">
                Soon
              </span>
            </button>
          ))}
        </nav>
      </aside>

      <main>{active?.panel}</main>
    </div>
  );
}
