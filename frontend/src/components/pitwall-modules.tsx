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
        <nav className="flex flex-col gap-2.5">
          {modules.map((module) => {
            const isActive = module.id === active?.id;
            return (
              <button
                key={module.id}
                onClick={() => setActiveId(module.id)}
                aria-current={isActive ? "page" : undefined}
                className={`flex items-center justify-between px-5 py-4 rounded-2xl w-full text-left transition-[background-color,border-color,transform] duration-150 active:scale-[0.98] ${
                  isActive
                    ? "border border-[rgba(255,90,31,0.35)] bg-[rgba(255,90,31,0.1)] text-primary"
                    : "apex-glass-soft hover:border-[rgba(255,138,61,0.5)]"
                }`}
              >
                <span className="font-bold text-[15px]">{module.label}</span>
                <span
                  className={`material-symbols-outlined text-lg transition-opacity ${
                    isActive ? "opacity-100" : "opacity-0"
                  }`}
                >
                  chevron_right
                </span>
              </button>
            );
          })}

          {comingSoon.map((label) => (
            <button
              key={label}
              disabled
              className="flex items-center justify-between px-5 py-4 rounded-2xl apex-glass-soft opacity-50 cursor-not-allowed w-full text-left"
            >
              <span className="font-bold text-[15px]">{label}</span>
              <span className="text-[10px] uppercase tracking-[0.1em] text-warm-500 font-bold rounded-md bg-[rgba(245,235,222,0.06)] px-2 py-1">
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
